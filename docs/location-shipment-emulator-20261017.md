# 指定倉分批寄送（2026-10-17）

狀態：已新增 Emulator-only 後端交易及測試；未匯出 Callable、未接前端，尚非可用的正式多倉流程。

## 責任與事件

`functions/location-shipment-service.js` 的 `commitLocationShipment` 限 `demo-yushin` Firestore Emulator。僅處理有完整所有權、已完成庫存同步、單品項、無退貨／保管／調撥進度，已送達部分必須來自新版出貨確認事件的 v2 訂單；必須為 CUSTOMER_SHIP 且收件資訊與操作人確認的快照完全相同。

- 原 `modules/reservation-core.js` 的 `planReservationIssue` 決定公司／指定倉實貨與預留差額，保留其他倉預留。
- 原 `modules/inventory-core.js` 的 `allocateLots`／FEFO 決定實際批次；`reconcileStockLots` 僅驗證現有批次不超過實貨，不寫入它產生的未分批提案，不猜測成本。
- `modules/fulfillment-core.js` 新增 `warehouseShipmentState`，以既有 dispatchState 演算法計算累計打單可用量，輸入消耗事件明確為 warehouseShippedQty。原客戶交付 dispatchState 不變。
- 原 `modules/warehouse-logistics.js` 的 plan／validatePlan 驗證配送資訊。它與其餘 Core 一樣由 build-functions-core 產生部署副本；Node 載入時在沒有 document 的條件下返回純 API，不執行 UI 區段，禁止手改副本。

權威倉庫寄出事件為 `orders.warehouseShipmentRecords[]`，每筆以 id 保存 operationId，並含實際 warehouseId、qty、日期、收件快照、lotAllocations、操作者與 movementId。`items[].warehouseShippedQty` 僅為事件加總投影，交易核對一致性；**不是客戶已送達量**。

不修改 `deliveryRecords`、`deliveryHistory`、`deliveredQty`、`isDelivered`。完成所有倉庫寄出後，客戶送達仍保持原狀。新事件的 sourceType 為 WAREHOUSE_CUSTOMER_SHIPMENT，不冒充既有 INVENTORY_SHIPMENT 交付紀錄。v2 預留的 fulfilled 只代表該預留實貨已出清，不表示客戶已簽收或訂單已結案。

## 原子性、權限與重送

同一 Admin Transaction 讀取 users 角色／停用、固定 movement 憑證、來源訂單、產品、公司帳、指定實體倉及庫存、v2 預留與批次，全部驗證後才一起更新：

1. inventory 與指定 warehouseStocks 的 onHand／reserved。
2. 原 inventoryReservations 的 locations／quantity，維持其他倉不變、不放回舊 warehouseId。
3. 真實 inventoryLots.remainingQty。
4. 訂單的 warehouseShipmentRecords、品項 warehouseShippedQty／reservedQty 及最後一筆寄出 ID。
5. 固定 `inventoryMovements/location-ship-{operationId}`。沿用既有集合，以同一 movement 保存操作意圖 hash 與結果供重送核對，不增加第二份憑證集合。

角色限實際 admin／purchaser／warehouse；sales／engineer 不可繞過。相同 ID 比對原 UID、角色、來源同步、倉庫、數量、日期、備註與正規化收件資訊；重送只確認原結果，不重扣或覆蓋後續取消。來源新操作須同步 completed，且 syncAttemptId 仍為目前來源 ID。批次及事件一律先讀後寫，失敗整筆回滾。

一般首次交易為 8 份固定文件讀取及一個批次 Query；Query 在 Admin Transaction 內按產品／倉庫查詢，含零餘量最多讀 201 份，超過 200 份拒絕。沒有無界查詢；不讀成本集合，公開事件／結果成本為零並標示 costPending，不把零當作真實進貨成本。最多更新 200 批次及 5 份固定文件。不修改 Rules、索引宣告、使用者權限或正式資料。Preview 的索引可用性仍需另驗證，不能以 Emulator 代替。

## 驗收與限制

新增測試：A→B→A 分批及 FEFO、其他倉／其他訂單預留保留、三角色允許及兩角色拒絕、固定 ID 重送與意圖／身分衝突、相同／不同 ID 同倉併發、跨倉同時出貨、打單不足、指定倉不能挪用、來源同步／取消／退貨／服務／保管／停用／收件資訊／投影異常、無批次／負餘量／超帳、201 批次上限、晚期寫入失敗回滾及原 ID 重試。斷言倉庫已寄完時客戶送達量仍為零且不標完成。

測試前段使用 #136 真正的雙倉預留交易；完成同步及打單量由測試資料明確設置，不宣稱已驗收前端打單流程。

待完成：

- 新 warehouseShipmentRecords 尚未接入所有前端、workCategories、採購需求及訂單顯示投影；既有前端 INVENTORY_SHIPMENT 的交付記帳不能與此新事件混用。
- 後續已新增 Emulator-only 客戶送達確認及交錯寄送，詳見 shipment-delivery-confirmation-emulator-20261017.md；仍無 UI／Callable／Preview 入口。
- 多品項、退貨／補送、撤銷、取消／恢復、收貨、保管與調撥仍須整合共同位置契約。
- 必須完成所有讀寫入口與 Preview 全流程後才可開放；現行 StockPermissions／Rules 的 v2 寫入阻擋完整保留。

## 本機驗證紀錄

Node 應用測試 1,497／1,497 通過，0 失敗。Java 21／Firebase CLI 15 的 Firestore Emulator 合跑本批 11 案例、原單品項預留 12 案例及原分組預留 5 案例，共 28／28 通過，0 失敗。生成一致性與 diff 檢查通過。完整 Rules、Auth Callable 及桌機／手機六組 Chrome 尚待本批 GitHub CI，不能將本機交易案例當成 Preview 操作驗收。

## v2 打單實際交易（2026-10-17，僅 Emulator）

新增 `functions/location-dispatch-service.js`，將過去 Emulator 測試直接覆寫 `dispatchPreparedQty` 的捷徑改為同交易打單事件。由 Admin SDK 重讀 users／orders／inventoryReservations，沿用 `projectShipmentDelivery`、`warehouseShipmentState` 計算待打單與累計寄出，確保 A 倉寄出後、B 倉尚未打單的 6 件不能提前寄送。真正再打單只增加 `dispatchPreparedQty` 並寫入既有 `dispatchRecords/v2-{operationId}`，不讀寫實貨、lot、reserved 及送達記錄。同 operationId／同意圖重送不會增加打單量；來源同步、角色、取消單、退貨、v2 預留／訂單投影不符會拒絕。與 `commitLocationShipment` 相容但仍無 Callable／前端入口；初始預留同步 checkpoint 在 fixture 尚為人工模擬，完整工作清單與退貨補送入口仍待整合。無正式 Firebase 部署、索引、Rules 或資料遷移。
