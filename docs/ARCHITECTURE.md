# ARCHITECTURE — 又鑫系統程式碼責任地圖

版本：2026-10-15｜以 main 與 PR #92 為重整基礎。**這是實際第一階段結果；不代表交易核心或資料模型已完成全面驗收。**

## 目標與現況

- 不引入新前端框架；Firebase Auth、Firestore、Cloud Functions 與原生 JavaScript 繼續沿用。
- `src/` 是 **app.js 的唯一可編輯來源**；`node tools/build-app.cjs` 將原始碼依固定順序組成部署／舊測試使用的 `app.js`。修改來源後必須提交生成結果，CI 會檢查逐位元相同。
- 目前維持 classic script 的全域識別碼行為，避免大規模轉 ES modules 造成 HTML inline handler、載入順序、Firebase 相依及測試破壞。分割來源**不代表全域依賴已消除**。
- 既有可直接 `require()` 的純商業核心仍保留於 `modules/`；第一階段不複製、重寫第二套 core。後續經測試才調整實際模組路徑。
- `functions/` 目前主要有供應商採購郵件相關的雲端函式，不是所有交易的中央服務層；不可聲稱所有庫存交易都在 Cloud Functions。

## 責任清單

| 層級 | 現有真正的來源／實作 | 責任／限制 |
| --- | --- | --- |
| App | `src/app/bootstrap.js`, `navigation.js` | Firebase 初始化、登入、角色、頁面狀態、導航。初始化檔仍含共享狀態與輔助函式，後續應再抽。 |
| Features | `src/features/products/`, `forecasts/`, `quotations/`, `orders/`, `purchasing/`, `inventory/`, `equipment/`, `administration/` | 使用者介面、查詢、表單、顯示。部分業務計算仍混雜，尚需透過 service 抽離。 |
| Services（過渡區） | `src/services/order-reservation.js`, `supply-order.js`, `receiving.js`, `order-lifecycle-reservation.js`, `delivery-stock.js` | **實際交易操作已從大段中抽至各個維護位置**，但仍依賴跨檔全域資料，尚未形成獨立注入的服務；後續須收斂寫入入口與冪等契約。 |
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

1. `app.js` 原始碼已依功能切分，但全域資料與某些 UI/業務/寫入耦合仍在；下一批才拆成可獨立測試的 services。
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
- `src/services/supply-order.js`：採購／供應單登記與取消供應流程。
- `src/services/receiving.js`：收貨、自由庫存再分配與重試協調。
- `src/services/order-lifecycle-reservation.js`：取消／恢復的預留交易變更。
- `src/services/delivery-stock.js`：送貨、退貨對庫存與批次的交易更新。
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
