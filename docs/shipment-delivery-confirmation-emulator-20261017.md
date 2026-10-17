# 出貨後的客戶送達確認（2026-10-17）

狀態：新增 Emulator-only 後端確認 Service 與共用投影；未匯出 Callable、未接前端或部署 Firebase，仍非完整正式多倉功能。

## 權威來源與責任

- `warehouseShipmentRecords` 為倉庫實際寄出事件；寄出交易才扣實貨、預留與批次。
- `deliveryRecords` 中 `sourceType=WAREHOUSE_SHIPMENT_CONFIRMATION` 為客戶送達事件，每筆指向唯一 `shipmentId`／`shipmentMovementId`；送達確認不再扣庫存。
- `Fulfillment.projectShipmentDelivery` 是此 v2 契約的唯一出貨／送達投影：逐筆核對訂單、品項、產品、倉庫、正整數量、唯一 ID、有效日期與來源事件。單筆出貨的累計送達不得超過該筆出貨，不能挪用另一倉或另一張出貨紀錄的額度；總量不得超過訂購量。
- 已寄出量、已送達量與寄出待送達量分開。全部寄出仍可尚未送達；僅累計確認達訂購量時才將 isDelivered 設為 true。
- 原 legacy INVENTORY_SHIPMENT／一般送貨、退貨與新 v2 事件不能混讀；發現混用即拒絕，不臆測或遷移。

`functions/shipment-delivery-service.js` 的 `commitShipmentDelivery` 限 demo-yushin Firestore Emulator。真正的權限來源是同交易讀取的 users：管理員可代辦，sales／engineer 限本人訂單，purchaser／warehouse 不可替代客戶送達確認。這沿用現有 role-capabilities 的商業生命週期分工，不是修改正式帳號角色。

## 提交與冪等

請求只接受 orderId、itemId、shipmentId、quantity、date、notes、operationId、syncAttemptId。必須為單品項實體倉商品，無退貨／保管／調撥進度、來源同步 completed 且 attempt 未變、訂單未取消／結案。

Service 在同一交易讀取使用者、訂單及指定寄出 movement（一般首次固定 3 份文件）。來源倉庫事件必須具有正確的固定 movementId，與實際扣帳憑證的訂單、品項、產品、倉庫、數量、批次一致；以原出貨 normalizeShipmentIntent 重建雜湊，連同原日期／備註／收件快照核對，不能捏造出貨來確認送達。客戶送達日期不得早於出貨日期。

只更新同一份 orders 文件：新增 deliveryRecords、deliveryHistory，以及品項／訂單 deliveredQty 與 isDelivered 投影。**不讀 inventory、warehouseStocks、inventoryReservations、inventoryLots 或成本集合，不新增 movement、不寫任何庫存資料**。

固定 operationId 保存在同一筆 deliveryRecord，綁定原 UID、角色、完整意圖 hash 與原確認結果。未知回覆沿用原 ID；同 ID 同意圖只回傳原結果，不重複新增，即使訂單後續取消也不恢復操作。若原確認已移除／撤銷而歷史仍有該 ID，原 ID 會拒絕，不把已撤銷送達重新建立；此批只驗證該歷史防護，不表示已實作撤銷 Service。重試仍檢查帳號有效與目前訂單所有權；換人、角色或意圖不能沿用。回覆的 already-applied 結果是原操作結果，畫面未來接線時應另刷新目前總進度。

兩個不同 ID 同時確認相同出貨，都會重讀同一訂單／來源事件；Firestore 衝突重試後仍須通過單筆剩餘額度，不能超額。同 ID 同時提交僅有一筆事件，另一筆回傳 already-applied。更新／回覆失敗可用原 ID 重試。

## 寄送與送達交錯

`commitLocationShipment` 已改共用 projectShipmentDelivery，不再將「已有客戶送達」一律拒絕。支援：

A 倉寄 2 → 客戶確認 1 → B 倉寄 6 → 確認 B 倉 6 → 確認 A 倉剩餘 1 → A 倉再寄 2 → 最後確認 2。

過程中只有三次寄出扣庫存，四次確認都不改庫存。每一步皆核對倉庫寄出及客戶送達投影，且先驗證加入新事件後的共同投影，避免超過每類 200 筆事件的安全上限後留下不可處理的來源。

## 驗收與未完成

新增測試涵蓋：實際 #136 預留→#137 分倉寄送→交錯分批送達；確認前後公司／分倉、預留、批次與 movement 完全不變；執行時限制確認只能讀 users／orders／來源 movement、只寫 orders；五角色與陌生負責人、停用、同／異 ID 併發、操作意圖衝突、未寄出／超額／日期錯誤、過期同步／取消／退貨、偽造收件資訊或扣帳憑證、投影異常及失敗回滾／原 ID 重試。

仍未完成：前端操作及 workCategories／需求投影、真正 UI 打單與端到端驗收、撤銷送達／退貨／補送、多品項、取消／恢復、收貨與保管／調撥，以及 Preview 真實操作與正式部署。送達確認只有到貨事實與出貨來源參照，不把原整筆出貨批次複製為每次部分送達的完整批次數量；後續退貨必須另完成對實際出貨／送達額度的批次追溯，不能直接套用舊退貨入口。

現行 StockPermissions／Rules 的 v2 直接寫入保護完整保留。無新集合、Query、Listener、索引宣告或正式資料遷移。

## 本機驗證紀錄

Node 1,502／1,502 通過，0 失敗。Firestore Emulator 合跑出貨／送達20、單品項預留12、分組預留5，最終37／37通過，0失敗。新增送達案例9組涵蓋多個角色、拒絕情境及併發。app與Functions Core建置一致、語法及diff檢查通過；完整Rules、Auth Callable與六組Chrome結果以本批GitHub CI／PR紀錄為準，不等同Preview真人驗收。
