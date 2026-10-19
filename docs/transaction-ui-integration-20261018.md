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
| 客戶退貨實收／訂錯貨重下單 | customer-cancellations → customer-return Service 的 commitCustomerReturnReceipt／commitCustomerReturnHoldRelease；order-creation → commitOrderCreation | 既有 CLOSE 實收、批次追溯、獨立一般新訂單；實收與待檢轉庫存的原 writer 已移入 src/services/customer-return.js | 退貨申請／撤回及取消採購處置仍有 Feature 直接交易，後續需沿用既有 writer 整理；v2 Auth return adapter 只在隔離 Emulator，沒有正式 Callable |
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


## 第二批：退貨實收與待檢轉庫存 Service 接線

將原 postCustomerReturnStock、assertActiveReturnWarehouse、commitCustomerReturnReceipt 搬入 src/services/customer-return.js；原待檢轉庫存的 Transaction 搬入同一 Service 的 commitCustomerReturnHoldRelease。兩個原 UI action 保留原按鈕、提示及刷新，不再編排該動作的 stock transaction。建置清單載入唯一 Service；modules/customer-cancellations.js 在 app.js 後載入，原採購改送實體倉庫仍共用同一倉庫檢查。未建立第二份退貨或批次公式。

原正常商品使用 delivery-stock／Inventory Core 的原批次退回與 CLOSE 自由庫存邏輯，直送退貨沿用原採購追溯與批次來源。申請、撤回及取消採購保留／改送仍在原模組，尚未宣稱所有 Features 寫入完成清理。資料模型、Rules、Index、Callable 與 v2 執行閘門不變。

新增真實 Client SDK＋StockPermissions＋Rules 的 Service 驗收：三個收貨角色實收及同 ID 重試；HOLD 不入庫而轉庫存只入一次；停用倉庫整筆拒絕；業務／工程師即使偽造前端 capability 也無法建立實收憑證。Node 驗證唯一 writer、無 DOM Service、hold-release 原子回滾與防重。Chrome 1280／390 px 跑原 receiveCustomerReturn click handler 與實際 Service／Inventory Core，使用記憶體交易傳輸驗證待檢及回覆遺失重送；不等同完整 Auth／瀏覽器／Firestore 單線 E2E 或 Preview。


## 2026-10-19 退貨申請／撤回與採購保留入庫介面接線

原 modules/customer-cancellations.js 的三個交易 writer 移入既有 src/services/customer-return.js：saveReturnRecord → commitCustomerReturnRequest、withdrawCustomerReturn → commitCustomerReturnWithdrawal、keepCancelledPurchaseAsStock → commitCancelledPurchaseKeepStock。Feature 保留原輸入、確認、pending 鎖、固定操作 ID、提示與 cache 刷新，已無 runRoleTransaction 或直接 tx 寫入。退貨實收／待檢轉庫存仍沿原 Service，未新增第二個 writer、畫面或操作步驟。

customerReturnPendingQty 原計算原樣移入 Service，不新增退貨額度公式。申請重送核對既有 request 的 ID、item、qty、date、reason、settlement、createdByUid；即使原申請之後已部分實收或撤回，也只回原結果，不再新增。錯誤內容不能沿用原 ID。撤回只關閉原申請未收餘量，保留 receivedQty 與 returnRecords；已完成／已撤回重送不重寫時間。三動作在交易讀取前後、寫入前及回覆前核對目前帳號／前端角色與 capability；真正身份、停用、所有權與作業權限仍交由原 StockPermissions／Client Rules，不以 capability 取代授權。

KEEP_STOCK 沿原採購決策／來源及倉庫驗證。原直送轉原選定實體倉只登記尚未到貨 incoming 與原 redirect movement，不增加 onHand 或預留；沿原 runRoleTransaction 原子同步 receivingSupplyOrders，重試不重複登記。沒有新資料庫查詢、持久欄位、Collection、Index、Rules 或 Listener。

新增六項 Node 行為測試、五項真實 Client SDK＋StockPermissions＋Rules 測試，涵蓋額度、原 ID 意圖／帳號、30 次上限、部分實收撤回、帳號／角色變更、回覆遺失及末端回滾；Client Rules 驗證五角色／偽造 capability、同 ID／超額競爭、停用與外人、部分實收撤回以及 KEEP_STOCK 原子來源／接收鏡像／在途。既有 1280／390 px Chrome suite 擴充原三個 click handler → 真實 Service，驗證未知回覆重試與 incoming 不重複。Chrome 為記憶體傳輸，不是完整 Auth Browser／Firestore 單線 E2E。

本地 Node 1566/1566、建置同步／語法／diff 通過；新增 Client Rules 與 Chrome 以本批完整 CI 為準。本批接線為原一般介面，v2 多倉正式 Callable／UI 閘門不變，沒有 Firebase 部署或正式資料寫入。v2 正式傳輸、Preview 及完整真實登入端對端驗收仍待後續整合。

本批 Client Rules 實測也確認既有一般申請的限制：同 ID 並行 proposal 可能有一方先被 Rules 拒絕（包含既有 expression 上限），而非由 Client SDK 自動重跑。測試保留並辨識該拒絕，確認至少一方提交成功、整單只有一筆申請，再以原 ID 讀回原結果而不寫第二次。這不代表 Rules 上限已解決；UI 沿用原 pending 鎖及未知回覆保留 ID，不盲目換新 ID。
