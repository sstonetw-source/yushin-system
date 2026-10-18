# 實際操作介面與交易入口整合（2026-10-18）

查核基準 main `9f83bf6170f3a8fa0fcbc9418616d15921bcdd72`（PR #167）。以下「已接」指 checkout 中的介面呼叫，不代表已部署 Firebase 或通過 Preview 人工全流程。

## 入口對照

| 作業／入口 | Feature 與權威 Service | Core／資料提交邊界 | 權限與測試／尚待驗收 |
|---|---|---|---|
| 手動建單、估價單成交、Forecast 轉單 | order-creation、quotation-workspace、forecast-workspace → commitOrderCreation；order-workspace → synchronizeOrderInventory | Reservation／Procurement Demand；orders 建立與來源連結，預留及需求為 checkpoint | Client Rules、runRoleTransaction；已有實際建單 Auth／初始化 Emulator，完整頁面與 v2 初始化未接 |
| 預留／缺口 | order-reservation → reserveSingleOrderItem；grouped-reservation Preview bridge | Reservation Core；orders、inventoryReservations、inventory、warehouseStocks、procurementDemands、movement | 一般逐品項已接；多品項不是整單原子；grouped callable 僅 Preview 明確 flag；單品項多位置仍 Emulator-only |
| 正式採購／快速採購 | purchase-order-editor／purchasing-workspace → commitFormalPurchaseOrder／commitQuickPurchase | Procurement Demand／Supply／Workflow；purchaseOrders、supplyOrders、需求及在途 | 已接既有 Service；需要多品項、跨日期及取消剩餘的連續 UI 驗收 |
| 實收到貨 | receiving-workspace → receiveSupplyOrderRecord | Receiving／Reservation；receipts、lot、需求、實貨與來源預留；自由庫存分配為 checkpoint | 已有固定 receipt ID、原資料重試及角色防護；多位置後端試點未全面接 UI |
| 訂單頁／採購待打單頁 | dispatchActionHtml／renderPurchasingDispatchOrders → markOrderItemDispatchPrepared → prepareOrderDispatch | 共用 itemDispatchState → Fulfillment Core；orders 與 dispatchRecords 同交易 | **本批**補固定 ID、凍結確認量、跨頁與刷新重試；Node、Client Rules／Emulator、Chrome 測試；不增加實貨、出貨或送達 |
| 倉庫出貨 | inventory-workspace／出貨清單 → commitInventoryShipment | 既有 delivery-stock delta、Fulfillment；orders、deliveryRecords、inventory／warehouseStocks、lot、movement／cost | 已有一般入口與 Service；一般舊流程仍以 deliveryRecords 承載出貨，不能當成新 v2「出貨／送達分離」已啟用 |
| 業務送貨／更正 | delivery-actions → completeOrderDelivery／saveOrderDeliveryRecord／correctOrderDeliveryRecord | Fulfillment、delivery-stock／delivery-correction；orders、deliveryRecords、lot／movement | 已接；v2 commitLocationShipment／commitShipmentDelivery 分離事件只在 Emulator，未載入正式 Functions index |
| 取消／恢復 | lifecycle-workspace／delivery-actions → setOrderLifecycleStatus → adjustInventoryReservationForLifecycle | Reservation lifecycle；orders、預留、公司與分倉、需求同交易 | 一般入口已接；v2 單品項 lifecycle 尚未接正式頁面；多品項跨倉仍需整合驗收 |
| 客戶退貨實收／訂錯貨重下單 | customer-cancellations → commitCustomerReturnReceipt；order-creation → commitOrderCreation | 既有 CLOSE 實收、批次追溯、獨立一般新訂單；原實收程式仍在 modules/customer-cancellations.js | 該模組仍混合 Feature／交易責任，應後續搬移既有 writer 而非另寫；v2 Auth return adapter 只在隔離 Emulator，沒有正式 Callable |
| 服務型訂單 | 需核對商品主檔到建單、採購、履約完整契約 | 不可因單一 productType 或打單排除測試就宣稱不入庫全流程完成 | 本批一般打單明確拒絕 SERVICE；整體不入庫流程仍待獨立驗收 |

## 本批打單契約

兩頁保留原有逐品項按鈕，使用同一個 UI handler 與 `src/services/dispatch-preparation.js`，未新增第二個打單 writer 或數量公式。數量提案由既有 `itemDispatchState` 提供，Service 在交易內重新讀訂單，以相同 Core 驗證。

首次點擊前將 operationId、orderId、itemId、actorUid、actorRole、quantity、expectedPreparedQty 保存於目前帳號／訂單／品項的 sessionStorage。無法保存時不提交。工作在該瀏覽器分頁刷新後保留；不宣稱跨裝置或關閉分頁後仍可續傳。

`dispatchRecords/{operationId}` 為不可修改的交易憑證，和 orders.items／工作索引一起提交。相同 ID 重送須符合原 actor、role、訂單、品項、數量及打單基準；已提交時只讀取原憑證與最新訂單，不再次打單。即使原提交後有新到貨、訂單取消，重送也不重新執行原動作。

新操作若打單累計已變更或確認量超過目前 Core 待打單量，整筆拒絕。兩個不同 ID 同時競爭原打單基準時，只有一個能提交。成功回覆遺失保留原工作；兩頁顯示「確認打單結果」，包含目前待打單量已為零的情況。只在交易確認原 ID 尚不存在且基準失效（dispatch-stale）時清除舊工作，使用者更新清單後再確認新數量；不在不明網路錯誤後換 ID。

Service 限 admin／purchaser；真實身分與目前 profile 的最終權限由現有 runRoleTransaction／StockPermissions 與 Firestore Rules 執行，前端角色不是授權證明。讀預留來源沿用 StockPermissions 對所有未啟用位置欄位的阻擋，不新增另一組位置相容判斷。不變更 Rules、Callable export、Emulator 閘門或正式 Firebase 設定。未宣稱所有管理／採購原生 SDK 直接寫入已具備與 Service 相同的商業驗證。

## 驗收邊界

- Node：執行真實 Service／Core，驗證同訂單兩品項兩倉、凍結量、回覆遺失後新到貨、重送、競爭、角色、回滾與拒絕 SERVICE／直送／取消。
- Firestore Emulator：真實 Client SDK + 現有 StockPermissions wrapper + 現有 Rules，五角色、停用帳號、偽造前端角色、同 ID／不同 ID 競爭、原憑證衝突、v2 拒絕；未用 Admin SDK 代替客戶端授權。
- Chrome：1280／390 px 的實際兩頁 renderer、click handler、Service／Core，使用記憶體交易傳輸驗證重新載入及跨頁確認；不代表實際 Auth + 瀏覽器 + Firestore 的單一全線 E2E，也不代表 Preview 人工驗收。
- 完整結果以本批實際 CI 為準。PR #131 仍保留 Draft 作為 Rules 上限分析／反例，不移植未通過的舊寫入；其一般預留／取消需求未被本批打單涵蓋。
