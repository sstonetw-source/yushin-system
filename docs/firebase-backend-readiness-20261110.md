# 2026-11-10｜Firebase 後端正式部署差異盤點（B 核准前）

> 本文件是 **唯讀盤點與部署準備**，不是正式部署授權，也不是交易切換核准。
> 每次正式操作前必須重新核對 GitHub `main`、Firebase Console 與真實資料；不得沿用本快照作為當下證明。

## 正式環境與核對方法

- Firebase 專案：`yu-shing-company`；Firestore `(default)`，Standard，`nam5`；Functions `asia-east1`，Node.js 22 設定見 `firebase.json`。
- 2026-11-10 透過已授權的 **ChatGPT 雲端瀏覽器唯讀** 檢查 Firebase Console：Functions 顯示 24 個已部署的 v2 HTTPS 函式；56 個複合索引均為已啟用；Rules 控制台最新發布記錄為 2026-11-09 07:49（台北時間）。
- `settings/{deliveryCutover,dispatchCutover,lifecycleCutover,orderTransferCutover,purchasingCutover,receivingCutover,returnCutover,shipmentCutover}.backendOnly` 已逐筆回讀為 `true`。**這不涵蓋** `inventory`／`inventoryLots`／`inventoryMovements` 等九個庫存 ledger 的全面 client-write 封鎖。
- **禁止 Firebase Hosting**（含 Preview Channel）；唯一核准的前端發布路徑是 GitHub Pages。
- **已確認正式 Rules 全文 SHA-256：`d2cda880655c7a51c2e26f81f6845c9c49ca3be32b1d1e5d0327d9f259309d67`，與 `main` 的 `firestore.rules` 完全相同**（2026-11-10 透過 Console 編輯器全選複製後雜湊，無編輯／發布）。正式發布版本顯示 2026-11-09 07:49 台北時間；**目前仍是舊瀏覽器庫存 writer 可依角色規則寫入的版本**，並非九個庫存 ledger 的 `backend-only` 候選。
- 正式 Functions 的部署修訂／完整程式雜湊、環境變數與 **Secrets 名稱和相依性**仍未全面回讀。Firebase Console 可列出 24 個 v2 HTTPS 函式及 `asia-east1`，抽樣 `commitV2FormalPurchase` 顯示 nodejs22、256Mi、2026-11-08 15:08 部署；Google Cloud Functions 詳細入口在本次雲端瀏覽器顯示 `Site Unavailable`。**不得推定其他 23 個修訂或 Secrets 與儲存庫相同。**

## 雲端正式 Rules 實際安全邊界（2026-11-10 唯讀）

- 正式 Rules 目前允許符合角色條件的瀏覽器 SDK 直接 `create/update` `inventory`、`warehouseStocks`、`inventoryLots` 等集合；`inventoryReservations`、`inventoryMovements`、`stockOperations` 亦有客戶端 create 路徑。這不是可放寬的漏洞修復建議，而是 **#523 上線前仍須完成 B 的明確封鎖缺口**。
- `tools/build-stock-cutover-rules.cjs` 的候選會針對九個目標 ledger 封鎖危險 client write（`inventory` 僅保留符合現有權限的規劃欄位修改）。候選由 PR #540 的 Firestore Emulator 角色拒絕測試覆蓋；**尚未部署**。
- 現有 8 個交易 `backendOnly=true` 旗標已重新回讀，不能取代上述九集合的實際 Security Rules。舊版網站／手機捷徑只有正式 Rules 生效後才能視為被伺服器阻擋。
- 先前 #334 清除後，Console 仍顯示 7 個 `orders` 文件；抽樣 `orders` 文件於 2026-11-08 建立且客戶名稱標示 Test。`auditLogs` 亦見 11/08 的驗收品項紀錄。這些資料的真實／測試性質、期初批次及公司對分倉合計尚未全面核定。**無獨立 C 核准，不刪除任何文件。**

## Functions 差異：最新 `main` 41 個 export vs 已部署 24 個

2026-11-10 的 PR #538 又新增兩個 **預設關閉、尚未部署** 的供應商取消後端候選。因此本文件最初查證時是「39 vs 24」，合併 #538 後原始碼為 **41**，正式 Console 唯讀複查仍為 **24**。兩個新 export 不能因 PR 合併就認定可正式使用；下述差異應於 B 部署前再次核對。

以下 24 個名稱於 Console 中確認已部署；**存在不等於執行時開關已開啟，也不等於部署的是最新原始碼**：

`commitV2FormalPurchase`, `receiveOrderTransfer`, `commitServiceOrderBilling`,
`confirmV2ShipmentDelivery`, `reverseV2ShipmentDelivery`, `setV2OrderLifecycle`,
`receiveV2CustomerReturn`, `sendPurchaseOrderEmail`, `withdrawV2CustomerReturnRequest`,
`requestV2CustomerReturn`, `receiveV2Supply`, `commitOrderReservationPreview`,
`prepareV2OrderDispatch`, `dispatchOrderTransfer`, `getServiceCaseStatus`,
`transferSalesCodeOwner`, `shipV2WarehouseItem`, `commitGroupedWarehouseReservation`,
`getServiceOrderProgress`, `commitV2QuickPurchase`, `commitServiceCaseEvent`,
`previewV2CustomerReturn`, `handoffOrderTransfer`, `commitOrderServiceAction`.

目前 17 個**有原始碼匯出、但 Console 24 個清單內沒有**的名稱依功能分類：

| 類別 | 函式 | 正式部署判斷 |
| --- | --- | --- |
| P0 庫存 | `commitV2ManualInventory`, `commitV2InventoryCount` | #523 必要後端候選；需先驗證 Rules、權限與角色、批次／一致性及失敗恢復；正式 gate 預設關閉。 |
| P1 認證 | `completeRequiredPasswordChange` | 管理員強制改密碼的可信任後端候選；需單獨驗證 Auth 更新後 Firestore 失敗／重試語意，且不記錄密碼。 |
| 正式 PO 在途 | `registerV2FormalPurchaseIncoming` | 既有正式前端走 `commitV2FormalPurchase` 的 `register-incoming` 動作；確認其他呼叫者與正式需求後決定是否部署，不能按差額直接新增。 |
| 取消採購轉備庫 | `keepV2CancelledPurchaseStock` | 獨立功能旗標／來源驗證；與 #536 的「供應商取消未到貨」不同，不能互相替代。 |
| P1 供應商取消 | `cancelV2OutstandingSupply`, `stopV2PurchaseOrderOutstanding` | PR #538 已提供單供應、整 PO 原子取消後端與 Emulator 證據；兩者預設由 `ENABLE_PRODUCTION_SUPPLY_CANCELLATION_BACKEND` 關閉。正式 B 部署、D 前端切換、舊版 Rules 拒絕及角色 UAT 均未完成；#536 應保持 Open。 |
| 主倉需求／實貨調撥 | `createV2MainTransferRequest`, `cancelV2MainTransferRequest`, `dispatchV2MainTransfer`, `receiveV2MainTransfer`, `resumeV2MainTransferAllocation`, `listV2MainTransferAllocations` | 需依主倉／分倉物流完整流程、相關獨立 gate 與實際角色驗收決定發布順序。 |
| V3 保管（Custody） | `setV3CustodyOrderLifecycle`, `shipV3CustodyItem`, `confirmV3CustodyDelivery`, `receiveV3CustodyReturn` | 目前原始碼限制 `demo-yushin` Emulator；沒有正式專案啟用路徑，不納入直接部署。 |

> 每次 B 清單應精確列出本次新增、更新、保留、退役的函式；不能以 `functions` 整包部署取代差異核對，也不能僅憑原始碼搜尋就刪除正式函式。

## Rules、Indexes 與既有客戶端

1. `firestore.rules` 是儲存庫的既有 Rules 來源；`node tools/build-stock-cutover-rules.cjs --check` 可確認九個庫存 ledger 的後端專用 Rules 候選匹配。產物不會自動部署。
2. 正式 Rules 必須核對目前發布的 **完整內容、版本與 hash**，比對生成的九 ledger 禁止寫入規則，先完成 Emulator 舊瀏覽器拒絕與真實角色讀取權限測試。
3. 2026-11-10 已透過 Console UI 逐筆核對正式 56 個啟用複合索引與 `main` 的 55 個定義：**55 個同集合、欄位順序、排序方向／陣列模式相符，正式多出 1 個**：`orders` 的 `salesCode ASCENDING, searchTokens ASCENDING`，索引 ID `CICAgNi4o4sK`（不同於版控既有 `searchTokens CONTAINS` 索引）。暫時保留，未確認歷史查詢依賴前不得刪除；若 B 方案需要處理，另列影響與回復。沒有證據顯示需要新增索引。
4. 已觀察的八個交易 `backendOnly=true` 旗標不能替代 stock ledgers 的正式 Rules。快取的舊版 Safari、Chrome、主畫面捷徑必須由**伺服器規則**拒絕，不以新版前端按鈕隱藏作為安全證據。
5. 對 #536 供應商未到貨取消，PR #535 將正式前端失敗即拒絕；PR #538 已新增預設關閉的後端候選及原子交易驗證，**尚未正式部署與切換**，舊客戶端的伺服器端拒絕也尚待 B Rules 驗證。不得以放寬庫存 Rules 恢復操作。

## 歷史資料、開關與上線相依

- #334 的 2026-11-03 一次性舊交易清除已有完成紀錄，不得重做。
- 2026-11-10 Console 再見到 7 筆 `orders` 與多筆 `inventoryMovements`，其中抽樣紀錄於 11/08 建立且包含 `prd:test:test4`。這代表**重設後有新的資料**，不代表之前清除失敗，也不能在未確認文件性質前刪除。
- 完整公司／分倉庫存、期初批次、成本及真實主檔未完成一致性驗證；不得據此宣告零庫存或正式初始化完成。
- 正式 `MANUAL_INVENTORY`／`INVENTORY_COUNT` gate 分別由 `ENABLE_PRODUCTION_MANUAL_INVENTORY_BACKEND` 與 `ENABLE_PRODUCTION_INVENTORY_COUNT_BACKEND` 控制，預設拒絕。**部署函式 B 不等於允許啟用正式交易 D。**
- #523（P0）、#536（P1）、#471（P1）、#485（P1）、#486（P2）在本次 GitHub 盤點仍為 Open；P2 不阻礙 P0／P1。

## 發布前必須完成的 B 審查欄位

- [ ] 重新確認最新 main SHA、Open PR、必要 CI／Review、GitHub Pages 實際發布 SHA。
- [ ] 雲端瀏覽器再次核對正式 Firebase Project、Database、Functions 名稱／修訂／環境旗標及位置；確認沒有正在進行的交易。
- [x] 正式 Rules 全文 SHA-256 與 `main` 對照完成；**正式仍允許瀏覽器庫存寫入**。九 ledger backend-only 候選已在 #540 Emulator 覆蓋角色寫入拒絕；**B 部署後的正式舊版 SDK 拒絕、讀取權限及角色驗收仍待完成**。
- [x] 完成 56/55 複合索引逐筆比對；唯一額外索引 `orders(salesCode ASC, searchTokens ASC)` 暫保留，無新增索引需求。
- [ ] 完成正式 Functions 修訂、部署環境及 Secrets **名稱／相依性**核對（不得輸出 Secret 值）；Google Cloud 詳細入口目前不可用。
- [ ] 針對每個必要 Function 逐個確認專案 gate、資料契約、操作憑證、角色、冪等與超時失敗安全性。
- [ ] 必要 CI／Firestore Emulator 高風險回歸通過：成功、重送、並行、無權限、庫存不足、部分失敗、批次、成本及公司／分倉一致性。
- [ ] 設計可停寫的維護時段、部署次序、回讀驗證與安全失敗恢復。不可回復到會重新開放舊 browser writer 的 Rules。
- [ ] 提交**一次完整的 B 部署清單**獨立取得 Luke 核准。核准前不執行 Functions／Rules／Indexes／Secrets 正式變更。
- [ ] C 正式資料清除如確有新的需求，另外列精確範圍及文件數並取得獨立核准；D 新版正式交易入口切換亦獨立核准。

本文件不會執行任何正式部署、清除或交易切換。任何驗收未通過時維持禁止舊瀏覽器寫入、停用受影響交易，繼續修復及測試。
