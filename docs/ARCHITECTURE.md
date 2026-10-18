# ARCHITECTURE — 又鑫系統程式碼責任地圖

版本：2026-10-16｜以 PR #92 為重整起點，持續依已實作的 Service 邊界更新。**不代表交易核心或資料模型已完成全面驗收。**

## 目標與現況






### 指定收貨倉的共同預留分配（2026-10-17）

已實作：`reservation-core.planReservationReceipt` 共用於正常來源訂單收貨，以及已入庫自由庫存的缺貨再分配。收貨需求仍由 `Receiving.applyReceiptToOrderItem`／Workflow 決定；自由庫存仍沿用採購需求投影，已下訂在途不重複占貨。新契約僅計算實際收貨倉的公司／分倉實貨與預留差額，沿用原始帳驗證及 `reservationStockDeltas`，不選擇或搬動其他倉。

來源收貨模式只增加本次真實入庫量；再分配模式不新增實貨，受公司、該倉可用量及原 receipt／transfer checkpoint 限制。無效原始庫存／自由調撥途中量或帳目不足，在更新訂單、批次、需求及 checkpoint 前拒絕。合法單倉小數的操作數量與浮點庫存差額分開回傳，避免把浮點差誤列成額外分配量。取消來源 KEEP_STOCK 及獨立備庫入庫保留原流程。

純 Core 已驗證 v2 locations 在實際收貨倉增加預留並保留其他位置；StockPermissions／Rules 的多倉欄位阻擋完整保留。**多倉資料庫交易仍未啟用**，不能將此純計算或單倉 Emulator 當成完整多倉驗收。無新增查詢、讀寫、集合、Rules、索引、Listener、正式資料遷移或部署；其餘多倉取消／調撥／保管與 Preview 全流程仍待接線。

### 撤銷與退貨的共同庫存／預留投影（2026-10-17）

已實作：`reservation-core.planReservationReturn` 為送貨撤銷、客戶退貨及退貨縮量的共同數量契約。正常訂單撤銷送貨會還原實貨與本單預留；補送退貨同步增加／完整扣回預留；CLOSE 結案退貨只增加／扣回自由實貨；已取消訂單不重建預留，既有殘留須完整釋放。差額沿用 `reservationStockDeltas`，原始帳目沿用 `validateReservationBalance`，產品／倉位檢查與正向出貨共用。

公司、分倉或預留帳不足、缺公司帳、無效原始數量、明確品項投影不符時，先拒絕，再進行原批次的讀取與還原；不使用歸零掩蓋差額。縮減結案退貨後仍須足夠覆蓋其他訂單預留及自由調撥途中量。Service 不再自行解讀上述數量，沿用原事件去重、批次及角色交易；Core 純提案不是獨立重試憑證。

本契約只處理指定單倉，不得用單倉帳釋放其他位置的預留；多倉寫入阻擋維持，完整多倉還原與跨倉退貨尚未完成。直送獨立入庫、待檢品質及 Preview 全流程仍需後續驗收。無新增讀寫、Query、Listener、Collection、Rules、索引、正式資料遷移或 Firebase 部署。

### 原出貨批次的共同還原檢查（2026-10-17）

已實作：`inventory-core.planLotRestoration` 共用於出貨撤銷、客戶退貨與退貨縮量。Service 先按原批次 ID 去重讀取，再由 Core 核對全部批次的產品、倉庫及原始餘量；同一批次的多筆分配先合計後只寫一次。缺批次、錯產品／倉庫、無效數量及合計扣減不足時，在任何批次寫入前整筆拒絕。合法歷史小數／數字字串保留。

`reverseLotAllocations` 保留原 `costLotId` 血緣，不新增成本讀取或重算採購成本。現行 Service 不會把原倉的批次還原到另一倉；指定退貨倉與原批次倉不一致時安全拒絕，跨倉退貨需後續獨立的來源與目的批次契約，不能靠改 batch.warehouseId 完成。直送退貨的獨立入庫與待檢流程維持原入口，不在本批整合範圍。

不新增集合、Rules、索引、Query 或 Listener；重複批次改為一次交易讀取／寫入。公司／預留的負向數量計算、完整多倉還原、角色全流程與 Preview 驗收仍須繼續，不代表整套退貨與撤銷已全面統一。沒有正式 Firebase 部署、資料遷移或刪除。

### 指定來源倉的共用出貨扣帳（2026-10-17）

已實作：`reservation-core.planReservationIssue` 接收產品、實際來源倉、本次數量、預留帳及公司／該倉的原始庫存，統一產生出貨後的實貨與預留數量。`delivery-stock` 的正向出貨已接此核心，訂單送貨與倉庫出貨共用；批次挑選、交易內重讀、打單限制、事件識別碼與權限仍由原 Service／Infrastructure／Rules 負責。缺公司帳、異常數量、產品／倉位／明確品項預留不符時先拒絕，不先寫批次或用 clamp 掩蓋差異。

舊單維持原格式，支援合法小數及業務保管；允許未預留出貨的既有入口僅能使用本單預留加真正自由庫存，不可動用別單預留或自由調撥途中量。扣帳後的預留差額沿用 `reservationStockDeltas`，沒有第二套分倉公式。出貨撤銷與客戶退貨目前仍使用原有流程，尚未接入新版多倉出貨契約。

同一純核心已驗證 v2 locations 的指定倉分批扣量，保留其他倉預留並更新總量；缺額仍存在時不誤標完成。**此為多倉計算契約，不是多倉資料庫交易完成**。現行 StockPermissions 與 Rules 的位置欄位保護完整保留；不能先寫 v2 或把純測試當成多倉 Emulator 驗收。沒有新查詢、集合、索引、Rules、正式資料遷移或部署；現行出貨讀寫數量不增加。

### 預留同步與生命週期的共同帳目驗證（2026-10-17）

已實作：`reservation-core.validateReservationBalance` 共用於取消／恢復與一般訂單預留同步。在交易內驗證原始公司／分倉 onHand、reserved、transferFreeInTransit 與預留量；無效數量、預留不足及明確保存的品項 reservedQty 不符時整筆拒絕，不透過歸零縮量清帳。重新配置時亦驗證舊產品／倉庫帳；合法歷史小數與數字字串保留。缺少品項 reservedQty 的歷史資料沿用預留帳，不補寫或遷移正式資料。

同步的釋放量使用完整差額；callback 重試重置本次回傳及快取通知目標，並重讀驗證帳目。本批不新增查詢、寫入、集合、Rules 或索引；這是 Service／Core 防護，不代表所有原生寫入的 Rules 已完成同等稽核。多倉 ledger、完整服務型訂單與 Preview 全流程仍未完成。

### 多倉預留衝突的安全預覽（2026-10-17）

- `reserveSingleOrderItem` 遇到單一倉無法覆蓋、但多倉合計仍有可配置實貨時，使用現有 Reservation Core 的 `planMultiWarehouseReservation` 在既有 Transaction 已讀快照上計算只讀分配預覽，回報各倉可配置量、合計及真正剩餘缺口。
- 此路徑仍明確拒絕單倉 Service 的後續寫入，不建立預留、採購需求或出貨憑證；避免把散落於其他倉的庫存誤算為應採購。未新增查詢、Firestore 集合、Rules、索引或監聽。此非 v2 多倉 Ledger 實際交易，完整多倉分批履約仍待驗收。


### 採購需求併發控制（2026-10-16）

- 正式採購單 commitFormalPurchaseOrder 對安全庫存補貨的每個確定性 procurementDemands/{demandId}，先在同一 Firestore Transaction 讀取存在／不存在的文件，再根據最新承諾數量檢查剩餘量並寫入 PO、supplyOrder 與 demand。兩張 PO 若同時讀取同一需求，Firestore 的衝突重試會重新驗證，不讓舊視窗覆寫新承諾。
- 直接手動備庫採購沒有共同安全庫存需求，使用 STOCK_REPLENISHMENT:MANUAL_PO:{poNo}:{lineIndex} 作為個別採購需求 ID，避免重複使用產品 ID 導致跨 PO 汙染；現有安全庫存入口繼續使用固定來源 inventory ID。
- 這是「同一需求文件」的交易並發保護；不等於同步重新計算所有倉庫現貨或跨不同來源的全域採購預算上限。舊需求累計週期、取消／收貨後的動態重新補貨仍須專案驗收。

### 庫存設定／清單封存（2026-10-16）

- `src/services/inventory-planning.js` 擁有 `commitInventoryPlanningSettings`／`commitInventoryListArchive` 的交易；Feature 只管理確認、固定待確認 ID、視窗 generation、快取與呈現。Core 共用策略列舉、舊值推導及安全庫存正規化。
- 設定與 auditLogs 憑證同交易，無變更也留憑證；重試核對原 actor／意圖，回傳目前權威設定，不覆寫後來變更。封存同樣保留憑證；每次 callback 重新發現全部倉庫（含停用）與批次，各 limit(201)，超過 200 拒絕，逐文件交易重讀。拒絕異常或非零數量，包含自由調撥在途；不修改實體庫存。
- 設定每次兩筆固定讀取，新增操作最多更新一筆 inventory 及新增一筆 audit；重試只讀。封存增加固定 audit read，仍使用既有兩個單欄查詢，最多各 201 文件及逐文件重讀，無新集合／索引／Listener。發現查詢不是交易鎖定的 predicate，不能宣稱防止所有併發新增；仍依賴合法庫存 writer 同步公司總量。
- 本批 Rules 原始碼有變更：管理員／採購可 get 不存在的 audit ID，既有文件仍限管理員或本人；新 inventory_policy_set 憑證限制角色、欄位及同交易前後值。其他歷史 audit action 尚未全面強化，不能當成完整安全稽核。
- 正式資料庫版別查核逾時，未建立、修改或部署正式 Firebase。新應用上線須同步審查／部署新 Rules；本批 Rules 為待正式複核原型，Emulator 不替代正式驗收。pending ID 僅記憶體內有效；庫存補貨入口僅建立採購草稿，採購需求與供應承諾統一由 `commitFormalPurchaseOrder` 在成功建立 PO 時同交易寫入，避免放棄視窗留下假需求；跨重載恢復、多倉／SERVICE 全流程與 Preview 驗收仍待處理。

- 不引入新前端框架；Firebase Auth、Firestore、Cloud Functions 與原生 JavaScript 繼續沿用。
- `src/` 是 **app.js 的唯一可編輯來源**；`node tools/build-app.cjs` 將原始碼依固定順序組成部署／舊測試使用的 `app.js`。修改來源後必須提交生成結果，CI 會檢查逐位元相同。
- 目前維持 classic script 的全域識別碼行為，避免大規模轉 ES modules 造成 HTML inline handler、載入順序、Firebase 相依及測試破壞。分割來源**不代表全域依賴已消除**。
- 既有可直接 `require()` 的純商業核心仍保留於 `modules/`；第一階段不複製、重寫第二套 core。後續經測試才調整實際模組路徑。
- `functions/` 包含停用的供應商郵件相容入口、受 Preview 閘門保護的分組雙倉預留，以及僅 Emulator 可提交的單品項雙倉 Service；多數既有庫存交易仍由前端 Service 執行，不可聲稱已全部移到 Cloud Functions。

## 責任清單

| 層級 | 現有真正的來源／實作 | 責任／限制 |
| --- | --- | --- |
| App | `src/app/bootstrap.js`, `navigation.js` | Firebase 初始化、登入、角色、頁面狀態、導航。初始化檔仍含共享狀態與輔助函式，後續應再抽。 |
| Features | `src/features/products/`, `forecasts/`, `quotations/`, `orders/`, `purchasing/`, `inventory/`, `equipment/`, `administration/` | 使用者介面、查詢、表單、顯示。部分業務計算仍混雜，尚需透過 service 抽離。 |
| Services | `src/services/`：建單、預留、採購、收貨、生命週期、交付／退貨、盤點與人工庫存異動等 | 多個主要交易已有共同入口、原身分及重試契約；仍依賴 classic-global actor／Firestore／純 helper，尚未全面依賴注入，其他分散寫入仍需稽核。 |
| Core | `modules/workflow-core.js`, `fulfillment-core.js`, `inventory-core.js`, `reservation-core.js`, `procurement-demand-core.js`, `receiving-core.js`, `supply-core.js`, `order-entry-core.js` | 驗證、純數量投影、供貨／預留演算法。不可在 feature 另造權威公式。 |
| Shared transaction infrastructure | `modules/stock-permissions.js`, app 的 `runRoleTransaction` | 以 Firestore Transaction 執行、附加庫存變更證明。**所有寫入未必已經走同一路徑，待持續稽核。** |
| Workspace / 既有 UI 模組 | `modules/inventory-workspace.js`, `warehouse-logistics.js`, `customer-cancellations.js`, `delivery-settings.js`, `order-entry-ui.js` 等 | 含 UI 與流程呼叫；重複業務規則應逐步改呼叫共同核心。 |
| Infrastructure | `src/infrastructure/firebase.js`（Firebase 初始化）、`firebase.json`, `firestore.rules`, `firestore.indexes.json`, `functions/` | 儲存、權限邊界、索引與伺服端工作。正式與 Preview 環境不能混用。 |
| Shared | `src/shared/action-feedback.js`（共用錯誤訊息與防連點按鈕）、`modules/document-downloads.js`, `page-help.js`，以及現有 app 共用工具 | 共用下載、說明與視圖輔助；不擁有交易事實。 |
| Tests | `tests/`, `.github/workflows/regression.yml` | Node 測試、Chrome smoke、Firestore Emulator、建置來源一致性。 |

## 安全的主依賴方向（改善目標）

`Feature(UI) → Transaction Service → Core(純規則) → Firestore Transaction → Rules`。
目前實作並非全部已達此方向。功能工作區不得繞過權限與庫存證明。
**交易的業務原子性不等於單個 Firestore transaction：現有建單和多品項仍有逐項 checkpoint，必須另驗證中斷恢復與冪等。**

## 已知重要未完項目

1. 主要交易已有可直接載入測試的 Service；庫存清單／批號搜尋已改讀實際批次分頁。全域依賴、其他 Feature 寫入與舊持久化鏡像的清理仍待收斂，不能把拆檔當成全面解耦。
2. 新訂單同品項**真正多倉拆量**、跨倉分批交付仍未完成；`inventoryReservations` 單地點與規劃中的 locations ledger 不可混讀。
3. 原廠直送與一般收貨應各自維持相同的權威事件、不重複累計；`SERVICE` 商品型態須先確立不入庫的契約與測試。
4. `deliveryRecords`、`returnRecords`、`orders.items`、`inventoryReservations` 與 `warehouseStocks` 的權威邊界，參見 `BUSINESS_RULES.md`。
5. 未授權修改正式 Firestore、未移除現存歷史欄位相容、未部署正式 Firebase；對應既有文件 `docs/workflow-consistency-audit-20261014.md`。
6. 已將 PR #91 的取消／恢復修正整合至本分支來源與 bundle；原 PR 仍獨立開啟，最終正式合併狀態以 GitHub 為準。

## 修改方式

```sh
node tools/build-app.cjs
node tools/build-app.cjs --check
node --test tests/app-source-integrity.test.js
node --test $(find tests -maxdepth 1 -name '*.test.js' ! -name 'firestore-rules.test.js' | sort)
```

重整期間任何 commit 若只修改 `app.js` 而未改 `src/`，CI 應失敗。後續模組化要逐步把業務操作和共享狀態從 feature 移至真正服務模組，而不是建立平行 copy。

## Source responsibilities（2026-10-15 第二批精分）

- `src/services/order-reservation.js`：建單逐品項預留及採購需求同步。
- `src/services/supply-order.js`：在途同步、單筆供應取消及整張 PO checkpoint／結清交易；不擁有編輯狀態、取消視窗或 UI 快取。
- `src/features/purchasing/purchase-cancellation-workspace.js`：單筆／整張採購取消的確認、按鍵鎖與清單更新。
- `src/features/purchasing/purchase-order-editor.js`：採購編輯狀態、儲存按鈕與 PDF；由 Feature 呼叫在途 Service 並明確傳入提交後快取通知。
- `src/services/receiving.js`：收貨及自由庫存再分配的交易／checkpoint；不含 DOM、瀏覽器工作暫存及快取刷新。
- `src/features/purchasing/receiving-workspace.js`：收貨視窗、背景工作／sessionStorage 重試與結果呈現。
- `src/features/orders/order-workspace.js` 的 `refreshAffectedOrderCaches`：跨入口共用訂單快取刷新，仍為畫面責任，不在 Service 中。
- `src/services/order-lifecycle-reservation.js`：取消／恢復的預留交易變更。
- `src/services/delivery-stock.js`：送貨、退貨對庫存與批次的交易更新。
- `src/services/order-creation.js`：共用建單提交與 Forecast 原子來源連結。
- `src/services/inventory-count.js`：數量盤點、批次與操作憑證的共同交易。
- `src/services/manual-inventory.js`：手動／Excel 新增、批號／效期調整與報廢的逐列交易。
- `src/infrastructure/inventory-lot-read.js`：實際批次與批號／效期等值查詢的唯讀分頁 adapter。
- `src/features/inventory/inventory-lot-view.js`：批次頁面快取、完整性狀態、分頁按鈕與搜尋協調；不寫庫存或持久化批次。
- `src/features/inventory/inventory-workspace.js`：產品庫存顯示、盤點／調整操作 UI。
- `src/features/purchasing/purchase-order-editor.js`：採購單表單、PDF 與列印。
- `src/features/orders/{order-progress,lifecycle-workspace,delivery-actions,order-creation}.js`：訂單畫面及操作（仍含交易呼叫，待 service 化）。

這些來源目前經工具無損串接到 app.js，**是可維護的檔案所有權拆分，不代表完全隔離了 JavaScript scope**。每次抽出真正服務 API 前先以現有測試鎖定行為。

## 管理員功能責任精分（2026-10-15）

- `src/features/administration/brand-settings.js`：廠牌設定、價格表管理入口。
- `src/features/analytics/sales-reports.js`：銷售、成本、統計報表。
- `src/features/administration/user-and-system-settings.js`：管理員帳號及系統資料管理。
- `src/features/products/product-master-import.js`：主檔資料匯入、更新與資料批次寫入。

此批仍依原順序組成舊腳本；原始碼責任明確後才再抽出共享資料來源，避免既有全域事件與權限遭中斷。

## 收貨與交付數量共同投影（後續重整）
- `YushinFulfillment.projectOrderDelivery` 統一訂單級累計送貨、退貨、結案不補送與有效交付；頁面提供輸入，不再維護公式。
- `YushinReceiving.applyReceiptToOrderItem` 改由 `YushinWorkflow.projectItem` 決定 `outstandingQty`、`reservedQty`、`shortageQty`。Firestore 實際收貨寫入未變動。
- Receiving 在執行時解析 Workflow 相依，避免瀏覽器原有 script 載入順序在初始化時讀到空物件。

## 共用交易執行責任（2026-10-15）

- `src/infrastructure/stock-transaction.js`：權限 Rules 可用性檢查、採購安全來源選擇，以及唯一 `runRoleTransaction()` 入口；執行時確認真實登入 UID／角色未變更、委託 `YushinStockPermissions.run()`，提交成功後統一失效分析快取。
- `src/app/role-capabilities.js`：角色能力、客戶身分識別等與交易引擎不同的政策和 UI 輔助。
- 本次來源拆分採**原始位元順序不變**的方式，仍由一支 `app.js` 執行，後續對安全交易 API 進行獨立注入/測試時可在單一位置修改；不是聲稱已移除所有跨檔全域依賴。

## 訂單打單交易 Service（2026-10-15）
- `src/services/dispatch-preparation.js` 的 `prepareOrderDispatch(orderId,itemId)` 擁有打單的 Firestore transaction（重新讀正式訂單、驗證交易資訊、計算可打單量、同交易建立 `dispatchRecords` 與更新 `orders`）。
- `window.markOrderItemDispatchPrepared` 僅負責角色可見性、重複按鍵鎖、操作回饋及快取重新呈現；不可另寫第二套打單 Firestore 異動。
- 冪等性依 transaction 中重新檢查當前待打單量；如先前已提交，重試不能建立第二張相同的 dispatch 記錄。UI 鎖只是輔助，不能取代交易讀取。

## 訂單核銷交易邊界（2026-10-15）
- `src/services/order-billing.js` 為核銷狀態及核銷日期的唯一 Firestore Transaction 寫入入口；在交易內重新讀取權威訂單、驗證未取消及核銷資格，並在原子更新中記錄異動歷史。
- `src/features/orders/order-status.js` 只處理 UI、樂觀快取及完成／失敗回饋。核銷日期不再直接 `db.doc().update()`，一律使用 `runRoleTransaction` 及安全 Rules。
- 連續點擊用 pendingKey 阻止同頁重複請求；跨裝置重試則由交易內對最新資料的確認避免重覆寫入。快取不代替 Rules。

## 訂單取消／恢復的 Service 入口（2026-10-15）

- `src/services/order-lifecycle.js` 的 `setOrderLifecycleStatus(orderId,nextStatus)` 在 `runRoleTransaction` 中讀取最新訂單，判斷取消／恢復是否合法，並藉 `adjustInventoryReservationForLifecycle` 於同交易處理預留與採購需求，然後原子寫入訂單狀態、歷程及工作索引。
- `src/features/orders/lifecycle-workspace.js` 的 `quickSetOrderLifecycle` 僅負責角色畫面操作、確認提示、狀態更新與失敗回饋；不得直接再實作另一個取消／恢復資料庫交易。
- 單次重試中採相同 actor、date、at；服務對已是目標狀態的正式訂單不重複寫入，避免產生重複狀態歷程。

## 取消／恢復全入口與歷史推估更正（2026-10-16）

- `quickSetOrderLifecycle` 和狀態表單 `saveOrderLifecycleStatus` 均呼叫 `setOrderLifecycleStatus(orderId,nextStatus,details)`；`details` 包含狀態日期與原因。只修改日期／原因不觸發庫存預留變更；狀態轉換仍與預留、需求同交易提交。
- 快速操作在目標狀態已成立時不改寫既有日期／原因；表單相同值重試不新增歷史。歷史的 before 一律來自交易內最新訂單。
- `src/services/delivery-correction.js` 的 `clearOrderLegacyDeliveryEstimate` 為清除舊版送貨布林推估的唯一寫入入口。交易內重讀訂單；已有實際送貨或退貨時拒絕清除，避免舊畫面抹除新紀錄。重複清除不再次寫歷史；不建立實貨移動。
- 此批未完成送貨新增／編輯／撤銷服務化、多倉拆量或服務型訂單；不得視為整體重整結案。Rules／Index／Collection 無異動，沒有正式 Firebase 部署或資料清除。

## 訂單送貨交易服務（2026-10-16 後續批次）

- `src/services/delivery-records.js` 擁有 `completeOrderDelivery`、`cancelOrderDeliveries`、`saveOrderDeliveryRecord`、`correctOrderDeliveryRecord` 的受保護交易；四個對應畫面入口不再直接寫 Firestore，服務不讀取 DOM 或畫面快取。
- 一鍵／分批新增與增加送貨量均用 `Fulfillment.dispatchState` 驗證交易內最新打單、累計送貨和預留量。有效交付與 CLOSE 不補送退貨統一交由 `projectOrderDelivery` 推導；取消訂單不得新增紀錄，誤登更正仍允許保留歷史。
- 四個入口共用每單 pending 操作鎖；一鍵送貨的樂觀「已完成」畫面不再讓連點進入撤銷流程。
- 新增表單的相同內容在失敗重試時沿用 `recordId`，已提交相同紀錄則無寫入返回；已被更正刪除的識別碼禁止再次建立。編輯相同內容不新增歷史，更正刪除以既有 deliveryHistory 的 delete 紀錄辨識重試。識別碼、actor、時間在 transaction callback 外固定。
- 表單識別碼只保留在本頁記憶體；改變表單內容、重設／關閉再開或重新載入後不保證沿用。這不是跨頁面／跨裝置的永久 idempotency ledger；不應將其宣稱為全面冪等驗收。
- 增加既有送貨數量時保留原批次／成本並加入增量；減少或誤登更正沿用原批次追溯。`delivery-stock.js` 先按 lotId 加總回補量，每批次只讀／寫一次，防止同批次多筆 allocation 的最後寫入覆蓋。
- 範圍仍不包含倉庫工作區獨立出貨入口、多倉拆量、服務型訂單、正式環境角色驗收。Rules／Index／Collection 無異動；未部署 Firebase 或刪除正式資料。

## 倉庫寄客戶的共用服務接線（2026-10-16 後續批次）

- `commitInventoryShipment` 的唯一實作已從 `modules/inventory-workspace.js` 移至 `src/services/warehouse-shipment.js`；單筆出貨與 `warehouse-logistics.js` 批次寄客戶共用此受保護 Service，不保留平行舊實作。部署 bundle 在外部畫面模組前載入，兩支資源版本同步更新。
- 倉庫與訂單送貨共同呼叫 `assertOrderDeliveryIncrease`，由 `Fulfillment.dispatchState` 驗證正式打單、累計已送與預留；完成狀態均經 `orderDeliveryProjection`，不再於倉庫另寫 CLOSE 退貨公式。
- 相同 operationId 重試核對 sourceType、品項、數量、日期、備註，以及有提供時的倉庫／寄送資訊快照；相同請求無額外寫入，不同意圖不能借用同一 ID。actor、UID、時間在 callback 外固定。
- `deliveryRecordWasReversed` 由訂單與倉庫共用，辨識逐筆誤登更正與整筆撤銷的歷史。已撤銷的作業識別碼不得再次建立送貨；倉庫另保留 inventoryShipmentRecordId 防護。未引入新 Collection 或跨裝置永久 idempotency ledger。
- 單筆出貨現在也攜帶期望倉庫和標準化寄送資訊快照，與既有批次流程一樣在交易內重新核對；資訊變更時要求重新確認。
- 仍待多倉拆量、服務型訂單、其他交付／調撥流程的服務界線與正式環境角色驗收；本批無 Rules／Index／Collection／查詢／Listener 變更，沒有 Firebase 部署或資料清除。

## 調撥寄出、點收與業務保管 Service（2026-10-16）

- `src/services/warehouse-transfer.js` 為 `commitWarehouseTransfer`、`commitWarehouseTransferReceipt` 和 `writeTransferLots` 的唯一實作；`modules/warehouse-logistics.js` 保留物流核心、UI 與讀取，不再擁有這三個函式。兩支部署資源版本同步更新。
- 保留真實時間邊界：調撥寄出扣來源倉並記途中量，點收後增加目的倉；業務交付轉至 custody 保管位置、保留訂單預留，不建立客戶 deliveryRecords，也不憑調撥改變公司 onHand。
- 訂單調撥剩餘量使用 Fulfillment 的有效交付投影，不另複製退貨扣除公式；保留全數到貨／預留／打單後才搬移該品項的既有限制。這不是同品項多倉拆量功能。
- 交易內重新讀到的候選批次必須仍屬於相同產品與來源倉庫，否則整筆拒絕；單筆交付業務也傳入倉庫／寄送資訊快照，與批次核對一致。actor／時間在 callback 外固定。
- 自由庫存調撥點收與後續缺貨分配仍為 checkpoint 流程。點收後／分配前、分配返回後與完成標記交易內均核對原 UID／角色；若切換則保留已入庫與未完成分配狀態，回報 transferCommitted，可安全重試，不再入庫一次。這不代表多階段作業變成單一原子交易。
- 主倉備貨需求建立／取消、寄送設定與其他殘留 UI 寫入仍待後續整理；多倉拆量、SERVICE 商品和正式環境五角色驗收未完成。沒有 Rules／Index／Collection／查詢／Listener 變更、Firebase 部署或資料清除。

## 主倉備貨需求與預留核心（2026-10-16 後續批次）

- `src/services/main-transfer-request.js` 擁有 `createMainTransferRequest` 和 `cancelMainTransferRequestRecord`；`modules/main-warehouse-transfers.js` 僅處理取消確認、忙碌鎖、讀取與畫面，舊 UI transaction 已移除。寄出／點收仍呼叫 warehouse-transfer Service。
- `Reservation.planMainTransferHold` 為公司／分倉備貨預留增加及釋放的共同純規則。新增上限使用既有 `Inventory.normalizeStock` 可用量，排除預留與自由庫存調撥途中量；incoming 不作現貨。支援原有小數及有效數字字串，拒絕負數、NaN、空值／布林、預留子集不一致與不完整釋放。
- 同一 request ID 相同內容重試不重複預留；CANCELLED／SHIPPED 仍保留原狀態，不重新建立。取消只允許 PENDING，重試 CANCELLED 不再釋放，已寄出不得取消。需求與公司／分倉兩筆預留在同交易提交；不修改實貨、批次或客戶訂單預留。
- 交易成功後的清單刷新失敗，不再顯示成交易失敗；重試已取消需求也不誤報為新建立。actor、角色、時間在 callback 外固定，交易內重查能力與身分。
- 同步更新 app、Reservation core 和主倉畫面資源版本。無新 Collection／Rules／Index／查詢／Listener，無 Firebase 部署、資料刪除；多倉拆量、SERVICE 商品、其餘分散寫入及正式環境角色驗收仍未完成。

## 自行訂貨供應承諾共用交易（2026-10-16）

- `src/services/self-order-supply.js` 的 `commitSelfOrderSupply` 為建單同步與手動自行訂貨的唯一交易實作。`registerInitialSelfOrderSupply` 為相容呼叫入口、回傳來源訂單；`registerInitialSelfOrders` 保留逐品項 checkpoint 與一次快取失效。舊 order-workspace 兩套重複交易已刪除。
- 同交易讀取來源訂單／既有供應紀錄、以 ProcurementDemand 核心核對可訂貨量，驗證 Supply 資料後同步寫 supplyOrders、procurementDemands 與訂單品項、訂貨事件。核心未載入則停止，不跳過驗證。
- 建單同步沿用 deterministic self-order ID，且保留建單同步期間與採購協助的既有權限；手動入口仍要求同步完成與訂單負責業務能力，不能把兩者權限混成一套寬鬆分支。跨品項同步固定原 UID／角色，切換後停止未完成品項。
- 手動表單同內容失敗重試保留 operationId；在交易內讀到相同供應意圖就返回、不再追加承諾。識別碼撞到不同來源／品項／供應商／數量／成本／日期／備註則拒絕。actor、角色、時間與供應 reference 在 callback 外固定。
- 手動防重增加每次交易一筆已知 supply document read，沒有新查詢／Listener／Collection／Rules／Index。表單識別碼只在本頁記憶體保留，重新開啟表單／重載或改內容會視為新意圖，不代表永久跨裝置 ledger。
- 本批不變更到貨或現貨數量；直送承諾仍無公司倉庫。不代表正式 PO／快速採購全部已統一，多倉拆量、SERVICE 商品與正式環境驗收仍未完成。沒有 Firebase 部署或資料刪除。

## 快速採購交易服務（2026-10-16）

- `src/services/quick-purchase.js` 的 `commitQuickPurchase` 擁有快速採購的供應、需求、來源訂單與公司／分倉 incoming 同交易寫入。畫面僅取得確認、忙碌鎖及更新快取，不再包含 transaction 實作。
- 沿用訂單／品項固定供應 ID、原供應商／成本／產品／交付方式／倉庫快照，保留後續真實缺貨追加及零剩餘需求時 incoming 修復。直送不增加公司／分倉 incoming，零成本仍有效。
- UID／角色在開啟確認前取得，服務入口與交易每次重跑及讀取後重查身分／能力；actor 名稱、日期與時間固定於 callback 外，每次 callback 清除上次嘗試的輸出。直接服務呼叫也驗證供應商、成本及數量。
- 新增 callback 重跑、讀取時換帳號、原確認身分失效、交易失敗無部分寫入、後續真實追加及無效輸入測試；既有 incoming 與不確定回覆測試改為直接載入服務。
- 沒有新增資料讀取／Collection／Rules／Index／Listener，也沒有 Firebase 部署或資料刪除。固定供應紀錄與最新剩餘需求檢查不是永久作業 ledger；舊確認恰逢後續等量新需求仍非跨裝置防重保證。正式 PO、多倉拆量、SERVICE 流程及正式角色驗收尚待處理。

## 正式 PO 核心服務（2026-10-16）

- `src/services/formal-purchase-order.js` 的 `commitFormalPurchaseOrder` 接手建立 PO、逐列供應承諾、需求進度及來源訂單連結的共同交易；列印事件負責表單快照、快取與 PDF，核心提交完成後才輸出。輸入複製與每次 callback 結果清空，避免失敗嘗試外洩。
- 同一來源品項拆成多列，需求投影逐列累計、每個需求只寫一次，來源訂單亦依整筆採購總量更新；修正需求文件僅留下最後一列數量。相同備庫需求重複列目前拒絕，須先合併為單列，避免在缺少權威備庫需求合併語意時靜默覆蓋。
- 原 UID／角色於 PDF prepare 前取得，服務及每次交易讀取後核對能力與身分。供應 actor／事件時間在 callback 外固定；直接服務呼叫亦核對必要數量／價格與單號。
- 原單號已存在時，排除建立／輸出時間等非意圖欄位後比較原 PO 內容，核對固定供應連結、actor、來源、產品、數量、成本與供應商，僅回傳現況、不再寫入。不覆寫到貨進度、不重開取消單。衝突或缺供應紀錄拒絕，不視為新的 PO。
- 正常建立無額外讀取；只有既存單號的重試路徑新增每列一筆已知 supply document read。無新 Collection／Rules／Index／Listener、無 Firebase 部署或資料刪除。Incoming 仍由既有 registerPurchaseIncoming 逐供應分段同步，並非與 PO 全部單交易；跨段身分固定、多倉拆量、SERVICE 與正式角色驗收仍待後續處理。

## 正式 PO 在途 checkpoint 銜接（2026-10-16）

- 建單／重試入口將 PDF prepare 前捕捉的 UID／角色傳入 registerPurchaseIncoming。整批同步固定 actor／時間，每品項開始、callback 重跑、讀取後及提交後核對能力／身分；切換後停止後續品項與快取變動。
- 每供應交易重讀來源 PO，核對 supplyOrderIds、供應的 PURCHASING_PO 類型與 purchaseDocumentId，以最新原單／供應終止狀態為準。入庫倉庫必須來自供應快照，不再使用目前預設倉庫補缺漏。
- 以 Receiving.normalizeSupply 為剩餘待到貨與已登記在途投影來源。供應／到貨／已登記／公司及分倉 incoming 拒絕負值、非有限數字、空值與布林；到貨量不可超過採購量。負 delta 必須在公司及分倉完整扣回，不能以歸零掩蓋不足；僅允許浮點誤差範圍內的零值收斂。
- 公司與分倉存貨識別如有資料則必須相符；快取失效使用最後成功交易的產品／倉庫，移除從 supply ID 尾碼及舊畫面品項猜測的方式。每次 callback 清除暫存結果，movement reference 固定於 callback 外。
- 每供應增加一筆已知 PO document read，無新查詢／Listener／Collection／Rules／Index。保留逐供應 checkpoint：後續品項失敗不回滾已成功品項，重試依 incomingRegisteredQty 接續，不代表整張 PO 與所有 incoming 已合為單交易。無 Firebase 部署或資料刪除；多倉拆量、SERVICE 與正式環境驗收仍待處理。

## 採購取消／結清服務（2026-10-16）

- 單品項正式 PO／快速採購共用 cancelOutstandingSupplyRecord，維持自行訂貨不由此入口取消。服務直接驗證原因、原 UID／角色及採購取消能力；供應類型／文件歸屬不符、正式 PO 缺少原單連結均停止。讀取後及提交後核對身分，actor／時間／movement reference 固定於 callback 外。
- 取消量採 Receiving 投影；已到貨不回沖，部分到貨 CLOSED、未到貨 CANCELLED。來源訂單／需求已存在參照卻缺文件、來源承諾量不足、公司／分倉 incoming 不足、無效數量、產品／倉庫識別不符、直送卻有公司 incoming 或終止數量不符，都拒絕整筆，不以歸零或最低已到貨量掩蓋差異。
- stopPurchaseOrderOutstanding 接手整張 PO 逐供應取消與最後狀態寫入。最後 transaction 重讀 PO 及所有供應，驗證連結未變、各列已停止／全到貨且在途釋放，再依目前已到貨及停止量結清；UI 不再直接 set PO。最後結清失敗可重試，既有終止列不重扣，已完成到貨 PO 不產生取消寫入。
- 仍是逐供應 checkpoint，不把整張 PO 宣稱為單交易；中途失敗已成功列保留。單品項正式 PO 取消增加一筆原 PO read；整單服務另有啟動 PO read 及最後 PO／所有供應 read，均為已知文件，無新查詢／Listener／Collection／Rules／Index。成功後快取／畫面失敗與未提交失敗分開回饋。
- 測試覆蓋共同交易、callback 重跑、完整扣回、錯誤來源／缺資料、角色切換、跨列接續、最後 PO 提交失敗、連結競態與終止重試。無 Firebase 部署或資料刪除；多倉拆量、SERVICE、其他分散寫入及正式環境驗收未完成。

## 收貨原身分與重試邊界（2026-10-16）

- `receiveSupplyOrderRecord` 接收可選的原 `actorUid/actorRole`，背景工作在入列時保存並跨品項、重試和頁面重載沿用。Service 在入口、transaction 重跑、讀取後、收貨提交後及分配／進度修復中核對原身分；既有 `runRoleTransaction`／Rules 仍為安全邊界。
- 收貨 transaction 每次 callback 清除暫存輸出；actor、日期、批次／movement 引用在 callback 外固定。同 receiptId 重試比對 supply、數量、批號、效期與已保存的原 actor；不同內容拒絕，不能當成成功。新 receipt 增加不可變的 `createdByUid/createdByRole`。
- 共用自由庫存分配的 session guard 貫穿候選分頁、交易讀取及提交後。調撥收貨也傳入原身分 guard；新增 guard 不改變 receipt／transfer 分配 movement 的既有種類。
- 物理收貨與後續缺貨分配仍為分段 checkpoint，並非整批原子；收貨後的身分變更、進度查詢／修復或分配失敗標記 `receiptCommitted`，保留原識別碼重試。業務／工程師可重試自己的直送工作，實際歸屬仍由 Service／Rules 檢查。
- 舊 receipt 未含 actor 欄位時，只核對既有的供應與內容快照；舊 session 工作未含角色時，僅在原使用者明確點選重試時補存當前角色。沒有正式資料遷移。

## 收貨來源與庫存一致性（2026-10-16）

- `receiveSupplyOrderRecord` 沿用 Receiving／Supply 的收貨與在途扣回投影，在同一交易中驗證來源訂單及唯一品項、來源別名、產品／供貨方式、未收承諾、庫存同步狀態與既存需求的來源及承諾量。缺來源不能默默變成備庫。
- 一般收貨必須使用供應單已存的入庫倉庫，不再猜預設倉。驗證公司／分倉產品識別、有限非負數量、預留不得超過實貨；兩帳 incoming 都須完整覆蓋核心計算的釋放量，通過後直接扣回，不再以 `max(0, ...)` 隱藏短少。
- 正常來源的 reservation 必須對應同訂單／品項／產品／倉庫，且與品項預留、缺口及公司／分倉既有保留一致；取消且明確 KEEP_STOCK 仍可入自由庫存，不重新占回來源訂單。
- 已提交的相同 receiptId 先辨識重試，不把後來的取消／來源刪除／在途變動當新收貨驗證。獨立備庫、未登記 incoming 的歷史供應及缺需求補建仍保留既有邊界；不宣稱所有歷史資料已驗收。
- 沒有新增讀取、查詢、集合、索引或 Rules，無正式資料修改／部署。Service 防護不等於收緊所有可直接呼叫的 Firestore Rules，完整對抗測試與 Preview 驗收仍待完成。

## 收貨畫面／服務邊界收尾（2026-10-16）

收貨 Service 僅保留 `receiveSupplyOrderRecord` 與 `allocateFreeReceiptStockToShortages`；兩者的原交易、回傳及錯誤契約不變。視窗事件、背景工作、瀏覽器暫存移至收貨 Feature；共用訂單快取刷新回到既有訂單 Feature，沒有建立平行的交易核心。

Service 不再直接呼叫快取函式，改接收可選的同步 `onStockCommitted(productKey,warehouseId)` 通知。僅於 transaction 提交且原身分檢查通過後通知；收貨 UI、自由庫存回補 UI 與調撥 UI 明確傳入既有快取失效函式。收貨 Service 將通知傳給共同分配；調撥 Service 僅轉交呼叫端的通知，不依賴 Feature 函式。通知失敗不回滾已提交資料，收貨保留 `receiptCommitted` 與 checkpoint，原識別碼仍可重試。

`tests/domain-ownership.test.js` 防止收貨 Service 再引入 window／DOM／Storage／快取，以及防止收貨 Feature 另開交易。行為測試直接載入整個 Service，驗證無瀏覽器／快取全域仍能收貨，通知不在丟棄的 transaction callback 發出，收貨與分配後通知失敗也不重複扣帳。

這是收貨範圍的責任分離；真實角色、Firestore adapter、部分既有純規則／actor 輔助仍透過 classic script 共用識別碼解析，未宣稱完整依賴注入或全系統解耦。建單／轉單及盤點仍有 Feature 交易，為後續架構收尾項目；採購取消邊界另見下節。

## 採購在途／取消的 Feature／Service 邊界（2026-10-16）

- supply-order Service 保留原 `poIncomingKey` 純識別 helper、`registerPurchaseIncoming`、`cancelOutstandingSupplyRecord` 與 `stopPurchaseOrderOutstanding`；移除 DOM、window、編輯狀態、取消確認、按鍵鎖、清單與快取函式。採購編輯狀態／按鈕回到既有 editor，取消雙入口由專屬 Feature 擁有；收貨視窗的目標與識別碼變數回到收貨 Feature。
- 在途 Service 接收同步 `onStockCommitted`；單筆取消及整張 PO 接收並轉交同步 `onStockCommitted`／`onDemandChanged`。通知僅在交易與原身分核對完成後執行，Feature 明確接上既有快取失效，Service 不認識快取實作。
- 在途通知失敗可帶 `incomingCommitted`，單筆取消通知失敗帶 `supplyCommitted`／`supplyResult`，不表示交易回滾。單筆 UI 區分已提交後更新失敗；整張停止若在某列通知中斷，保留已停止列、尚未處理列與未結清原單，重試沿用原 checkpoint，不誤報整張已完成。
- 新架構測試檢查唯一交易 owner、Service 無 UI 依賴、取消 Feature 不另開寫入、editor 的兩條在途呼叫皆接通知；行為測試涵蓋無快取 collaborator、callback 重跑不重複通知、單列通知失敗及整張中斷續跑。保留原始角色、數量、取消範圍與讀寫量，無資料模型／Rules／Index 變更。
- 全域真實角色、Firestore adapter、既有投影 helper 尚未全面改為依賴注入；建單／轉單、盤點交易責任及 Preview 全流程驗收仍未完成。本節不代表整個系統架構已完成。

## 建單／轉單的共用提交服務（2026-10-16）

- `src/services/order-creation.js` 的 `commitOrderCreation` 擁有訂單文件提交。手動／估價轉單共用原視窗 wrapper；Forecast 多品項不再在 Feature 自行 batch 寫訂單。草稿、pending ID、庫存接續與快取仍由 Feature 協調，Service 無 DOM／Storage／快取依賴。
- Service 固定原 UID／角色與資料快照，入口、callback 重跑、讀取及提交後核對身分；已有 ID 回傳權威原單，不覆蓋進度。Forecast 同交易讀來源、核對有效狀態／負責人及提供的版本，再寫訂單和來源 backlink。失敗不留下半份連結；已提交後身分變更帶 `orderCommitted/orderId`。
- 手動建單沿用一筆 order read；Forecast 從無讀取的 batch 改為一筆 order read 加一筆 Forecast read，新單仍兩筆寫入，重試已有 ID 僅讀 order。無新增查詢、Listener、資料模型、Rules 或索引。Forecast Feature 以每帳號／來源的瀏覽器 pending ID 接續不確定回覆及庫存失敗。
- 此批只統一建單提交，不把庫存初始化與延後來源同步合併為單交易；共用 classic-global actor／Firestore／helper 尚未全面依賴注入。盤點與其他 Feature 寫入、多倉、SERVICE、跨裝置去重及 Preview 完整驗收仍未完成。前節的建單待辦由本節更新，不代表全系統架構完成。

## 庫存數量盤點服務（2026-10-16）

- `src/services/inventory-count.js` 的 `commitInventoryQuantity` 接手庫存卡片數量盤點。公司／分倉、批次與操作憑證同交易；核心仍是既有 `YushinInventory.quantityAdjustmentLots`。Service 不擁有 DOM、Storage、倉庫快取或畫面；呼叫端傳入明確單倉 fallback 與同步提交後 `onStockCommitted`。
- Service 固定原 actor、輸入快照、時間及 movement／新批次引用；callback 重跑清空輸出，讀取後與提交後核對身分。原 movement 優先辨識重試，內容／actor 不同拒絕，相同則只讀回原差量，不碰後續庫存。非有限／負值／空字串等異常數量不交給 clamp 正規化掩蓋。
- Feature 保留固定待確認 ID／內容、阻擋重入與變更後重送，視窗 generation 與身分 guard 防止舊非同步工作關閉新視窗或污染新帳號。提交後刷新失敗不誤報交易失敗；pending 記憶體不跨重載持久化。
- 變更成本：每次交易增加一筆已知 movement read，既有同 ID 重試僅此一讀。非零盤點保留原 bounded lot query（最多 201，超過 200 拒絕）及逐批次交易重讀／寫入；零差量新增一筆 movement write，不動庫存／批次。保留單倉 fallback，非全面歷史資料對帳。無新查詢／Listener／集合／Rules／索引或正式部署。
- 批次新增庫存、批號／效期異動、報廢及清單封存仍有 Feature 寫入；尚未將全部人工庫存入口統一。全域 actor／Firestore／純 helper 依賴、多倉、SERVICE 與 Preview 全流程驗收仍待收尾。

## 人工庫存異動服務（2026-10-16）

- `commitManualInventoryAdjustment` 接手手動／Excel 初始庫存、批號／效期增減與報廢；Feature 僅管理列、固定操作 ID、結果與同步快取通知。每列公司總量、分倉、批次、初始成本及 movement 同交易；整批仍為逐列 checkpoint，非整批原子。
- `YushinInventory.manualAdjustmentLots` 共用既有 count／reconcile／FEFO 分配核心。正數新增獨立批次，不修改原 receipt 身分；指定批號／效期減量只扣符合批次，不足拒絕，未指定則 FEFO。批次權威為 `inventoryLots`；舊 `inventory.lots` 於這個入口改由全部已讀批次投影，不再獨立加減。
- 每列 movement ID 與新增批次／成本 ID 固定，存去成本 `adjustmentIntent` 與原 actor。同 ID 重試先讀 movement；有實際初始成本的角色再讀受保護成本核對，倉管不讀成本。回覆遺失、通知失敗或後續庫存異動不會重複入／扣帳。Feature 保留未確認列 ID，防止重入及跨身分／視窗污染。
- 新交易讀產品及倉庫主檔，檢查存在、停用、產品識別、必填批號／效期與實體倉庫；拒絕明確 Service 型別。讀原始庫存／批次時拒絕無效數量與不足的預留，缺批次量以明確未知成本的未分批來源補齊；指定批號減量不把未分批量冒充指定批號。
- 成本：相較原每列兩筆 stock read，新增 movement、產品、倉庫及兩筆固定 lot ID read；成本有權角色另讀成本 ID。新增每產品一次 `inventoryLots.where(productKey).limit(201)` 查詢與逐文件 tx 重讀，超過 200 批拒絕。查所有倉庫批次是為重建舊列表鏡像；僅寫目標倉批次，無新索引／Listener／Rules／集合。盤盈／缺批次可能多寫 balance lot。初始真實成本與倉管 costPending 仍分離。
- 本節更新前節的批次異動待辦。清單封存／庫存設定等 Feature 寫入、其他入口的舊批次列表投影、超過 200 批的分頁設計、跨重載恢復、多倉、完整 SERVICE 與 Preview 驗收仍未完成。無正式部署、遷移或資料刪除。

## 庫存批次的唯讀投影（2026-10-16）

- 清單批號、效期及其 FEFO 排序改讀 `inventoryLots`；`fefoLots` 不再回退 `inventory.lots`。`YushinInventory.operationalLotRows` 驗證識別／有限非負餘量、排除零餘量並白名單投影，保留庫別，不攜成本或任意附加 payload。舊鏡像仍可能被歷史 writer 寫入，但不再決定此清單／搜尋結果。
- 每頁新產品以 30 keys 一組做 `productKey in` 查詢，每組每次讀 101 筆（100＋lookahead），正常 50 產品首讀兩組、最多 202 文件；不為每產品／每倉各開查詢，不自動掃完。cursor 以本次實際消費的第 100 文件為準，零餘量也推進 cursor。更多、失敗及尚未讀取均明示；未讀完不宣稱沒有批次或列出全域最早效期。
- Feature 保留群組 cursor／已讀資料，重用同一 in-flight page；按需載入更多並展開已讀列。刷新、相關產品庫存異動與角色切換失效快取；原 UID／角色、view generation 及群組 identity 防止舊結果復活。批次狀態只在記憶體，未寫 AppDataCache／localStorage，也不修改 Firestore。
- 貨號／品名／廠牌保留原 `inventory.searchTokens` 分頁，後驗證只看商品欄位，排除舊鏡像造成的批號假命中。完整批號以 `inventoryLots.lotNo == rawTrimmedInput` 查詢（區分大小寫），YYYY-MM-DD 另查 expiryDate；每欄每頁 51 讀取（50＋lookahead），用產品 key 批讀對應 inventory，再載入分倉／批次顯示。批號結果未讀完提供分頁，不以部分結果當全庫完成。
- 新批次／批號查詢皆使用既有單欄索引，無 Rules、composite index、集合或 Listener 變更。原商品 token 搜尋仍可能掃完全部索引候選；本批沒有改寫該既有查詢策略，也未保證批號片段／模糊搜尋。五角色 Rules 及桌機／手機控制另由 CI 驗證。
- 本節更新前節「庫存列表舊批次讀取」待辦；清單封存／設定交易、持久化鏡像／索引詞清理、超過 200 批的寫入作業、跨重載工作恢復、多倉、完整 SERVICE 與 Preview 全流程驗收仍待處理。

## 2026-10-17 選倉與實際預留的可用量契約

已實作：`selectSingleWarehouse` 沿用 `locationWarehouses` 的啟用實體倉篩選與排序，並使用 `inventory-core.normalizeStock` 計算分倉可用量；不再自行計算 onHand − reserved 而漏扣 transferFreeInTransit。`reserveSingleOrderItem` 的公司／分倉可用量檢查與最後選定倉驗證共用 `reservation-core.physicalWarehouse`，包含 warehouseType:CUSTODY、systemCustody 及 custody- 前綴。已有供應進度而鎖定位置的品項也不能繞過最終實體倉驗證。

無新寫入、查詢、索引、Rules 或資料遷移；本批未開放多倉位置 ledger。實際 Service 模擬交易涵蓋途中量、部分現貨、衝突後重新選倉、保管倉及重試；新增四個授權角色的 Emulator 情境，結果依當批 CI 判定。Preview 多倉拆量、分批出貨與服務型訂單全流程仍未驗收。

## 後端分批預留交易（2026-10-17，**已實作但預設關閉／尚未驗收上線**）

- 新增 `functions/grouped-reservation-service.js`，僅處理**同張訂單、同產品、2–5 個不同訂單品項、分布剛好兩個既有實體倉庫**的預留增減。這不是「同一個品項拆成兩個倉」的 v2 `locations` ledger，也不處理出貨、收貨、調撥或取消。保留現行所有瀏覽器端交易入口與 Rules，避免一半遷移造成交易漏洞。
- 後端使用 Firebase Callable 的已驗證 UID，**每筆新交易**在 Firestore Transaction 內讀取 `users/{uid}` 的角色與停用狀態、來源訂單與品項、公司／分倉庫存、倉庫主檔、各筆預留和操作憑證。業務與工程師只能操作自己所屬的訂單；採購、倉管、管理員按角色操作。不得信任前端傳入的身分、庫存或倉庫名稱。
- 用同一份 `modules/reservation-core.js` 的 `reservationStockDeltas` 計算權威差額。由 `tools/build-functions-core.cjs` 產生 `functions/shared` 交付副本（含 inventory core），CI 比對來源完全一致；不得另維護一套商業公式。將訂單品項投影、inventory 公司 reserved、warehouseStocks 分倉 reserved、inventoryReservations 與 inventoryMovements 在**同一個 Admin SDK Transaction** 更新；採購在途不得算作實貨，調撥途中與服務型／直送路徑拒絕。
- `reservationOperationReceipts/grouped-{attemptId}` 保存固定意圖雜湊、真實操作者與最終總帳差額；重複提交相同 ID 直接讀取憑證，換意圖或換人冒用被拒。Firestore Rules 對此集合完全禁止客戶端存取。沒有建立新索引或讀取監聽，也沒有正式資料 migration。
- `functions/index.js` 的 Callable `commitGroupedWarehouseReservation` **預設回傳尚未啟用**（須明確 `ENABLE_GROUPED_RESERVATION=true`），因為目前沒有把前端工作流程接到新後端，也未完成 Preview 的 Firebase Functions Emulator / 真實 SDK 同步驗收。此批不能解決 PR #131 的 Rules CI，也沒有解除 v2 位置欄位阻擋。僅本批 Node mock 的單交易與冪等測試屬已驗證；完整 E2E、不同角色實際 SDK 與並發及與歷史非標準 inventory ID 的相容性仍待驗收。

備註：後端剩餘交付需求採用與瀏覽器相同的 `fulfillment-core.projectOrderDelivery`（含 CLOSE 結案退貨處理），函式部署的產生副本與原始模組逐位元一致；來源產品主檔辨識為 Service 時必須拒絕實貨預留，並不把已結案退貨算為重新補送需求。

2026-10-17 後端試點補充驗收：`tests/emulator-grouped-reservation.cjs` 以 Firebase Admin SDK 對真正 Firestore Emulator 執行公司／雙倉／預留／憑證的完整同交易更新、冪等重試、權限拒絕、超額拒絕及兩次併發更新的守恆檢查。CI 不依賴正式服務憑證。**這仍不是 Functions Callable 真實 Auth SDK、正式環境部署或前端流程全接線驗收**。

### Preview-only 客戶端接線（2026-10-17，**正式不可用／待驗收**）

新增 `src/services/grouped-reservation.js`，將 `reserveInventoryForNewOrder` 的**初始同步**入口接至雙倉後端試點。僅 `APP_ENVIRONMENT==='preview'` 且明確設定 `globalThis.YUSHIN_PREVIEW_GROUPED_RESERVATION===true` 才讀取候選庫存及呼叫 Callable。若未開啟，完全沿用既有單品項流程，不增加 Firestore 讀取／函式請求。

試點僅接受同一訂單 2–5 個**不同**品項，同產品、剛好兩個固定來源倉、無原預留／採購／出貨／退貨進度、合法整數的情況。前端利用既有 Reservation Core 產生意圖，伺服端重新讀取與驗證。Callable 回傳有效結果後仍逐項沿用既有 Service 完成採購需求投影與工作狀態，不自行宣告整筆完成。身分或回覆不明確時停止，不在當次錯誤中退回單品項重複寫入；原同步的 checkpoint/retry 負責恢復。暫不支援 v2 同一品項多位置、歷史非標準 inventory ID、售後／收貨／出貨全流程。

伺服端另增來源同步嘗試識別碼 `syncAttemptId`，只有訂單 `inventoryReservationStatus='pending'` 且目前的 `inventoryReservationAttemptId` 相同時可建立新的雙倉預留交易；已存在相同操作憑證才可冪等重試，防止較舊初始同步在較新工作後繼續提交。無部署、正式資料操作及 Rules 寫入放寬。

### 2026-10-17 Preview Auth + Callable Emulator 驗收

新增 Firebase Authentication + Functions Callable + Firestore Admin SDK 三套 Emulator 連動測試，明確使用 `demo-yushin` 專案與模擬帳號，驗證持有登入憑證的採購可成功、無憑證拒絕、業務越權拒絕、停用後拒絕、竄改角色拒絕、重送意圖不重複、舊同步 ID 拒絕及交易一致性；CI 環境額外啟用 `ENABLE_GROUPED_RESERVATION=true`，不部署至 Firebase。正式專案 `yu-shing-company` 即使配置同名環境旗標也不得啟用這個試點 Callable。只有 `preview-20135` 在額外設定旗標時才允許（仍須 Preview 實際部署、人工驗收）；這些 Emulator 通過不表示正式切換已完成。

Callable Emulator 啟動修正：在 `firebase.json` 明確配置 `auth:9099`、`firestore:8080`、`functions:5001` 以免 CLI 因 Auth 未初始化而略過模擬登入；Functions 初始化採 `firebase-admin/app` 的 `getApps()/initializeApp()`，避免新版 Admin SDK 不再提供 `admin.apps` 所造成的模組載入失敗。以上僅為 Emulator 設定與程式初始化，不是正式 Firebase 部署。

## 單品項雙倉內部提交（2026-10-17）

`functions/single-item-location-service.js` 由唯讀規劃與 Emulator-only 原子提交共用交易讀取與 Reservation Core。提交更新同一預留 ledger、公司／分倉投影、訂單品項及操作憑證，不建立平行 Core。僅允許 demo-yushin Emulator；無 Callable／UI／Preview／正式入口。後續各履約 Service 尚未接入 v2，不能啟用多倉功能。詳見 `single-item-two-warehouse-readonly-20261017.md`。

## 指定倉分批出貨內部交易（2026-10-17）

新增 `functions/location-shipment-service.js`，只允許 demo-yushin Emulator 的單品項 v2 CUSTOMER_SHIP。沿用 Reservation／Inventory／Fulfillment／WarehouseLogistics 核心；不開 Callable 或 UI。倉庫寄出權威為 warehouseShipmentRecords，獨立於客戶 deliveryRecords，寄完不更新客戶送達。workCategories、既有前端交付服務及簽收確認尚未接入，不能宣稱服務層已全面統一。詳見 `location-shipment-emulator-20261017.md`。

## 出貨後送達確認（2026-10-17，僅 Emulator）

`shipment-delivery-service` 只確認既有實際寄出事件，不再扣實貨。`Fulfillment.projectShipmentDelivery` 為兩個後端 Service 共用的唯一 v2 出貨／送達投影；支援部分送達後再寄下一批。確認只讀 user／order／來源 movement、只寫 order 的送達事件及投影。未提供前端、Callable或Preview入口，workCategories／需求與舊交付／退貨服務仍待整合。詳見 `shipment-delivery-confirmation-emulator-20261017.md`。

## 送達撤銷及原批次追溯（2026-10-17，僅 Emulator）

確認、撤銷及追溯共用 shipment-delivery-service 的 actor／order／projection／shipment proof helpers。reverseShipmentDelivery只修正orders送達事件與投影，不動實貨；location-return-trace-service僅依明確lotId／qty核對真實原批次並產生不可提交的預覽。Inventory.planExplicitShipmentReturn補上混合包裹部分送達的明確選批契約，還原計算仍沿既有planLotRestoration。實物退貨入庫、UI、工作清單／需求及Preview仍待完成。詳見 delivery-reversal-return-trace-emulator-20261017.md。

### 原倉實物退貨交易（2026-10-17，Emulator）
`functions/location-return-service.js` 使用共同出貨來源驗證、`projectShipmentReturns`、明確原批次退貨、`planReservationReturn` 與 `planLotRestoration`，在單一交易還原原倉實貨及 CLOSE／REPLACE 預留，保存不可重複入庫的 movement。已支援分次退貨，但後續補送出貨及 UI／需求同步仍未完成；詳見 `location-return-receipt-emulator-20261017.md`，不得視為正式上線。

### 訂錯貨流程優先（2026-10-17）
主要退貨採 CLOSE，不自動補送；需要其他商品時，前端「退貨後重新下單」開啟既有乾淨建單入口，透過 commitOrderCreation 同交易核對原單並保存 returnReorderSource 單向關聯，不搬移舊預留／款項。原單累加補送與獨立免費補送開發暫緩。詳見 `wrong-item-return-reorder-20261017.md`。

### v2 打單準備的內部交易（2026-10-17；僅 Emulator）

`functions/location-dispatch-service.js` 新增 `commitLocationDispatchPreparation`，沿用 `Fulfillment.projectShipmentDelivery` 與 `warehouseShipmentState`，只處理單品項 v2 的待打單量、累計打單量及操作憑證；不另造打單核心、不扣庫存、批次或更新送達。真實使用者／角色、來源同步 ID、原單與 v2 預留帳在 Admin SDK Firestore Transaction 中重讀；`dispatchRecords/v2-{operationId}` 固定操作 ID 與訂單更新同交易。既有前端 `prepareOrderDispatch`／Rules 尚未切換，Emulator fixture 原本直接改品項打單量的操作已改成呼叫真正 Service；仍以手動 checkpoint 模擬初始同步完成，不可視為完整 Preview 驗收。僅 `demo-yushin` Emulator，無 Callable、UI、正式部署；涉及 REPLACE 退貨及完整待打單工作清單的適配尚未完成。

### 單品項 v2 預留取消／恢復（2026-10-17，僅 Emulator）

`functions/single-item-location-lifecycle-service.js` 使用既有 Reservation Core `planLocationReservation` 與 `reservationStockDeltas`，在同一 Firebase Admin SDK Transaction 核對 users／orders／products／inventoryReservations／inventory／兩個 warehouses 與 warehouseStocks／採購需求，完成單筆訂單品項的兩倉預留釋放及重新分配；額外保存原候選倉清單於既有 v2 ledger，避免取消後遺失來源位置。固定 `reservationOperationReceipts/single-v2-lifecycle-{operationId}`、逐倉 inventoryMovements、訂單狀態及公司／分倉帳同交易更新，失敗整筆回滾。嚴格限制**尚未採購、收貨、打單、出貨、送達或退貨**的單品項；有 procurementDemands 文件直接拒絕，避免錯誤跳過需求同步。admin 與本人 sales／engineer 可操作，warehouse／purchaser 不可。沒有新 Core、獨立庫存 ledger、索引或 Rules；沒有 Cloud Callable／前端入口、Preview／正式部署，現行 `setOrderLifecycleStatus` 仍不接 v2。

### v2 初始生命週期與採購需求一致性（2026-10-17，Emulator）

延續單品項初始雙倉取消／恢復 Service：現有採購需求文件實際儲存在 `procurementDemands/${encodeURIComponent('SALES_ORDER:'+orderId+':'+itemId)}`，並非未編碼 ID。`commitSingleItemLocationLifecycle` 已改用與前端 `procurementDemandRef` 相同的**完整 ID 編碼**，交易內重讀該權威文件，避免漏讀並錯放未同步的採購需求。僅允許供應商訂購量與收貨量都為零、狀態與來源完全一致的需求；採購已承諾／到貨、來源錯誤或狀態異常一律拒絕。取消在庫存及訂單同一交易將既有需求標記 `CANCELLED`（保留歷史量），恢復經既有 Workflow → Procurement Demand Core 投影重新計算需求，更新既有文件或依實際缺口建立新文件。`functions/shared/workflow-core.js` 與 `procurement-demand-core.js` **由 modules/ 建置產生**，不是額外權威計算核心，CI 建置一致性檢查同步擴充。仍限 demo-yushin Emulator；有真實 PO、部分出貨或收貨的完整交易，以及前端／Rules／Preview 都未接線。

### 部分交付後的 v2 取消／恢復（2026-10-17，僅 Emulator）

本節更新上述「初始取消／恢復」範圍。既有 `commitSingleItemLocationLifecycle` 現使用同一 `Fulfillment.projectShipmentDelivery` 與 `readShipmentProof`，交易內核對逐筆出貨扣帳證明、送達與訂單投影。僅支援**已寄出部分全部送達，剩餘部分未打單、無退貨及供應商承諾／收貨**的單品項雙倉訂單。取消釋放剩餘預留；恢復以原訂購量減已確認送達量呼叫原 `planLocationReservation`，採購需求同交易使用現有 Workflow／Demand Core 重算。歷史出貨、送達、打單累計與實貨／批次不改。仍無 Callable／前端／Preview／正式部署；途中貨、剩餘已打單及已下 PO 的取消未完成。

### v2 取消／恢復的未到貨供應承諾（2026-10-17，僅 Emulator）

本節更新前述「有供應承諾一律拒絕」限制。沿用 `commitSingleItemLocationLifecycle`；同一 Admin SDK Transaction 用既有 supplyOrders 的 orderId 與 demandId 兩種來源各查最多 51 筆，合併後最多接受 50 筆，逐筆驗證所有權、產品、實體倉、來源及零收貨狀態，正式 PO 額外重讀 purchaseOrders 與對應供應明細。承諾量由現有 `ProcurementDemand.reconcileLinkedSupplies` 計算，須等於訂單／採購需求投影；已登記 incoming 須由公司／分倉帳足量涵蓋。取消保留 supplyOrders、purchaseOrders 及 incoming；恢復將尚未到貨供應承諾交給現有 Reservation／Workflow／Demand Core，避免現貨與採購重複涵蓋。供應商同意取消仍使用既有採購 Service，客戶取消沒有供應商取消權。無新 Service／Core／Collection／Rules／索引；尚無 Callable／UI／Preview 或正式部署。

### 既有收貨 Service 的 v2 雙倉接線（2026-10-17，僅 Emulator）

`src/services/receiving.js::receiveSupplyOrderRecord` 延用同一個收貨寫入流程與既有 Receiving／Supply／Reservation Core；未另建平行收貨 Service。新增交易內 `validateV2ReceiptSource`，對位置版本 2 重讀真實 users 角色、原候選倉／分倉、PO 與需求來源；只准 `demo-yushin` Admin Firestore Emulator（process.env.FIRESTORE_EMULATOR_HOST + db.projectId），瀏覽器入口仍拒絕，StockPermissions／Rules 未放寬。正常來源只將本次到貨的實貨及預留加到供應紀錄指定倉，保留其他 locations，不回填單倉 warehouseId。取消來源須有原採購 KEEP_STOCK 決策，增加實貨及來源 receivedQty、減少採購 incoming，原 released ledger 完全不寫、不占回庫存。

同筆收貨的原 receipt、lot、protected lot cost／warehouse costSourceSupplyId、movement、supply、demand、order 及庫存維持原交易；新增 receipt 位置版本標記讓重送同樣重讀真實角色。原 src 建置產生 app.js，未只改生成檔。此試點只支援尚未出貨／退貨的單品項雙倉來源與分次收貨；非來源自由庫存對其他 v2 缺貨的自動分配、收貨後 v2 取消／恢復、Callable／前端／Preview 尚未整合。

### 已收貨後的 v2 取消／恢復（2026-10-17，僅 Emulator）

本節更新「已收貨一律拒絕」的生命週期限制。既有 `commitSingleItemLocationLifecycle` 現核對部分／全部收貨及已停止供應：供應狀態使用原 Receiving Core `normalizeSupply`、承諾使用原 Demand Core `reconcileLinkedSupplies`。同交易以 orderId／demandId 各限 51 筆查 receipts，聯集最多接受 50 筆；逐筆核對 v2 receipt 來源、唯一入庫 movement、原 lot 與逐供應累計，不以訂單或供應上的 receivedQty 快取當作入庫證明。

取消仍只釋放 reserved，不更改 onHand／incoming／批號／receipt／PO／供應履約；恢復以真實有效供應承諾減已收貨計算 inTransit，再傳給同一 Reservation／Workflow／Demand Core。已收貨歷史保留，需求 requestedQty 仍涵蓋累計收貨與目前缺口，不把收到的量重算為在途。Functions 的 receiving-core.js 由原 modules/ 建置產生並驗證一致，沒有第二個核心或新的 Service。仍只在 demo-yushin Emulator；途中貨、剩餘打單、退貨與正式 Callable／UI／Preview 尚未接線。

### 部分出貨後續收貨（2026-10-17，Emulator-only）

既有 Fulfillment Core 的 `projectShipmentDelivery` 增加 `unshippedQty`；Workflow 的明確 `warehouseShipmentContext` 由同一投影區分客戶尚未收到的 outstandingQty 與倉庫尚未寄出的 stockOutstandingQty。Receiving.applyReceiptToOrderItem 接受此第三參數，採購需求 helper 也提供來源紀錄，因此途中貨不再產生重複預留／採購缺口。沒有 context 的舊呼叫維持原行為。

原 receiving Service 仍為唯一收貨 writer。v2 先保留原始 order item、同交易驗證出貨／送達快取與全部出貨 movement，再交 Core 計算；避免展示 normalizer 用待送達量覆蓋實際 v2 缺口。共用 `Fulfillment.validateShipmentMovement` 核對扣帳身份、倉別、數量與批次配置；原 shipment acknowledgement adapter 仍額外核對完整 normalized intent hash，未減少驗證。無新 Service／Callable／UI／Rules；僅 demo-yushin Emulator。

### 單品項 v2 自由庫存 FIFO 協調器（2026-10-18）

沿用現有 `functions/single-item-location-service.js`；新 `advanceAutomaticFreeStockAllocation` 僅負責在至多 50 筆／狀態的安全候選範圍內依原 Reservation Core 優先順序選擇下一個目標、保存 resumable checkpoint，並呼叫同檔既有 `commitSingleItemFreeStockAllocation`。不建立第二個 stock writer、需求計算或 ledger；每個目標本身仍由既有 Admin SDK Transaction 交易內重讀、守恆並建立不可重用 movement。

job `reservationOperationReceipts` 與 movement 在不同交易，使用 pending 固定操作 ID 協助崩潰後續傳及同 ID 重送。批次有最大量與累計上限、同角色／意圖驗證，但不是跨所有訂單的原子交易。僅 demo-yushin Emulator；正式頁面沒有接線、自動觸發尚未實作、候選 >50 安全拒絕，需後續完成索引／分頁及 Preview 驗收後才可評估開放正式使用。

### v2 FIFO 有界游標分頁（2026-10-18）

原 `advanceAutomaticFreeStockAllocation` 協調器現以既有 productKey/status 等值查詢，採每頁 50 筆、DocumentSnapshot 游標翻頁；讀取 active/shortage 兩個候選集合後，依既有 Reservation Core 優先權比較排序，不新增第二個優先順序函式。掃描超過 500 筆則拒絕，以免不完整選單或無限制 Firestore 成本。對每個批次步驟會重新讀候選，因此效能仍待後續 server-side index/投影優化；正式部署與 Preview 尚未啟用。

### v2 取消與結案退貨的 durable 來源事件（2026-10-18）

現有 lifecycle 和 Location Return Services 不另建 outbox Collection，而是把自由庫存來源資訊寫入**同筆交易的既有 inventoryMovements**。庫存真正變動與事件原子提交；rollback 則來源事件一併回滾。後續 `single-item-location-service.advanceReleasedV2FreeStock` 讀取來源 movement 並核對原交易憑證及**現在**授權物流角色，再導向原來的 `advanceAutomaticFreeStockAllocation`；唯一預留數學和 movement writer 仍為 Reservation Core／原 Service。不同來源固定不同 runId，同事件進度可重送且不重扣帳。此仍是 Emulator 內部可呼叫流程，**尚無自動執行器、正式前端、Callable**。尚未處理到貨 KEEP_STOCK、大批分段、不同執行者 checkpoint 接管。

### 既有收貨三份憑證重用（2026-10-18）

多倉自由庫存來源除取消及 CLOSE 退貨外，現在可讀取原 Receiving Service 已原子建立的 warehouse receipt + movement + physical lot，並以其 `autoAllocationQty` 作為配貨最大量；取消後保留採購需驗證現存供應的 `KEEP_STOCK` 決策。所有實際庫存預留仍只由同一 `commitSingleItemFreeStockAllocation` Service 執行、進度寫原 checkpoint；不在 `src/services/receiving.js` 植入另一個 Admin SDK 或隱藏的側寫。這是 demo-yushin Emulator 的可恢復協調入口，尚非正式收貨 UI 自動執行。

### v2 post-commit 有界運行與可選組合入口（2026-10-18）

沿用唯一 `single-item-location-service.advanceReleasedV2FreeStock` 的來源核對及 checkpoint，新增 `drainReleasedV2FreeStock` 只用最多 10 次有限呼叫逐單推進，不引入第二個 Core／stock writer 或另一份 batch state。原 `commitSingleItemLocationLifecycle` 與 `commitLocationReturn` 仍各自是來源的唯一原子 transaction；同檔新的 `...AndRecover` **先提交來源、再在交易外**呼叫既有 drain。後段失敗回傳明確的 postCommitAllocation pending 和來源 movementId，不能假裝回滾來源；sales/engineer 角色不提升為物流權限。Emulator 新測試覆蓋 admin 同次分配、上限中斷續傳、兩角色 handoff 的未開工來源、來源 replay／REPLACE 不可調撥。沒有新增 Callable、background trigger 或正式 UI 接線。


### v2 自由庫存配貨進度完整性（2026-10-18）

已實作：既有 `advanceAutomaticFreeStockAllocation` 的每次 checkpoint 交易讀取（包含已完成重送及扣帳後結算）均經 `validateAutomaticFreeStockCheckpoint`。累計分配須為 0 至原 maxQty 的整數，步數為 0–1000；完成必須沒有 pending、具已知完成原因，quantity-reached 必須實際達到原額度。pending 必須具有完整且僅限既定欄位、正整數且不超過剩餘額度，操作 ID 必須依原 runId／步數／訂單／品項衍生。達 1000 步不可建立新指令。異常進度先拒絕，不自動改成完成、重設操作 ID 或推估已扣帳量。

沿用原 checkpoint、movement 與唯一自由庫存 writer；交易已提交但 checkpoint 結算失敗時，修復正確進度後仍以原指令重送，原 movement 確保不重複預留。不變更角色、Collection、Rules、Index、前端或 Callable，仍僅 demo-yushin Emulator。新增 Emulator 案例涵蓋完成憑證異常、pending 篡改與額度超限、扣帳後再讀進度異常及原 ID 續傳；實際執行結果以本批 PR CI 為準。完整 Preview、不同操作者安全交接及正式部署仍未完成。


### v2 配貨自動換人續傳（2026-10-18）

既有 `advanceAutomaticFreeStockAllocation` 在初次進度交易內，允許當前有效 admin／purchaser／warehouse 自動接手相同批次。仍使用原 runId、pending 操作 ID 及 maxQty，沒有新增配貨核心或庫存 writer。每次庫存提交額外在同一 transaction 重讀批次，核對現任操作者及 pending 指令，阻止已失去處理權的舊執行程序繼續寫入。

接手時若 pending 已有真實 movement，先核對原操作者／意圖／來源／數量，再由既有進度結算 helper 累計一次；保留 movement 原身份。交接紀錄與進度更新同交易。已完成批次可由當前合格物流角色唯讀取得結果，不建立交接或新 movement。仍限 demo-yushin Emulator；沒有新增 Callable／前端／背景觸發或 Firebase 部署。


### CLOSE 退貨後的剩餘履約（2026-10-18，Emulator-only）

既有 `commitLocationDispatchPreparation`／`commitLocationShipment`／`commitShipmentDelivery` 支援全部退貨皆為 CLOSE 時，繼續完成原訂單剩餘未交付部分。數量與狀態沿用 `projectShipmentReturns`、`warehouseShipmentState`、原 Reservation／FEFO Core；不重開已結案數量、不新增庫存 writer。REPLACE、混合補送、退貨後送達撤銷仍安全拒絕。

原退貨 intent normalizer 及有界實際入庫憑證核對移至現有 `location-return-trace-service.js` 的唯讀契約，由退貨及後續履約共用；`location-return-service.js` 保留原 export、唯一退貨 writer 與 intent hash。Trace 的送達 adapter 改為呼叫時載入，避免 shipment／delivery／return 的載入循環。此重整不表示重複退貨的唯讀追溯已接線。無新增模組／集合／Rules／Index，仍限 Emulator，沒有正式 Callable 或前端啟用。


### CLOSE 退貨後的取消／恢復（2026-10-18，Emulator-only）

原 `commitSingleItemLocationLifecycle` 改以既有 `projectShipmentReturns` 投影，並沿用 `readLocationReturnProofs(closedOnly:true)` 核對實際退貨。取消／恢復使用相同 Reservation Core，需求仍走 Workflow → Procurement Demand Core，不新增 writer 或數量核心。新交易在原讀取階段增加一次有界 return movement query，初始空退貨快取可省略欄位但不能略過實際憑證查詢。

CLOSE 後僅剩餘未交付部分可取消／恢復；已出貨須全數確認、累計打單須等於已寄出，仍不處理途中貨或未出貨打單。REPLACE／混合補送與全數完成仍拒絕。組合的取消後配貨入口沿用原 release movements 與 coordinator，不增加自動背景作業。僅 demo-yushin Emulator，沒有 Callable／前端／Firebase 部署。


### CLOSE 退貨後的後續收貨（2026-10-18，Emulator-only）

本節更新先前退貨後不能收貨的限制。沿用 `src/services/receiving.js::receiveSupplyOrderRecord` 唯一收貨 writer，交易內從有界 sourceId＋action 查詢核對所有原退貨入庫憑證（空快取也查），並驗證 item／order returnedQty、出貨、送達及供應來源；只支援 CLOSE，REPLACE／混合補送與退貨更正仍拒絕。退貨意圖正規化及憑證資料驗證抽至原 Fulfillment Core，Functions 原 reader 與原收貨 Service 共用；雜湊順序及歷史操作 ID 不變，平台分別使用 Node SHA-256／Web Crypto。

Workflow 的明確 warehouseShipmentContext 現包含 returns，以原 projectShipmentReturns 區分商業未結清與實體尚未寄出量。Receiving 明確傳 gross／effective，CLOSE 不再被扣第二次；採購需求 helper 同樣帶原退貨事件。無 context 的舊契約保留。原 receipt、批次、成本連結、供應／需求、公司／分倉及來源預留維持同一交易；取消後仍須原採購 KEEP_STOCK 決策，收貨只成自由實貨，恢復至多需求剩餘未寄出量。沒有第二個 writer、後端側寫、Rules／索引變更或正式接線。


### 取消訂單後 CLOSE 實物退貨（2026-10-18，Emulator-only）

原 commitLocationReturn 可接收已取消來源的 CLOSE 退貨，仍沿唯一退貨 writer／原批次還原／固定 movement ID；不新增 Callable、前端或正式資料寫入。shipmentDeliveryContext 增加僅由此 writer 明確傳入的 allowCancelledCloseReturn；預設仍拒絕取消來源，因此一般新增送達、送達撤銷及唯讀追溯不會連帶開放。

新交易要求 status／orderStatus 同為 cancelled、來源同步完成、已寄出全送達且無額外打單、只含 CLOSE／無退貨更正歷史。v2 ledger 必須 released、quantity／shortageQty皆0且 locations空，item預留／缺口一致。原 Reservation.planReservationReturn 在此條件下只加公司與原倉實貨，保留 released，不因入庫釋放殘存異常預留或占回取消來源。退貨憑證、原出貨 movement、真實批次、角色／所有權與庫存平衡仍在同一 transaction 核對；不新增讀寫集合或查詢。

後續恢復仍由原 lifecycle Service，以原訂購量減歷史寄出量規劃剩餘需求，CLOSE不新增補送；採購／收貨歷史不改。原自由庫存協調器可用同一退貨 movement 將最多退回量分給其他正常訂單，取消來源不重啟。REPLACE／混合補送、途中或額外已打單的取消、更正／撤銷、完整 Auth／UI／Preview 仍未開放。


### 取消／既有 CLOSE 後的唯讀批次查核（2026-10-18，Emulator-only）

原 planLocationReturnTrace 現支援正常或一致 cancelled 來源，以及已有 CLOSE 退貨的剩餘批次。沿用原 shipmentDeliveryContext、readShipmentProof 與有界 readLocationReturnProofs；取消來源再核對完整 released 空 v2 ledger。取消後無途中貨／額外打單／更正或REPLACE歷史的限制抽成 assertCancelledCloseReturnContext，查核與實際原退貨 writer 共用，沒有另建 writer。

原 Inventory.planExplicitShipmentReturn 接收選定shipment的 priorReturns，新增唯讀額度結果；不重算另一份數量。查核仍驗證所選真實批次並回傳 status read-only／canCommit false，不寫庫存、訂單或憑證，也不讀公司／分倉庫存或成本集合。入庫必須在原 commitLocationReturn 的新交易重新授權及核對全部帳目，不能以預覽當提交承諾。其他新增送達／撤銷的取消guard不改，無Callable／UI／Preview或正式部署。


### 退貨真實登入與 Callable 整合（2026-10-18，Emulator-only）

新增 functions/v2-return-callable-adapter.js 僅包裝原 planLocationReturnTrace／commitLocationReturn；UID只取Firebase Callable request.auth.uid，角色／active／所有權仍由原Service在交易內重讀users與order，不信任請求欄位或token自訂role。沿原意圖normalizer、固定operationId／hash與唯一writer，不新增庫存邏輯。

正式 functions/index.js不載入／不匯出這兩個Callable。tools/run-v2-return-auth-emulator.cjs 在臨時目錄建立測試Functions入口與設定，引用實際checkout服務和SDK，固定demo-yushin；flag、FUNCTIONS_EMULATOR、demo project、本機Auth／Firestore host與db.projectId均核對。CI以獨立Auth＋Functions＋Firestore Emulator跑真實Email/Password登入、Callable SDK與ID token；無正式Firebase或供應商設定變更。

這是退貨邊界的真實登入整合，不代表完整ERP初始化／UI驗收：上游訂單與庫存為Admin fixture，預留／打單／出貨／送達／取消使用原Service，來源sync完成點仍明確fixture設定。正式Callable／前端／Preview、完整初始化與退貨更正／REPLACE仍待整合。


### 退貨整合改走實際初始化同步（2026-10-18，Emulator-only）

本節更新退貨Auth整合的手動completed checkpoint限制。tests/fixtures/v2-order-initialization.cjs 在VM載入原src的synchronizeOrderInventory／writeOrderInventorySyncState、reserveInventoryForNewOrder、persistOrderProcurementDemands、採購需求helper、初始自行訂貨判斷與工作索引；品項預留只轉接原commitSingleItemTwoWarehouse，不跑舊單倉writer、不重算庫存／採購數量。

同步工作ID由原流程建立，實際雙倉交易後再用原需求同步，最後由原來源狀態交易完成checkpoint；測試不再直接update completed。Admin SDK adapter在每次transaction重讀真實users／來源並套用原canRetryOrderInventorySync，防止測試adapter繞過當前角色／所有權。原來源重試與失敗恢復邏輯完整執行，仍無新增產品writer或正式入口。

退貨Auth測試已沿此流程初始化後再打單／出貨／送達／取消／退貨。這是實際同步流程的Emulator驗收；來源訂單／初始庫存仍為Admin fixture，初始化本身的瀏覽器Client SDK／Rules／登入呼叫與正式UI仍未串接，不等於完整ERP建立訂單驗收。正式v2阻擋與Firebase設定不改。

### 真實登入建立訂單接入 v2 初始化之驗收（2026-10-18，Emulator-only）

擴充既有退貨 Auth／Callable 整合測試：以 Firebase Client Auth SDK 真實登入業務帳號，Firestore Client SDK Transaction 經實際 firestore.rules 呼叫原 `src/services/order-creation.js::commitOrderCreation`（VM 僅提供模組化 SDK 相容傳輸 adapter），而非以 Admin fixture 直接建立來源訂單。建單後先核對尚未扣預留，再呼叫上一批原 `synchronizeOrderInventory`／雙倉 v2 writer／正式需求同步與 checkpoint，驗證 10 件需求、兩倉可預留 7 件、採購需求 3 件。也驗證 Rules 拒絕含成本建單、倉管直接建單及同一 pending ID 回放不覆寫已完成原單或再次預留。

界線：產品主檔、實體庫存、倉庫與 Auth 的 users profile 仍是 Admin 測試 seed。建單原 Service 透過 Firestore Client SDK adapter 跑實際 Rules，初始化仍透過上一批 Admin SDK VM adapter；**並非實際瀏覽器頁面／Preview 的全線整合**，正式 Callable、前端執行閘門與 Firebase 部署不變。測試以 PR CI 為準。


### 2026-10-18 實際打單入口續傳整合

兩個實際打單頁共用固定操作 ID 與凍結數量，Service 使用既有 Fulfillment Core 與 StockPermissions；讀預留時保留未啟用多位置契約的阻擋。 詳見 [介面交易對照與驗收邊界](transaction-ui-integration-20261018.md)。已實作、待本批 CI；未部署 Firebase，單品項多位置仍未啟用正式介面。


### 2026-10-18 退貨實收 Service 接線

既有退貨實收與待檢轉庫存的交易編排已移到 src/services/customer-return.js，兩個原操作頁入口只呼叫 Service。實體退回與直送退回仍沿用原有 writer／Core；不新增相同功能的核心。 驗收項目與限制見 [介面交易對照](transaction-ui-integration-20261018.md)。未部署 Firebase，完整 Preview 全流程尚待驗收。

### 2026-10-18 整單雙倉預留引擎

原雙倉 Service 以單一 `runLocationReservation` 同時服務單品項與 `commitOrderTwoWarehouse`。整單 1–5 品項共用交易內公司／分倉餘額、原 Reservation Core 與一次 Transaction；所有品項驗證後才提交，沒有第二組數量規則或逐項獨立提交。仍為 Emulator-only，未接正式 UI／Callable；需求與來源同步 checkpoint 尚待接線。見 [契約及驗收邊界](multi-item-location-transaction-20261018.md)。

### 2026-10-18 整單初始化續傳

整單 Emulator adapter 已接原初始化協調器及原需求 helper；庫存一次交易、需求逐項可恢復，不宣稱跨階段原子。實際前端預留 Service 補上交易內 attempt 防護，需求 helper 可接受初始化 context；原取消／恢復投影不變。正式 v2 UI／Callable 未啟用。見 [完整邊界](multi-item-initialization-20261018.md)。

### 2026-10-18 多品項分批收貨

既有 receiving Service 的 v2 驗證擴充為最多五個實體商品、初始化完成且無履約進度的多品項來源；仍只有原收貨 writer／Core。交易內核對同產品所有 ledger 的合計持有量，未收貨品項原樣保留。正式瀏覽器／Callable 閘門不變。見 [範圍與驗收](multi-item-receiving-20261018.md)。

### 2026-10-18 整單履約 Core 與打單

原 Fulfillment Core 以 projectOrderShipmentReturns 驗證完整事件並分組呼叫既有逐品項投影；原 v2 打單 Service 使用其整單與逐項結果，核對全單 ledger、出貨扣帳與退貨入庫憑證後，只改選定品項及一份打單記錄。仍 Emulator-only，多品項出貨／送達 writer 尚未擴充。見 [契約及驗收](multi-item-dispatch-20261018.md)。

### 2026-10-18 多品項雙倉實際出貨（待 PR CI）

原 `commitLocationShipment` 現沿用整單履約投影驗證 1–5 品項的來源及所有歷史出貨／退貨憑證，再以原預留 Core 和批次分配原子扣除選定品項的實貨與 ledger，保留其他品項資料，不建立第二套交易邏輯。此階段只支援 demo Emulator；未接多品項送達／正式 Callable 或 UI。見 [出貨試點契約](multi-item-shipment-20261018.md)。

### 2026-10-19 多品項獨立送達確認（待 CI 驗收）

原 `commitShipmentDelivery` 接入整單履約 Core，驗證多品項全部來源出貨 movement 與不可變退貨憑證後，在同一 orders 交易內只更新選中品項送達及整單交付合計，不動庫存、批次、預留。單品項撤銷及退貨追溯仍維持原範圍。此功能仍僅 Emulator，未接正式 UI／Callable。見 [多品項送達驗收邊界](multi-item-delivery-20261019.md)。


### 2026-10-19 多品項送達撤銷（已實作、待本批 CI）

原 reverseShipmentDelivery 現與多品項確認共用來源及整單出貨憑證 reader，沿用整單 Core，只更新選定送達及全單投影；不另建 writer。 僅 demo-yushin Emulator；未接正式 UI／Callable、未部署 Firebase，完整 Preview 仍未驗收。詳見 [同一份送達契約與驗收範圍](multi-item-delivery-20261019.md)。
