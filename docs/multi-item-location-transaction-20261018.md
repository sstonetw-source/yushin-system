# 整單多品項雙倉預留契約

基準 main `5a65fe6e`。本批是既有內部雙倉 Service 的擴充，僅供 `demo-yushin` Firestore Emulator；不是正式 UI／Preview 啟用，也不代表多品項後續履約已完成。

## 入口與責任

`functions/single-item-location-service.js` 新增 `commitOrderTwoWarehouse`，與原 `commitSingleItemTwoWarehouse`、唯讀 `planSingleItemTwoWarehouse` 共用同一個私有 `runLocationReservation`。每一品項的數量仍由原 `Reservation Core.planLocationReservation` 決定，未建立第二套庫存或預留公式。

新入口一次呼叫一個真正的 Firestore Transaction。先讀當前 users profile、來源訂單、原操作憑證及所有產品／公司／分倉／預留，再驗證所有品項；全部成功後才排入寫入。沒有迴圈呼叫多次獨立 transaction，也沒有部分成功的子憑證。

## 請求與上限

| 欄位 | 契約 |
|---|---|
| orderId | 真實來源訂單 |
| itemIds | 全部來源品項的穩定 ID，1–5 筆、不得重複／遺漏；不是任意挑選子集 |
| warehouseIds | 兩個不同的候選實體倉；須涵蓋各品項的來源指定倉 |
| attemptId | 固定的 12–96 字元操作 ID，重送不換 ID |
| syncAttemptId | 來源訂單目前 pending 初始化工作 ID |

品項 ID 與倉庫 ID 排序後產生 canonical intent hash，呼叫者不能指定數量、餘額、角色或分配結果。實際優先順序取自交易內讀取的 orders.items，調換 payload 順序不會搶先分貨。

只接受全部為實體倉商品、正整數且 qty／orderedQty 一致、沒有採購／收貨／打單／交付／退貨／調撥進度的初始化訂單。SERVICE、DIRECT_SHIP、超過五品項或混合流程整單拒絕，不會偷偷排除其品項。既有正量 v1 ledger 不在本入口遷移；既有 v2 ledger 須有完整來源／所有權且預留＋缺口等於目前需求。

## 同品項與多產品

在交易 callback 內依 productKey 保存公司帳，依實際文件路徑保存分倉帳。各文件只讀一次；後一來源品項看到的是前一品項配置後的交易內提案餘額。這不是跨交易快取，也不是另一份持久 ledger。

所有既有 ledger 的公司及分倉正量，先沿用 `reservationStockDeltas({}, previous)` 取得權威投影，再核對整單合計不超過交易開始時的公司／分倉原預留。不能只驗證每筆各自小於總帳，讓兩筆 ledger 重複宣稱同一份原預留。

公司與各倉的最終 reserved 各寫一次；每品項維持原 `inventoryReservations/{orderId}__{itemId}` v2 位置模型；orders.items 全部投影一次更新。實貨 onHand、採購 incoming、調撥途中量及批次不變，沒有服務型虛擬庫存或價格／成本資料。

## 操作憑證與回滾

| 文件 | 本批用途 |
|---|---|
| reservationOperationReceipts/order-v2-{attemptId} | 一份整單憑證，action=order_location_reservation；itemIds、actorUid、actorRole、syncAttemptId、intentHash、items 結果 |
| inventoryMovements/order-v2-{attemptId}-{來源品項 index}-{編碼倉庫 ID} | 各品項各倉實際預留差額，連回同一整單憑證 |
| 原單品項 single-v2-* 憑證／movement | 格式及重試契約不變 |

每次包含重送都重讀當前 profile 與訂單所有權。沿用原內部預留的五角色政策；sales／engineer 僅本人來源。相同 ID 必須符合原 actor、role、來源、品項集合與 hash；已提交時只回原結果，不再次配置。改角色、停用、改負責人或換意圖不能挪用原憑證。沒有新增正式角色權限或 Callable。

後一品項驗證失敗會在排入任何寫入前拒絕。末端 create 碰撞則由 Firestore 原子回滾，先前所有產品、公司／分倉、ledger、訂單投影與憑證一起不變。相同／不同操作及不同訂單競爭共用庫存都須由真實 transaction 重跑並重新配置。

## 已實作與驗收限制

新增 Node 請求契約與環境閘門測試，以及 `tests/emulator-order-location.cjs` 的多產品、五筆同產品、來源排序、公司上限、採購／調撥途中排除、五角色／所有權／停用、重送與競態、末品項失敗、末端 create 回滾、原預留合計及讀寫次數測試。五筆同產品的正常新初始化實測 14 個直接文件讀取，公司／分倉／訂單各寫一次。

CI 同時執行原單品項初始化、多倉出貨／送達／取消／退貨、真實 Auth Callable、Rules 及八組桌機／手機 Chrome 回歸。結果以本 PR 的實際 CI 為準。

本操作成功後 orders.inventoryReservationStatus 仍為 pending，不可因此進採購／打單／出貨。後續批次已透過 Emulator 傳輸 adapter 接回原 `synchronizeOrderInventory` 與逐品項需求 checkpoint，見 [初始化接線與驗收界線](multi-item-initialization-20261018.md)；正式 UI／Auth 初始化尚未啟用。不能把庫存階段原子性誤稱為建立訂單、來源文件、採購需求及整條商業流程全成全敗。多品項打單／出貨／送達／取消／恢復／退貨仍須逐個接入共用契約並驗收，再評估 Preview／正式介面。
