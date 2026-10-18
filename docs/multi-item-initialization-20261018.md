# 多品項初始化與採購需求 checkpoint

基準 main `4d3e9e1c`（PR #170）。本批補上實際前端 Service 的工作 ID 防護，並將整單雙倉引擎接入既有初始化協調器的 **Emulator 傳輸 adapter** 驗收。不是正式 v2 UI／Callable 啟用，沒有 Firebase 部署或正式資料遷移。

## 實際網站程式修改

`src/services/order-reservation.js` 的 `reserveInventoryForNewOrder` 比對呼叫方持有的初始化 attempt 與最新來源；`reserveSingleOrderItem` 在每次真實 transaction callback／衝突重跑時重新比對。較新的 pending／failed 工作接手後，舊工作不得繼續改庫存、預留、品項或需求。已 completed 的來源保留既有不再預留行為。歷史沒有 attempt 的獨立呼叫保留相容性；這不是以省略欄位取得新權限的 API，原 StockPermissions／Rules 仍執行。

`persistOrderProcurementDemands` 增加可選的初始化 context（actorUid、syncAttemptId）。在讀取當前來源的同一需求 transaction 內核對登入 UID、pending、attempt 與正常生命週期。初始化 adapter 必須傳入；一般取消／恢復呼叫不傳入，仍沿用原本讀最新來源的投影與權威 Core，沒有新增需求數量公式。

以現有建置工具重新產生 app.js；沒有新增前端 transaction writer、資料欄位、Collection、Rules 或正式 Functions export。

## 整單初始化接線及原子性邊界

| 階段 | 執行者 | 提交邊界 |
|---|---|---|
| 開始／失敗／完成 checkpoint | 原 `synchronizeOrderInventory`／`writeOrderInventorySyncState` | 原來源 attempt 條件交易 |
| 多品項庫存預留 | Emulator adapter → 原 `commitOrderTwoWarehouse` | 全部品項一次 transaction、一份憑證 |
| 各品項採購缺口 | 原 `persistOrderProcurementDemands`／原需求 Core | 各需求獨立 transaction，重新讀取來源並核對初始化 context |
| completed | 原協調器 | 所有品項需求成功後才寫入；舊 attempt 不得覆蓋 |

測試 adapter `tests/fixtures/v2-order-initialization.cjs` 對多品項來源只呼叫一次整單預留，完成後才逐項同步需求；不是迴圈呼叫多次單品項預留。單品項保留原來固定 ID 規則。操作 ID 由來源 ID、完整穩定品項集合及當前同步 attempt 推導，網路重送不換 ID。

庫存階段已提交而需求階段中斷時，不會回滾已成立的預留，來源維持 failed／pending，不能假稱全流程原子。原協調器重試會建立新同步 attempt、沿用既有 ledger，重新核對並補齊需求；新增憑證不代表重複占庫或重複庫存異動。全部需求已寫入但完成回覆遺失，仍由原 checkpoint 恢復 completed。

## 驗收

新增 9 項多品項 Emulator 案例：三品項兩產品共用餘額；預留後及每一需求邊界中斷；完成回覆遺失／重送；舊工作在預留前、需求間被取代；五角色與來源所有權；品項間換帳號／停用／撤權；末品項為服務型整單拒絕；五筆同產品優先順序與各自需求。原本 12 項整單庫存原子性／競態／回滾仍保留。

新增 4 項 Node 行為測試，包含 transaction 衝突後重讀 attempt、工作接手、舊版逐項提交間中止、需求 context 與一般取消投影相容；新增 1 項實際 Client SDK＋Rules 測試，確認業務、工程、採購及管理員的舊 attempt 不寫庫存，新 attempt 仍依現有權限正常提交。既有倉管禁止啟動初始化政策不變（內部預留引擎五角色不等於初始化 UI 五角色全部可執行）。

全套 Node／Emulator／Rules／Auth Callable 與八組桌機／手機 Chrome 的結果，以本 PR CI 為準。Chrome smoke 的記憶體傳輸不等於登入瀏覽器連線真實 Emulator；此處初始化 adapter 仍用 Admin SDK，不能宣稱正式 UI、Preview、真實 Auth 初始化或全線 E2E 已完成。

## 尚未完成

1. 多品項後續採購、分批收貨、打單、跨倉出貨／送達、取消／恢復與退貨尚未完整接線；不可解除 v2 正式 UI 閘門。
2. 整單初始化需要正式、受限且真實 Auth 的傳輸契約驗收後，才可評估 Preview 接線；目前沒有把測試 Callable 開放到正式環境。
3. 超過五品項、混合直送／服務、自行訂貨不在整單試點範圍。服務型必須整單拒絕，不得建立虛擬實貨、批號或一般庫存異動。
4. 草稿 PR #131 仍不合併；現有交易已包含多品項預留，不重用其失敗 Rules 方案。
