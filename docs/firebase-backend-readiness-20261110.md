# 2026-11-10｜Firebase 後端正式部署差異盤點（B 核准前）

> 本文件是 **唯讀盤點與部署準備**，不是正式部署授權，也不是交易切換核准。
> 每次正式操作前必須重新核對 GitHub `main`、Firebase Console 與真實資料；不得沿用本快照作為當下證明。

## 正式環境與核對方法

- Firebase 專案：`yu-shing-company`；Firestore `(default)`，Standard，`nam5`；Functions `asia-east1`，Node.js 22 設定見 `firebase.json`。
- 2026-11-10 透過已授權的 **ChatGPT 雲端瀏覽器唯讀** 檢查 Firebase Console：Functions 顯示 24 個已部署的 v2 HTTPS 函式；56 個複合索引均為已啟用；Rules 控制台最新發布記錄為 2026-11-09 07:49（台北時間）。
- `settings/{deliveryCutover,dispatchCutover,lifecycleCutover,orderTransferCutover,purchasingCutover,receivingCutover,returnCutover,shipmentCutover}.backendOnly` 已逐筆回讀為 `true`。**這不涵蓋** `inventory`／`inventoryLots`／`inventoryMovements` 等九個庫存 ledger 的全面 client-write 封鎖。
- **禁止 Firebase Hosting**（含 Preview Channel）；唯一核准的前端發布路徑是 GitHub Pages。
- 正式 Rules 全文 SHA、Functions 程式 hash／修訂、實際環境變數與 Secrets 差異尚未全面回讀。這些未確認項目必須在 B 審核前補齊，不能假設與儲存庫相同。

## Functions 差異：原始碼 39 個 export vs 已部署 24 個

以下 24 個名稱於 Console 中確認已部署；**存在不等於執行時開關已開啟，也不等於部署的是最新原始碼**：

`commitV2FormalPurchase`, `receiveOrderTransfer`, `commitServiceOrderBilling`,
`confirmV2ShipmentDelivery`, `reverseV2ShipmentDelivery`, `setV2OrderLifecycle`,
`receiveV2CustomerReturn`, `sendPurchaseOrderEmail`, `withdrawV2CustomerReturnRequest`,
`requestV2CustomerReturn`, `receiveV2Supply`, `commitOrderReservationPreview`,
`prepareV2OrderDispatch`, `dispatchOrderTransfer`, `getServiceCaseStatus`,
`transferSalesCodeOwner`, `shipV2WarehouseItem`, `commitGroupedWarehouseReservation`,
`getServiceOrderProgress`, `commitV2QuickPurchase`, `commitServiceCaseEvent`,
`previewV2CustomerReturn`, `handoffOrderTransfer`, `commitOrderServiceAction`.

目前 15 個**有原始碼匯出、但 Console 24 個清單內沒有**的名稱依功能分類：

| 類別 | 函式 | 正式部署判斷 |
| --- | --- | --- |
| P0 庫存 | `commitV2ManualInventory`, `commitV2InventoryCount` | #523 必要後端候選；需先驗證 Rules、權限與角色、批次／一致性及失敗恢復；正式 gate 預設關閉。 |
| P1 認證 | `completeRequiredPasswordChange` | 管理員強制改密碼的可信任後端候選；需單獨驗證 Auth 更新後 Firestore 失敗／重試語意，且不記錄密碼。 |
| 正式 PO 在途 | `registerV2FormalPurchaseIncoming` | 既有正式前端走 `commitV2FormalPurchase` 的 `register-incoming` 動作；確認其他呼叫者與正式需求後決定是否部署，不能按差額直接新增。 |
| 取消採購轉備庫 | `keepV2CancelledPurchaseStock` | 獨立功能旗標／來源驗證；與 #536 的「供應商取消未到貨」不同，不能互相替代。 |
| 主倉需求／實貨調撥 | `createV2MainTransferRequest`, `cancelV2MainTransferRequest`, `dispatchV2MainTransfer`, `receiveV2MainTransfer`, `resumeV2MainTransferAllocation`, `listV2MainTransferAllocations` | 需依主倉／分倉物流完整流程、相關獨立 gate 與實際角色驗收決定發布順序。 |
| V3 保管（Custody） | `setV3CustodyOrderLifecycle`, `shipV3CustodyItem`, `confirmV3CustodyDelivery`, `receiveV3CustodyReturn` | 目前原始碼限制 `demo-yushin` Emulator；沒有正式專案啟用路徑，不納入直接部署。 |

> 每次 B 清單應精確列出本次新增、更新、保留、退役的函式；不能以 `functions` 整包部署取代差異核對，也不能僅憑原始碼搜尋就刪除正式函式。

## Rules、Indexes 與既有客戶端

1. `firestore.rules` 是儲存庫的既有 Rules 來源；`node tools/build-stock-cutover-rules.cjs --check` 可確認九個庫存 ledger 的後端專用 Rules 候選匹配。產物不會自動部署。
2. 正式 Rules 必須核對目前發布的 **完整內容、版本與 hash**，比對生成的九 ledger 禁止寫入規則，先完成 Emulator 舊瀏覽器拒絕與真實角色讀取權限測試。
3. `firestore.indexes.json` 與正式 56 個已啟用索引的**逐一定義比對**尚未完成；不能因「56/56 已啟用」便宣稱和 main 完全一致。
4. 已觀察的八個交易 `backendOnly=true` 旗標不能替代 stock ledgers 的正式 Rules。快取的舊版 Safari、Chrome、主畫面捷徑必須由**伺服器規則**拒絕，不以新版前端按鈕隱藏作為安全證據。
5. 對 #536 供應商未到貨取消，PR #535 只有正式前端失敗即拒絕；其新可信任後端及舊客戶端拒絕尚未完成。不得以放寬庫存 Rules 恢復操作。

## 歷史資料、開關與上線相依

- #334 的 2026-11-03 一次性舊交易清除已有完成紀錄，不得重做。
- 2026-11-10 Console 再見到 7 筆 `orders` 與多筆 `inventoryMovements`，其中抽樣紀錄於 11/08 建立且包含 `prd:test:test4`。這代表**重設後有新的資料**，不代表之前清除失敗，也不能在未確認文件性質前刪除。
- 完整公司／分倉庫存、期初批次、成本及真實主檔未完成一致性驗證；不得據此宣告零庫存或正式初始化完成。
- 正式 `MANUAL_INVENTORY`／`INVENTORY_COUNT` gate 分別由 `ENABLE_PRODUCTION_MANUAL_INVENTORY_BACKEND` 與 `ENABLE_PRODUCTION_INVENTORY_COUNT_BACKEND` 控制，預設拒絕。**部署函式 B 不等於允許啟用正式交易 D。**
- #523（P0）、#536（P1）、#471（P1）、#485（P1）、#486（P2）在本次 GitHub 盤點仍為 Open；P2 不阻礙 P0／P1。

## 發布前必須完成的 B 審查欄位

- [ ] 重新確認最新 main SHA、Open PR、必要 CI／Review、GitHub Pages 實際發布 SHA。
- [ ] 雲端瀏覽器再次核對正式 Firebase Project、Database、Functions 名稱／修訂／環境旗標及位置；確認沒有正在進行的交易。
- [ ] 補齊正式 Rules **完整 hash 與精確差異**，確認改版後的舊版 SDK 拒絕以及讀取權限不回歸。
- [ ] 對照 `firestore.indexes.json` 定義，列出有無需要部署／移除的索引；確認 Secrets **名稱與相依變更**（不得輸出 Secret 值）。
- [ ] 針對每個必要 Function 逐個確認專案 gate、資料契約、操作憑證、角色、冪等與超時失敗安全性。
- [ ] 必要 CI／Firestore Emulator 高風險回歸通過：成功、重送、並行、無權限、庫存不足、部分失敗、批次、成本及公司／分倉一致性。
- [ ] 設計可停寫的維護時段、部署次序、回讀驗證與安全失敗恢復。不可回復到會重新開放舊 browser writer 的 Rules。
- [ ] 提交**一次完整的 B 部署清單**獨立取得 Luke 核准。核准前不執行 Functions／Rules／Indexes／Secrets 正式變更。
- [ ] C 正式資料清除如確有新的需求，另外列精確範圍及文件數並取得獨立核准；D 新版正式交易入口切換亦獨立核准。

本文件不會執行任何正式部署、清除或交易切換。任何驗收未通過時維持禁止舊瀏覽器寫入、停用受影響交易，繼續修復及測試。
