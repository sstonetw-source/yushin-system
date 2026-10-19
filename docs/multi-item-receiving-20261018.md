# 多品項雙倉分批收貨

基準 main `3cac49ae`（PR #171）。沿用 `src/services/receiving.js` 的唯一 `receiveSupplyOrderRecord`，擴充其原 Emulator-only v2 來源驗證，不建立第二個收貨 writer 或數量 Core。正式瀏覽器的環境閘門、Rules、Callable export 與部署均不變。

## 接線與範圍

| 操作／階段 | 現有入口與責任 | 本批驗收 |
|---|---|---|
| 建立整單、預留、需求 | 原初始化協調器 → 整單預留 Service → 原需求 Core | 使用上一批 Emulator transport 初始化真實多品項來源 |
| 正式採購單 | 原 `commitFormalPurchaseOrder` | 同張 PO 對同張訂單多品項建立各自供應及需求承諾 |
| 在途登記 | 原 `registerPurchaseIncoming` | 每供應原 checkpoint 重試；不宣稱所有供應的在途登記一次原子 |
| 收貨頁確認 | 原 receiving-workspace → `receiveSupplyOrderRecord` | UI 入口不改；v2 的實際 Service 只在 demo Emulator 執行 |
| 來源預留／實貨 | 原 Receiving／Supply／Reservation Core | 在指定收貨倉增實貨與來源預留，不更動另一倉、不搶占兄弟品項 |
| 打單／出貨／送達 | 原獨立事件 | 本批不啟用多品項履約；收貨不產生出貨或送達 |

多品項 v2 收貨僅接受 2–5 筆穩定唯一實體倉商品、完整 v2 ledger、相同兩個原候選實體倉、已 completed 初始化且尚未打單／出貨／送達／退貨／調撥的正常訂單。單品項原本支援的收貨、CLOSE 退貨後繼續收貨、取消 KEEP_STOCK 等行為維持不變。多品項取消／恢復及任何履約後收貨尚未納入，不可刪掉限制後當成已驗收。

服務型／停用產品、直送混單、重複品項 ID、缺失／舊版／錯所有人的預留、來源供應投影不一致，一律整次收貨拒絕。不默默略過，也不建立服務型虛擬實貨、批號或庫存異動。

## 數量及一致性

每個品項仍由原 `projectShipmentReturns` 得到剩餘需求，原 `reservationStockDeltas({}, ledger)` 得到公司／各倉的預留投影；同產品全部品項的原預留合計，必須同時被交易讀取的公司與各倉 reserved 覆蓋。不能只檢查「當前品項自己小於總帳」，讓兩筆 ledger 重複宣稱同一份持有量。

到貨分配仍使用原 `applyReceiptToOrderItem`、`planReservationReceipt`、`Supply.applyReceipt` 及需求 `applyReceipt`。指定品項以外的原始 v2 items 原樣保留，不透過舊版 normalized items 重寫商業欄位或兄弟品項投影。

每次確認仍是一個供應、固定 operationId 的原收貨 transaction，原子更新實貨、分倉、來源品項與 ledger、供應／需求到貨進度、原批號／成本、收貨憑證與庫存異動。多天／多次／多品項收貨是獨立事件，不宣稱整張 PO 的多次收貨全成全敗。不同品項或產品的同時收貨均重讀同一來源訂單，讓 Firestore 衝突重跑後合併各自進度。

既有 receipt schema、reservationLocationSchemaVersion=2、actor UID／role 綁定與固定 receiptId 重送不變；回覆遺失時用原 ID 查回，不能再入庫一次。無新 Collection、資料遷移或正式權限修改。

## 驗收

`tests/emulator-single-item-location.cjs` 新增 11 項實際 Firestore transaction 測試，沿用原購買／收貨 harness 與真實 Service：

- 三品項兩產品、多個不同日期分批收貨，同倉／跨倉與兄弟資料保留；五筆同產品同 PO。
- 五角色（三個收貨角色允許、業務／工程拒絕）、目前 profile 停用、重送換 actor 拒絕。
- 相同 receipt ID 競態、不同 ID 超量競態、同產品不同品項及不同產品的並行收貨。
- 合計預留帳不足、末品項服務／直送／舊 ledger／來源損壞／已有履約時零寫入。
- 真實末端 create 碰撞（必須回報 ALREADY_EXISTS）整筆回滾；提交成功但回覆遺失仍以原 ID 恢復。
- 沒有瀏覽器 process 或 Emulator 環境變數時拒絕，沒有開放正式入口。

原單品項及其他既有測試仍完整回歸。Node、Firestore／Auth／Functions Emulator、Rules 與八組 1280／390 px Chrome 結果，以本 PR CI 為準；Chrome 使用記憶體傳輸，新增多品項鏈路使用 Admin SDK adapter，均不等同真實登入瀏覽器／Preview 的全線 E2E。

## 待完成

1. 多品項無退貨的履約後收貨已接入原 Service，見下方 2026-10-19 增補；新增真實 Emulator 案例尚待本批 CI 驗收。退貨後收貨與取消 KEEP_STOCK 仍未整合。
2. 多品項取消剩餘、恢復、退貨及取消後 KEEP_STOCK 收貨；混合服務／直送、超過五品項等獨立契約。
3. 真實 Auth 初始化／收貨傳輸與 Preview UI 接線，以及完整桌機／手機登入 E2E；v2 正式閘門在此之前保持關閉。
4. PR #131 仍為草稿失敗分析，不併入既有交易機制。


## 2026-10-19 增補：部分履約後再收貨（基準 main 69655cd0／PR #176）

已實作、待本批 CI：移除原多品項「任何打單／出貨即拒絕」的階段限制，以原 `projectOrderShipmentReturns` 先驗證全部 items／出貨／送達事件，再查核每一個原不可變出貨 movement 的扣帳與批次分配。只有整單驗證成功後才將選定 item 的事件傳給原 `Receiving.applyReceiptToOrderItem`／Workflow／Reservation Core。尚未送達的實體出貨不得重新預留；整單 deliveredQty／isDelivered 用整單權威投影核對，不能誤用選定品項合計。

所有兄弟來源、產品主檔、原 v2 ledger、公司／分倉同產品合計持有量與供應／需求／採購單查核保留。已出完的兄弟 ledger 合法為 fulfilled；新收貨不得改寫其品項、出貨、送達或更正歷史。收貨仍只更新原選定供應、庫存、批次、成本、receipt、ledger、需求及品項收貨進度，不更新送達事件。原 fixed receipt ID／actor／role、回覆遺失、交易競態與原子提交契約不變。

新增九項真實 Emulator 案例：已打單／待送達／部分及全部確認後收貨、三品項兩產品完整12件物流閉環、同產品五列與 fulfilled sibling、實際送達撤銷後收貨、收貨與送達／另一品項出貨同時提交、另一產品 sibling 憑證損壞／隱藏退貨／錯事件及來源狀態、五角色與停用／回覆遺失、獨立已存在文件的 ALREADY_EXISTS 末端回滾、同 ID／超額競爭。全部沿原整單初始化、正式 PO、在途、收貨、打單、出貨、確認及撤銷 Services；僅原始庫存／批次及顧客寄送資料為合成 fixture。

讀寫效能：整單歷史出貨上限40，首次每份增加一個 movement 文件讀取，沒有新查詢（空退貨仍查原有 sourceId＋action query）、Collection、持久欄位、Index、Rules 或 Listener。原多品項 ledger／master 查核讀取保留。重送維持既有 receipt 快速回查，不重複入庫。

範圍仍限 demo-yushin Emulator、2–5個正常實體倉品項、completed初始化、兩個原候選倉且整單無退貨／調撥。多品項退貨後收貨、取消／恢復、KEEP_STOCK、服務／直送混單仍拒絕；單品項既有 CLOSE／取消收貨契約維持。正式 UI／Callable／環境閘門未開啟，沒有 Firebase 部署或正式資料遷移。新增驗收使用 Admin SDK adapter，Chrome 是既有記憶體傳輸；真實 Auth Browser／Preview全線E2E尚未驗收。本地 Node1557/1557通過，完整新增交易／Rules／Auth／Chrome以本批CI為準。
