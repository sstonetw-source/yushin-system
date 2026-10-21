# DATA_MODEL — Firestore 集合與資料責任地圖

版本：2026-10-15。來源：`firestore.rules` 實際 match、`firestore.indexes.json` 與程式引用；不是資料庫內容或正式環境實際部署狀態。對應 `docs/BUSINESS_RULES.md` 與 `docs/system-architecture-20260923.md`。

## Firestore 集合（規則中實際宣告）

### 正式採購的補貨需求識別（2026-10-16）

- 安全庫存補貨：procurementDemands/STOCK_REPLENISHMENT:{inventoryId} 是跨採購單的共享需求文件，正式 PO transaction 必須先讀後寫，沿用當下的訂購／收貨累計。
- 手動直接庫存採購：每個採購品項使用 procurementDemands/STOCK_REPLENISHMENT:MANUAL_PO:{poNo}:{lineIndex}；supplyOrders.sourceId 必須和需求的 sourceId 一致，PO 以原始品項快照做重試核對。此為新增資料契約，未遷移歷史紀錄。
- 本批未新增 Firestore 集合、索引或 Rules，也不更動正式資料庫。

### 庫存設定操作憑證（2026-10-16）

`auditLogs/{operationId}` 新增 action `inventory_policy_set`，欄位限定為 action、inventoryId、actorUid、actorRole、stockPolicy、safetyStock、previousStockPolicy、previousSafetyStock、changed、createdAt。Rules 核對原值、同交易後值及角色；不新增 inventory 欄位。既有清單 archive／restore audit 額外記 actorRole／changed，無變更也新增憑證但不更新 inventory。管理員仍有既有 audit 刪除權，不宣稱對管理員不可竄改。

Rules 新增管理員／採購對「不存在 audit ID」的單筆 get；未開放其他角色或全表 list。正式版別／已部署規則未確認；應用與這次 Rules 來源須成套上線，不能只部署新 bundle。沒有集合、索引或正式資料遷移。

下表列出目前 Rules 中的所有資料集合，**包含歷史相容與支援集合**。歸類為維護責任，並不代表可互相直接讀寫或所有功能已完成驗收。

| 集合 | 主要責任 |
|---|---|
| `users` | 帳號角色、業務身份、登入後個人資料；權限受 Rules 約束 |
| `settings` | 系統全域設定、維護旗標 |
| `brands` | 正式廠牌主檔 |
| `productLines` | 產品線主檔 |
| `salesCodes` | 業務代號／交接 |
| `customers` | 客戶主檔 |
| `suppliers` | 供應商主檔 |
| `brandSupplierMappings` | 廠牌與供應商對應 |
| `warehouses` | 倉庫及位置主檔 |
| `products` | 正式產品主檔 |
| `productCosts` | 受權限保護的成本主檔 |
| `priceHistory` | 價格與成本變更歷史 |
| `quotes` | 估價單 |
| `forecasts` | Forecast 商機 |
| `orders` | 客戶訂單及品項／部分交付與退貨歷史 |
| `purchaseOrders` | 採購單與採購文件 |
| `purchaseOrderCommunications` | 採購單傳送記錄 |
| `procurementDemands` | 訂單／備庫需求投影；不得反向當成實體庫存 |
| `supplyOrders` | 對供應商下訂、在途及收貨累計 |
| `receivingSupplyOrders` | 對授權收貨角色提供的去成本供應投影 |
| `stockTransferRequests` | 調撥申請 |
| `stockTransfers` | 實際調撥與在途、點收進度 |
| `inventory` | 公司彙總庫存帳 |
| `warehouseStocks` | 分倉庫存帳 |
| `inventoryReservations` | 客戶訂單品項預留帳 |
| `inventoryLots` | 批次實貨與效期 |
| `inventoryLotCosts` | 批次成本（受權限保護） |
| `customerReturnReceipts` | 客戶退貨收貨憑證 |
| `receipts` | 採購到貨憑證 |
| `externalDispatchNotices` | 對外倉送貨通知 |
| `dispatchRecords` | 打單／出貨記錄 |
| `deliveries` | 交付事件（需與訂單中 deliveryRecords 欄位分清用途） |
| `pendingInventoryItems` | 暫待處理的庫存項目 |
| `inventoryMovements` | 庫存異動明細／來源憑證 |
| `stockOperations` | 安全交易的操作證明（Rules 檢查） |
| `reservationOperationReceipts` | 僅後端 Cloud Functions 可建立與讀取的雙倉預留原子操作憑證／冪等 checkpoint；尚未啟用 |
| `auditLogs` | 系統稽核記錄 |
| `equipment` | 儀器、保養與維修管理 |

## 事件與權威邊界

1. **客戶承諾**：`orders.items` 的訂購量與品項身份為權威；`procurementDemands` 是由需求、預留及供應累計導出的**投影**。
2. **實體數量**：`inventory` 公司總帳與 `warehouseStocks` 分倉總帳需同交易守恆；`inventoryLots` 是批次細節，`inventoryReservations` 是預留，不是實貨。
3. **供應事件**：建立 `purchaseOrders`／`supplyOrders` 不能直接增加 onHand；只有驗證過的 `receipts` 才可轉為入庫數量。
4. **物流事件**：`dispatchRecords` 與 `deliveries` 不能互當；`orders.deliveryRecords` 及 `orders.returnRecords` 對有效交付的計算須共用 `YushinFulfillment`。
5. **權限**：成本權限不能只靠畫面隱藏；`productCosts`、`inventoryLotCosts` 與直送去成本投影須分離。Firestore Rules 是最終存取邊界。
6. **冪等性**：交易憑證（如 receiptId／attemptId）要能在重試時判斷已完成，不能單憑 UI 停用按鈕。
7. **多倉限制**：現行 `inventoryReservations` 仍以單一位置為主要相容表示；位置 ledger 的規劃**尚未全面啟用**，不能把規格文件視為正式交易已支援。
8. **服務商品**：`products.productType = 'Service'` 可作主檔類型，但「不使用實體庫存／不建立虛擬採購在途」需貫穿訂單、收貨、完成服務和 Rules，目前尚需實作／完整驗收。

## 索引與檢查

- `firestore.indexes.json` 目前宣告 48 個 composite indexes，分布於 15 個集合（資料結構靜態盤點值；部署是否完成另查）。
- `tests/data-model-contract.test.js` 會對照本清單與 Rules 的 match，並檢查索引都對應已宣告的集合；新增集合時應更新此表。
- 權限及跨文件約束另由 `tests/firestore-rules.test.js` 在 Firebase Emulator 驗證；表格本身**不保證安全或資料正確性**。

## 未完成資料模型工作

- 正式比較 `orders.items`、收貨、退貨、調撥及現貨分配所有寫入路徑是否遵守單一權威契約。
- 建立同品項多倉位置分拆與保管移轉的交易／Rules／Emulator E2E，再決定是否移除單倉欄位。
- 服務商品完整不入庫契約、完成及核銷狀態。
- 舊相容欄位的引用計數、資料遷移程序、索引清理及 Preview 測試。
- 正式 Firebase 已部署 Rules、索引狀態、五角色完整驗收皆不由此份靜態清單推定。

## 收貨 actor 快照（2026-10-16，已實作）

新 `receipts` 保存 `createdByUid`、`createdByRole` 作為操作識別碼重試的身分快照，沿用既有不可變 receipt facts；Rules 仍只允許修改分配進度欄位，不新增集合、索引或查詢。舊憑證缺此二欄時不補寫、不遷移，仍核對供應單／數量／批號／效期。瀏覽器背景到貨暫存新增 `actorRole`，不是 Firestore 的另一份交易事實。

收貨來源驗證補強：`supplyOrders` 的來源與入庫倉庫不可由 UI 預設值猜測；`orders.items`、`inventoryReservations` 與公司／分倉投影不符時 Service 整筆拒絕，不能用新增收貨掩蓋差異。沿用原集合與欄位，無資料模型遷移；真正獨立備庫及舊版未登記 incoming 仍按既有收貨契約處理。

## 建單共用提交（2026-10-16）

沒有新增 Firestore 欄位、集合、Rules 或索引。Forecast 多品項沿用 `orders.sourceType/sourceId/sourceDocumentSyncStatus` 與 `forecasts.linkedDocuments`，由同一 transaction 提交。瀏覽器新增 `${ORDER_DRAFT_STORAGE_PREFIX}:${uid}:forecast:${forecastId}:pending_order_id` 暫存以接續未確認建單；它不是雲端交易事實，也不提供跨裝置去重。手動／估價轉單保留原 pending ID key。沒有正式資料遷移或刪除。

## 盤點操作憑證（2026-10-16）

數量盤點改以 operationId 作為 `inventoryMovements` 文件 ID，沿用 `type:adjustment`、`sourceType:manual`、`sourceId:operationId`、`operation:quantity-editor`，新增 `countInventoryId`、`countTarget`、`actorUid`、`actorRole` 以核對同 ID 重試。備註仍使用 `note`。盤點無差量也保存 `qty:0` 的憑證，庫存／批次不變；盤盈未分批仍無成本文件，不把未知成本當成已確認零成本。

既有 movement 不遷移，Rules 仍禁止 movement update；無新增集合、查詢、索引或 Rules。pending 作業僅保留於目前視窗記憶體，非可跨裝置恢復的佇列。新 Service 讀到既有同 ID 不符憑證時拒絕，不補寫舊格式資料。無正式資料修改／刪除或部署。

## 人工庫存操作憑證與批次投影（2026-10-16）

新增／調整／報廢的 movement 使用 operationId 作為文件 ID，`operation:manual-adjustment`、`sourceType:manual`、`sourceId:operationId`、`actorUid/actorRole`，以及不含成本的 `adjustmentIntent:{type,productKey,warehouseId,delta,lotNo,expiryDate}`；保留 `type/qty/lotId`，扣減另存 `lotAllocations`。新 lot ID 固定為 `${operationId}-added`，必要歷史未分批餘額為 `${operationId}-balance`，沿用 INITIAL_STOCK／MANUAL_ADJUSTMENT／MANUAL_STOCK_BALANCE 類型。

初始成本沿用 `inventoryLotCosts`，有成本權角色寫 unitCost，倉管寫 costPending；重試核對不將成本放入公開 movement。`inventory.lots` 於人工異動入口由產品各倉已讀的權威 lot 投影成 `{warehouseId,lotNo,expiryDate,qty}`，不再直接加減；其他既有入口的列表鏡像刷新尚待統一，不能將鏡像當成庫存對帳依據。

新增每產品 bounded lot 查詢（最多 201 筆，超過 200 拒絕），使用既有單欄索引；無新集合／Rules／composite index／Listener。瀏覽器列新增 operationId 以接續同視窗重試，無資料遷移或正式資料更動。

## 庫存清單批次讀模型（2026-10-16）

無新 Firestore 欄位、集合、Rules 或 composite index。批次顯示直接讀 inventoryLots 的 productKey／warehouseId／lotNo／expiryDate／remainingQty／receivedAt，以真正文件 ID 為識別；唯讀白名單投影不包含成本。群組頁面、cursor、載入錯誤與完整性僅保留記憶體，角色切換清除，未持久化。

新增單欄查詢：productKey in 最多 30 值，單次 101 文件 lookahead；完整 lotNo 等值／YYYY-MM-DD expiryDate 等值各 51 文件 lookahead；命中產品以 inventory.productKey in 批讀。全部沿用既有自動單欄索引，不需要部署新 composite index。舊 inventory.lots／批號 searchTokens 不遷移或刪除；目前清單與後驗證不再依它們判斷批次命中，舊 tokens 仍可能增加索引候選讀取。

## 後端預留操作憑證（待 Preview 驗收）

`reservationOperationReceipts/{grouped-attemptId}`：Cloud Functions Admin SDK 管理的交易冪等 checkpoint，保存來源訂單、actorUid／actorRole、意圖雜湊、產品、公司 reserved 差額、各倉及預留 ID。Rules 明確拒絕所有客戶端讀寫；不新增集合索引。此端點預設停用，正式資料不存在遷移及資料填補。新端點限同產品不同品項分兩倉，未實作單品項 v2 多位置 ledger。

## Emulator-only 單品項雙倉 v2 提交（2026-10-17）

沿用 `inventoryReservations/{orderId}__{itemId}`：locationSchemaVersion=2、locations 為各倉正整數 reservedQty、quantity 為總量，舊 warehouseId 從 v2 預留文件移除。訂單品項只保存 reservedQty／shortageQty 投影，warehouseId 保留為來源提示。公司與分倉 reserved、ledger、品項、movement 及 `reservationOperationReceipts/single-v2-{attemptId}` 一起提交；receipt 保存 UID、角色、來源同步 ID、意圖 hash 與原結果。無新集合或索引，不變更 onHand／批次／供應。僅 demo-yushin Emulator 可執行，未遷移任何正式資料或開放 v2 客戶端寫入。

## Emulator-only v2 倉庫寄出事件（2026-10-17）

新 `orders.warehouseShipmentRecords[]` 是實際寄出權威，包含 operationId、warehouseId、qty、lotAllocations、收件快照、actor／movement；items.warehouseShippedQty 是其加總投影，交易需核對。沿用 inventoryMovements 的固定 location-ship-{operationId} 文件保存扣帳與重送意圖／原結果，不新增集合。公司／指定倉 onHand與reserved、原v2預留、真實批次及寄出事件一起提交。客戶 deliveryRecords／deliveredQty／isDelivered 不變，未提供簽收入口。此資料只允許 demo-yushin Emulator，workCategories及現行前端／需求尚未讀取新事件，不可部署或混寫正式資料。

## Emulator-only 送達確認的出貨來源（2026-10-17）

`deliveryRecords[].sourceType=WAREHOUSE_SHIPMENT_CONFIRMATION` 新增 shipmentId／shipmentMovementId，對應原 warehouseShipmentRecords 與真實扣帳 movement；qty為本次確認量，不是再出庫量。原UID／角色、意圖hash與結果同 deliveryRecord 保存，無新憑證集合。訂單與品項 deliveredQty、isDelivered 是確認事件的投影，warehouseShippedQty仍只來自出貨事件。每類事件最多200筆，跨倉／部分確認使用同一核心投影核對，禁止混用舊交付事件。確認只更新orders，不觸碰實貨、預留、批次或成本；部分送達的退貨批次歸屬仍需後續完成，不把整筆原出貨的lotAllocations錯複製到每筆部分確認。

## Emulator-only 送達撤銷識別與批次追溯（2026-10-17）

deliveryHistory 的 shipment_confirmation_reversal 事件以operationId識別本次撤銷、recordId指向原確認，保存before／原因／actorUid／actorRole／intentHash／原結果；確認紀錄移除後仍能阻擋舊ID恢復。只改orders送達投影，warehouseShipmentRecords／實貨／預留／批次不變。退貨追溯不保存新資料，只讀原出貨movement及明確inventoryLots，回傳canCommit=false的lotRestorationPreview；沒有新collection、query、index或正式資料遷移。

### v2實物退貨事件（2026-10-17，Emulator）
`orders.returnRecords[]` 新增 sourceType=WAREHOUSE_CUSTOMER_RETURN，包含原 shipmentId、原 warehouseId、明確 lotAllocations、qty、date、reason、condition=RESTOCKABLE、settlement、actor UID／role、intentHash 及固定 movementId。`inventoryMovements/location-return-{operationId}` 保存完整 returnRecord／原 result；returnHistory 保存新增快照。同交易還原 inventory／warehouseStocks.onHand、inventoryLots.remainingQty，REPLACE 才增加原倉 v2 reservation.locations 與公司／原倉 reserved。returnedQty 是累計實物退回；deliveredQty／warehouseShippedQty 保持歷史累計，isDelivered 由 `projectShipmentReturns` 判斷 CLOSE／REPLACE 後有效履約。未改成本集合、Rules／Index 或正式資料。

### 退貨後一般重新下單（2026-10-17）
新 orders 可含 `returnReorderSource:{orderId}` 單向查核關聯；不設定 quote／forecast 的 sourceType／sourceId 或來源同步完成，也不自動寫原單 backlink。新單金額／品項重新輸入，庫存預留與收款採正常新單初始值，不能複製原單履約／收款欄位。commitOrderCreation 驗證同客戶、可讀所有權及來源存在已實收CLOSE，且 pending ID 重送不可換來源。來源備註可編輯，結構化關聯獨立保存。

## v2 打單準備憑證（2026-10-17；僅 Emulator）

使用現存 `dispatchRecords` Collection，不新增集合與索引：`dispatchRecords/v2-{operationId}` 只保留打單事件 `action=location_dispatch_prepared`、`orderId`／`itemId`／`productKey`、`qty`、`actorUid`／`actorRole`、`ownerUid`／`salesCode`、`syncAttemptId`、`intentHash`、`createdAt`、`result`，權威累計仍為原訂單品項的 `dispatchPreparedQty`。來源訂單品項更新與憑證同一 Admin SDK Transaction；庫存與保留位置及客戶送達均不寫入。固定 ID 重送只回原結果、不消耗新的打單預算。此資料結構未接既有 UI、Cloud Callable、正式 Firestore Rules 或工作清單；不可對正式資料進行混用。

## v2 取消／恢復操作憑證（2026-10-17，Emulator-only）

沿用既有 `inventoryReservations/{orderId}__{itemId}`，取消時寫入空的 `locations=[]`、`quantity=0`、`shortageQty=0`、`status='released'`，以及保留兩個來源候選倉的 `lifecycleWarehouseIds`（防止取消後丟失可恢復位置）；恢復時由最新庫存重新產生 `locations` 與 shortage。沒有建立第二份預留 ledger。原 `orders.items[].reservedQty/shortageQty`、`orders.status/orderStatus`、`inventory.reserved` 與逐倉 `warehouseStocks.reserved`、`inventoryMovements`、`reservationOperationReceipts/single-v2-lifecycle-{operationId}` 同一 Admin SDK Transaction 更新。Receipt 保存 actor UID／role、意圖 hash 與首次提交結果，供重試不重放；不新增集合或索引、不改 Rules。現行前端、正式 Firestore 不支援此 v2 寫入，尚未上線。

### v2 取消／恢復的採購需求補充（2026-10-17，僅 Emulator）

現行 `procurementDemands` 的權威鍵為 `encodeURIComponent('SALES_ORDER:'+orderId+':'+itemId)`（例如 `SALES_ORDER%3AO%3AI`），與一般訂單需求讀寫相同；v2 Service 不再讀取原樣未編碼 ID。僅當 `orderedQty=receivedQty=remainingToReceiveQty=0` 且角色、來源、產品、倉庫、狀態及待採購投影有效時，同個 Admin SDK Transaction 更新既有 `status/remainingToOrderQty/remainingToReceiveQty/perOrdered/perReceived/sourceItemIndex/updatedAt`，或在恢復且缺口大於零時新建 `YushinProcurementDemand.demandDocument` 格式文件；原始 `requestedQty` 在取消時保留。跟公司與兩倉 reserved、單一 reservation ledger、訂單狀態與重試 receipt 一起原子提交；不修改或臆測任何 supplier order／receipt 歷史。未新增索引、Rules、集合或正式遷移。

### v2 部分交付後的取消／恢復（2026-10-17，僅 Emulator）

不新增欄位或集合。權威 `warehouseShipmentRecords`、`deliveryRecords` 及對應 shipment movement 重新驗證，items[].warehouseShippedQty／deliveredQty、orders.deliveredQty／isDelivered 必須一致。原訂購量、累計打單／出貨／送達與履約歷史保持原值；單一 reservation ledger 及 orders.items[].reservedQty／shortageQty、公司／兩倉 reserved、逐倉 movement、原 receipt 與 canonical encoded 採購需求仍同交易提交。恢復以未交付量重新配置，不修改 inventory／warehouseStocks.onHand 或 inventoryLots。取消狀態表示停止剩餘需求，並非抹除已完成交付。UI／查詢投影與完整 Preview 尚未驗收。

### 未到貨供應的 v2 生命週期核對（2026-10-17，Emulator-only）

供應承諾權威沿用 supplyOrders（非 receivingSupplyOrders 查閱投影）；以 orderId／canonical demandId 的單欄條件查詢各 limit(51)，聯集合併 doc.id、最多接受 50 筆，不接受呼叫端自行提供供應清單。與 orders.items[].supplyOrderedQty、零 receivedQty 及 procurementDemands.orderedQty／receivedQty 核對；正式採購逐筆驗證 purchaseOrders.supplyOrderIds 對應 items 的訂單、品項、產品、入庫倉及數量，讀同一 PO 時共用快照。使用現有 supplyContribution／reconcileLinkedSupplies 排除已停止供應的未到貨部分。已登記 incoming 加總只核對不改帳；不把採購在途當實貨。取消／恢復仍僅更改原訂單、預留／movement／receipt 與採購需求投影，保留供應及 PO 原貌。未新增欄位、集合或索引，未遷移正式資料。

### v2 來源收貨文件（2026-10-17，僅 Emulator）

正常收貨仍使用單一 `inventoryReservations/{orderId}__{itemId}`：保留 locationSchemaVersion=2、locations（其他倉原量不變），quantity／shortageQty 由同一 Core 更新，不新增 warehouseId。取消中收貨不改 reservation。公司及實際收貨倉 onHand／reserved／incoming、orders.items[].receivedQty／reservedQty／shortageQty／receiptEvents、supplyOrders 收貨進度、procurementDemands 收貨投影、原 receipts／inventoryLots／inventoryLotCosts／inventoryMovements 同交易提交；其他倉僅讀取驗證，無寫入。

原 receipts 新增 `reservationLocationSchemaVersion:2`（只有 v2 收貨寫入），供冪等重送使用相同 Emulator／真角色閘門；lotId、批號、效期、actor 與固定 receipt operationId 沿用原欄位。倉管成本仍只寫 costSourceSupplyId，不由前端產生採購單價。無新增 collection／index／Rules。自由庫存後續分配仍使用既有 receipt checkpoint；未宣稱 v2 對其他缺貨訂單的第二階段分配已完成。

### 已收貨生命週期的權威證明（2026-10-17，Emulator-only）

不新增欄位或集合。原 receipts（orderId／demandId 聯集最多 50 筆）核對 supplyOrderId、v2 位置標記、來源訂單／品項／產品／倉、PO、method、qty 與 cumulativeReceivedQty；由 receiptId + type=receipt 查唯一 inventoryMovements（limit 2），按 receipt.lotId 讀原 inventoryLots，核對來源、原入庫數量與仍合法的 remainingQty。已出貨消耗的 lot 可為零，不把剩餘量誤當歷史收貨量；不讀受保護 inventoryLotCosts，不改批號／成本／receipt。

逐供應累計憑證與 supply.receivedQty 相等，再由既有 Demand Core 與 orders.items[].receivedQty／採購需求交叉核對。CANCELLED／CLOSED 供應仍保留已收部分的 ordered contribution；已全收的 supply 不因 PO 因其他餘量結案而遺失。取消／恢復只原子更改訂單、預留、reserved、生命週期 movement／receipt 及需求投影。新增 bounded receipt／lot／入庫 movement 讀取，未新增索引定義／Rules／正式資料遷移。

### 出貨後收貨的計算 context（2026-10-17，Emulator-only）

無新持久欄位。`warehouseShipmentContext` 僅為 Core 呼叫參數，包含 orderId／itemId／productKey 與既有 warehouseShipmentRecords／deliveryRecords，不寫入 items。Fulfillment 回傳 unshippedQty；Workflow 在此明確 context 回傳 stockOutstandingQty／pendingDeliveryQty，outstandingQty 保留待客戶確認語意。舊 Core 呼叫的回傳格式維持相容。

原 receiving transaction 新增逐筆原出貨 movement 讀取（沿用最多 200 筆出貨的 Core 上限），核對 `location-ship-{shipment.id}`、action/type、來源、倉庫、負 qty 與 lotAllocations；不更動出貨／送達／既有批次配置，不讀既有受保護成本。無新查詢、索引、集合或 Rules；採購顯示用同一既有紀錄投影。

### 雙倉自由庫存自動分配 checkpoint（2026-10-18）

`reservationOperationReceipts/single-v2-free-batch-{runId}` 新增 Emulator-only 協調進度文件。它是工作執行 checkpoint，**不是實體庫存權威**；欄位包含 action、actorUid、actorRole、intentHash、productKey、warehouseId、maxQty、allocatedQty、processedSteps、pending、status、createdAt、updatedAt 及完成原因。pending 保存 orderId、itemId、syncAttemptId、quantity、固定 operationId。每步真正變更由既有 `inventoryMovements/single-v2-free-{operationId}` 證明；相同 operationId 重送不重扣，job 進度在獨立 checkpoint transaction 內做單次累加。沒有新增 collection、Rules 或索引；全部 Admin SDK 寫入嚴格限制 `demo-yushin` Emulator。待 Preview 正式啟用前需處理大型候選索引、checkpoint 清理政策與完整身分入口。

原 v2 初始提交 Service 在相同 `inventoryReservations/{orderId}__{itemId}` 內保留 canonical `lifecycleWarehouseIds`（排序後兩個真實候選倉）；即使 quantity=0、locations=[] 也能在後續缺貨自由庫存分配時驗證位置授權。此欄不是第二套庫存 ledger，也不會增加 inventory 或 reserved 數量；舊資料不補寫。

### v2 reservation FIFO 日期來源（2026-10-18）

既有 `inventoryReservations/{orderId}__{itemId}` 在初始 v2 單品項預留時，可依實際來源 `orders` 的有效 orderDate、date 或 createdAt 儲存 `orderDate: YYYY-MM-DD`；已存在的有效優先順序日期在相同 Ledger 重送時保留，無日期不偽造。此為排序快照而非第二份權威訂單日期。現有 productKey＋status 索引查詢透過 DocumentSnapshot 游標分頁，不新增 Collection、Index 或 Rules；>500 個候選的自動分配仍需後續索引式高流量策略。

### v2 取消／CLOSE 退貨的自由庫存來源欄位（2026-10-18）

沿用原 `inventoryMovements`：單品項雙倉取消的原 `single-v2-life-...` release movement（signed qty<0），在同一 transaction 記錄 `v2FreeStockSource:'CANCELLED_ORDER_RELEASE'` 與 `freeAllocationQty:-qty`；RESTOCKABLE 且 CLOSE 的原 `location-return-...` receipt movement（qty>0）記錄 `v2FreeStockSource:'CLOSED_CUSTOMER_RETURN'` 與 `freeAllocationQty:qty`。REPLACE 和恢復不標記。不額外維護實體數量；不同來源 movement 的進度透過既有 deterministic runId + `reservationOperationReceipts/single-v2-free-batch-...` 保存。歷史資料不回填；正式庫存未遷移。

### v2 到貨配貨來源使用現有原子證據（2026-10-18）

v2 到貨自由實貨**不新增欄位／Collection**。既有 `receipts/{receiptId}` 的 `reservationLocationSchemaVersion=2`、`autoAllocationQty`、`sourceOrderStatus`、`lotId`，與原 `inventoryMovements` 中 `sourceType=SUPPLY_ORDER`、`type=receipt`、`receiptId`、實體 `inventoryLots/{lotId}` 的來源及數量一致，組成可稽核的唯一收貨配貨來源。Cancellation KEEP_STOCK 需原 supplyOrders 核定證據。以原 movementId 推導既有 deterministic `reservationOperationReceipts` 分配進度，不新增快取持有權威實貨，無 Firestore Rules／索引更動或正式部署。

### Post-commit 分配續傳輸出契約（2026-10-18）

新 `drainReleasedV2FreeStock` 不新增 Collection／數量權威，而是讀取原 `inventoryMovements/{movementId}`、同一來源雜湊取得既有 `reservationOperationReceipts/single-v2-free-batch-...` checkpoint。執行上限及 `recoveryPending` 為**回應狀態**，非新庫存 cache。新增來源 Service 的 `...AndRecover` 組合回傳 `postCommitAllocation:{status,sources:[{movementId,status,recoveryPending,allocatedQty|errorCode}]}`。交易來源成功後即使配貨卡住，原交易與事件仍保留；可由真實授權角色以來源 movementId 顯式續傳。沒有新 Rules／Index／正式資料遷移。


### v2 自由庫存配貨進度完整性（2026-10-18）

已實作：既有 `advanceAutomaticFreeStockAllocation` 的每次 checkpoint 交易讀取（包含已完成重送及扣帳後結算）均經 `validateAutomaticFreeStockCheckpoint`。累計分配須為 0 至原 maxQty 的整數，步數為 0–1000；完成必須沒有 pending、具已知完成原因，quantity-reached 必須實際達到原額度。pending 必須具有完整且僅限既定欄位、正整數且不超過剩餘額度，操作 ID 必須依原 runId／步數／訂單／品項衍生。達 1000 步不可建立新指令。異常進度先拒絕，不自動改成完成、重設操作 ID 或推估已扣帳量。

沿用原 checkpoint、movement 與唯一自由庫存 writer；交易已提交但 checkpoint 結算失敗時，修復正確進度後仍以原指令重送，原 movement 確保不重複預留。不變更角色、Collection、Rules、Index、前端或 Callable，仍僅 demo-yushin Emulator。新增 Emulator 案例涵蓋完成憑證異常、pending 篡改與額度超限、扣帳後再讀進度異常及原 ID 續傳；實際執行結果以本批 PR CI 為準。完整 Preview、不同操作者安全交接及正式部署仍未完成。


### v2 配貨自動換人續傳（2026-10-18）

沿用 `reservationOperationReceipts/single-v2-free-batch-{runId}`：`actorUid/actorRole` 為現任執行者；新增 `createdActorUid/createdActorRole` 保留批次建立者，`handoffCount` 記錄交接次數（既有試點文件未帶欄位時為 0，單批最多 1000 次）。原 intentHash／maxQty／runId／累計量／pending 指令保留，禁止換批次繞過已完成額度。

同集合新增 `action=single_v2_free_stock_handoff` 稽核文件，ID 由 runId 雜湊與下一交接序號決定；包含原角色／UID、新角色／UID、runId、產品／倉、intentHash、交接次數及 reconciledOperationId／reconciledQty／createdAt。稽核與批次更新同 transaction，任一失敗全回滾；不修改 users 或原 inventoryMovements。完成批次的其他合格物流角色僅讀結果，不改任務歸屬。

一般自動配貨的原庫存 transaction 增加一次 checkpoint 文件讀取；實際交接依 pending 額外讀取至多一份 movement，並同交易新增一份稽核／更新一份進度。沒有新集合、查詢、Index 或 Listener。正式資料不回填，仍限 Emulator。


### CLOSE 退貨後的剩餘履約（2026-10-18，Emulator-only）

不增加欄位或集合。原 `orders.returnRecords`／`returnedQty` 與 `inventoryMovements.action=location_customer_return` 必須一致；既有退貨寫入與後續打單／出貨／送達共用 `readLocationReturnProofs`。相同來源訂單 query 上限 201，超過 200 或紀錄數／原 normalized intent hash／來源／批次／完整 returnRecord 不一致時整筆拒絕。空快取也查詢，不能把移除實際退貨紀錄視為從未退貨。

正常無退貨送達由原三份文件讀取，增加一次有界退貨憑證 query，總計 4 次 transaction.get 呼叫；有退貨時，該 query 實際讀取對應 movement（最多 200 份）。正常打單與出貨同樣增加一次此 query；不讀成本、批次或庫存來確認送達，送達仍只寫 orders，不二次扣帳。原退貨 writer 沒有增加查詢。沿用既有複合條件查詢，不新增 Index／Listener，未遷移或部署正式資料。


### CLOSE 退貨後的取消／恢復（2026-10-18，Emulator-only）

沒有新增欄位、集合或來源憑證格式。`orders.returnRecords`／兩層 returnedQty 必須與共同投影及原 `location_customer_return` movements 一致，取消與恢復都驗證；缺失、竄改或清除退貨快取不得繞過。原 lifecycle operation ID／intent hash／receipt、ledger 與 release/reserve movement 格式保持不變，固定 ID 重送仍只回原結果。

每次首次 lifecycle 交易新增一次 sourceId + action 的既有 return movement 查詢（limit 201，最多接受 200）；舊初始 v2 無 returnRecords 欄位時以空快取唯讀檢查，不回填正式資料。既有供應／採購單／實收 proof 同交易檢查保留；取消／恢復只寫原狀態、預留、需求、操作歷史與憑證，不改實貨、批次或既有交付／退貨／採購／收貨事實。無新 Index／Rules／Listener 或遷移。


### CLOSE 後收貨契約（2026-10-18，Emulator-only）

無新 collection／持久欄位。warehouseShipmentContext 增加 `returns`，只供 Core 計算、不寫入 items；Workflow stockOutstandingQty 使用 projectShipmentReturns.outstandingQty，CLOSE 等於原訂購量減歷史寄出量。receivedQty／supplyOrderedQty 仍是累計供應事實；returnedQty 與 returnRecords／returnHistory 不因新 receipt 刪除或縮量。

首次 v2 收貨交易新增一次 sourceId＋action 等值 return movement query，limit201、最多接受200筆；即使空 returnRecords 也驗證。每筆比對完整 returnRecord、原 canonical intent hash 與固定 movement ID；無額外庫存／成本查詢或寫入。原庫存／批次／成本／receipt／需求與供應寫入契約不變。既有同 ID receipt replay 不重新入庫；正常首次收貨仍重讀實際角色。無 migration、Index／Rules／Listener 變更；正式查詢索引仍須 Preview 驗證。


### 取消來源 CLOSE 退貨資料契約（2026-10-18，Emulator-only）

無新 collection／持久欄位或遷移。取消來源的 inventoryReservations 維持 locationSchemaVersion2、status released、quantity0、shortageQty0、locations[]；退貨只沿既有公司／原倉實貨與原批次餘量加回，原 ledger 結構與 lifecycleWarehouseIds 保留。orders 的 status／orderStatus、出貨／送達、PO／供應／receipts及成本資料不改，只新增原 returnRecords／returnHistory與累計退貨投影。

既有 location-return-{operationId} movement 保存原 actor／意圖hash／完整returnRecord／result；CLOSE仍用原 CLOSED_CUSTOMER_RETURN／freeAllocationQty欄位作為有界配貨來源。無額外get／query／listener：單批次首次仍10次transaction get呼叫、6次寫入，查詢與批次上限沿原契約；同ID重送不重複增加實貨。純Core明確接收orderStatus cancelled，不能把取消誤當normal去新增預留。


### 退貨追溯額度回傳契約（2026-10-18，Emulator-only）

無持久欄位／collection／migration變更。planExplicitShipmentReturn 與 trace 新增 confirmedQty、previousReturnedQty、remainingReturnQty，以及 remainingLotAllocations[{lotId,lotNo,expiryDate,remainingQty}]。數量皆為本次選定shipment、此次預覽選量尚未提交前的額度；批次上限可能合計大於已確認可退總量，不能相加視為均已送達。新明細不帶實際成本；原 returnQty／allocations／lotRestorationPreview／canCommit false保持。

正常查核交易為4＋N次get呼叫，取消為5＋N（多一份released ledger），N為明確所選批次且≤200。新增一次sourceId＋action退貨movement query，limit201、最多接受200筆，空快取也查；正常最多403份來源／憑證／批次文件，取消最多404份。不讀公司／分倉庫存、成本或供應集合；無寫入、Listener、Index／Rules變更。入庫交易仍以當前權威資料重新驗證。


### 退貨 Auth 整合無新持久資料模型（2026-10-18，Emulator-only）

Auth uid對應原users/{uid}，角色／active／disabled仍讀原文件；Callable payload契約完全沿原trace／return normalizer，不新增actor／價格／庫存輸入欄位。原location-return-{operationId} movement保存交易內實際登入actorUid／role，trace仍零寫入，原returRecords／history／stock／lot原子交易不改。

臨時Functions測試目錄的checkout.json及.env.local只屬執行設定，結束刪除，不寫入專案資料集合。Emulator Auth帳號與上游order／inventory fixture明確為合成測試資料；無正式帳號、資料遷移、新Rules／Index／Listener。傳輸層驗證失敗不得進入原退貨writer。


### 初始化checkpoint由原來源交易產生（2026-10-18，Emulator-only）

無新增collection／欄位／migration。退貨Auth fixture的inventoryReservationStatus、inventoryReservationAttemptId、inventoryReservationError及UpdatedAt現由原writeOrderInventorySyncState寫入，不再由測試直接完成；工作索引沿原orderWorkIndexFields。

v2 operationId以orderId／itemId／本次syncAttemptId建立固定雜湊識別，仍保存原reservationOperationReceipts與逐倉movements；預留／缺口沿原Core。需求使用原來源demandId與正式URL編碼路徑，只有實際缺口／供應歷史才建立需求。中斷重試保留原庫存事實，新的來源attempt不增加已占量；完成來源重送不寫另一份receipt／demand或重設attempt。fixture hooks只模擬中斷與回覆遺失，不是持久資料模型。


### 2026-10-18 實際打單入口續傳整合

dispatchRecords/{dispatch-ui-operationId} 沿用原 Collection；新增 operationId、actorRole、expectedPreparedQty，qty 是凍結確認量。與 orders.items／工作索引同交易提交，重試不得變更或重建憑證。舊憑證保留，不遷移。 詳見 [介面交易對照與驗收邊界](transaction-ui-integration-20261018.md)。已實作、待本批 CI；未部署 Firebase，單品項多位置仍未啟用正式介面。


### 2026-10-18 退貨實收 Service 接線

第二批沒有新增持久欄位或 Collection；customerReturnReceipts、orders.returnRequests／returnRecords、原批次及庫存的既有提交邊界不變。HOLD→STOCK 和回庫存仍在同一交易；依原 receipt disposition 重送為只讀。 驗收項目與限制見 [介面交易對照](transaction-ui-integration-20261018.md)。未部署 Firebase，完整 Preview 全流程尚待驗收。

### 2026-10-18 整單 v2 操作憑證（Emulator-only）

沿用 reservationOperationReceipts，新增 order-v2-{attemptId}／action=order_location_reservation，存全單 itemIds、真實 actor／role、syncAttemptId、intentHash 與逐品項結果；各品項各倉 movement 連回同一憑證。預留 ledger、orders.items、公司／分倉模型及舊單品項憑證格式不變，沒有新 Collection／Rules／Index 或正式資料遷移。庫存完成不直接修改初始化 completed。見 [文件邊界](multi-item-location-transaction-20261018.md)。


### 2026-10-19 多品項送達撤銷（已實作、待本批 CI）

無新增 collection／欄位／Rules／Index／migration。原 deliveryHistory 的 delete／before／actor／reason／intentHash／result 沿用，只更新選定 item.deliveredQty 及 orders 合計，保留其他品項與庫存事實。首次 get 呼叫為 4＋S（整單出貨 S≤40），重送 2 次；只寫 orders。 僅 demo-yushin Emulator；未接正式 UI／Callable、未部署 Firebase，完整 Preview 仍未驗收。詳見 [同一份送達契約與驗收範圍](multi-item-delivery-20261019.md)。


### 2026-10-19 多品項履約後收貨（已實作、待本批 CI）

沒有新增持久欄位、collection、Rules、Index或migration。收貨不改 warehouseShipmentRecords／deliveryRecords／deliveryHistory 或整單交付總量，只更新既有收貨及庫存事實。整單最多40筆出貨憑證，每份在交易內讀一次；沿用空退貨的原有界憑證query。 限 demo-yushin Emulator，未接正式 UI／Callable 或部署；詳見 [原收貨契約增補](multi-item-receiving-20261018.md)。


### 2026-10-19 多品項整單取消／恢復（已實作、待本批 CI）

沿既有reservationOperationReceipts，整單action=order_v2_lifecycle新增itemIds/result.items（逐項productKey/差額）；movement原前綴增加itemId避免同倉碰撞，原actor/hash/receipt鏈保留。無新collection/Rules/Index/Listener/migration；stock文件只讀一次、最後至多寫一次，供應與receipt各以orderId一次＋逐項demandId有界query雙向查核。 仍限 demo-yushin Emulator，正式 UI／Callable 未開啟，無部署。詳見 [同一份 lifecycle 契約增補](location-lifecycle-20261017.md)。

### 2026-10-19 多品項 CLOSE 退貨（已實作、待本批 CI）

沿原orders.returnRecords／returnHistory與location-return-{operationId} movement。只更新選定items[].returnedQty及全單returnedQty／isDelivered，兄弟原資料保留。多品項result另含itemIsDelivered；無新Collection／ledger欄位／Rules／Index／遷移。增加最多40份出貨proof、5份ledger及原商品另一倉的有界讀取，原批次query上限維持200。見 [原退貨契約增補](location-return-receipt-emulator-20261017.md)。


## 2026-10-19 多品項 CLOSE 後續收貨與整單取消／恢復

本節取代前述「多品項退貨後收貨／取消恢復尚未整合」限制。限原 2–5 品項、兩候選實體倉、completed 初始化及 demo-yushin Emulator。正常訂單已有可驗證 CLOSE 退貨時，可由原 receiveSupplyOrderRecord 繼續收貨，或由原整單 lifecycle 取消／恢復未出貨剩餘。CLOSE 不重開已交付需求；取消／恢復不改寫歷史出貨、送達、退貨、PO、供應在途、實收、批次及成本。

新增共用 Fulfillment.validateOrderLocationReturnProofs，先驗完整整單事件與有界（200）實際退貨 movement 集合，再逐項沿原 validateLocationReturnProofs 驗證 canonical intent SHA-256 與完整 returnRecord。後端 trace／退貨／lifecycle 與瀏覽器收貨共用同一核心；資料庫 query 與 SHA-256 保持平台 adapter。兄弟品項憑證不能被 filter 隱藏，空退貨仍須查核實際入庫。收貨只將選定品項事件傳入原 Receiving／Workflow，維持全單投影與各來源 ledger／合計持有量查核。

新增四項真實 Emulator 驗收：兩產品 CLOSE 後分批及固定 ID 重送收貨並完成 12 件歷史交付；兩產品退貨後原子取消／恢復及恢復後收貨；兄弟憑證遺失／hash／完整紀錄／來源／隱藏紀錄／更正歷史均零寫入；REPLACE 及取消中多品項收貨維持拒絕。fixture 沿真實初始化、PO、收貨、打單、出貨、送達、退貨 Services。

本地 Node 1560/1560 通過，完整 Emulator／Auth／Rules 與八組桌機手機 Chrome 以本批 CI 為準。無新 collection、欄位、Index、Rules、Listener 或額外資料庫查詢；沒有 Firebase 部署或正式資料寫入。多品項取消中 KEEP_STOCK 收貨、取消後再新增退貨、補送／退貨更正、正式 UI／Callable／Preview 真實登入全線 E2E 仍待後續整合。


## 2026-10-19 多品項取消後 KEEP_STOCK 收貨

本節取代前述多品項取消中收貨仍拒絕的限制。原 validateV2ReceiptSource 擴充為同時驗證正常及取消整單；取消時全部原 v2 ledger 必須 released、quantity／shortageQty 為零且沒有位置，全部品項無途中貨與額外打單。仍查核全部兄弟產品／來源、整單事件、出貨 debit 與 CLOSE 退貨實際憑證。選定 supply 必須有既有採購 handler 的完整 KEEP_STOCK 決策，不能將某品項核准套到另一品項。

receiveSupplyOrderRecord 沿原取消分支及 planReservationReceipt(requestedReserveQty:0) 入庫，不另建 writer、狀態公式或預留機制。只增加實貨與原收貨／批次／成本紀錄、減少原在途並更新選定品項與取消需求的實收進度；所有已釋放 ledger、兄弟品項與物流退貨事實不變。恢復仍沿原整單 lifecycle，以即時實貨與剩餘未出貨量配置。與恢復競爭時依交易重讀目前狀態，正常分支的來源超額保持自由庫存，不假設必定全部被本單預留。原 receipt ID／actor／role 重送、原自由庫存分配與 durable recovery 接線不變。

新增八項真實 Emulator 案例：逐供應採購核准、分批及完整收貨恢復、兩產品 CLOSE 保留歷史、五列同商品競爭、來源／空 ledger／決策／退貨憑證異常零寫入、五角色與重送綁定、同 ID／超額／恢復競態、ALREADY_EXISTS 末端回滾與回覆遺失、原 receipt 自由庫存來源及正式環境閘門。皆沿既有初始化、採購決策、PO、收貨、出貨、退貨與整單 lifecycle。沒有新資料庫查詢、Collection、持久欄位、Rules、Index 或 Listener。

本地 Node 1560/1560 通過；完整新增 Emulator、Auth、Rules 與八組 Chrome 以本批 CI 為準。僅 demo-yushin Emulator、2–5 個實體倉品項、兩個原候選倉；未啟用正式 UI／Callable、未部署 Firebase 或修改正式資料。多品項取消後再新增退貨、混合服務／直送、補送／更正及 Preview 真實登入全線 E2E 仍待後續整合。


## 2026-10-19 取消後多品項 CLOSE 退貨

本節取代前述取消後再新增多品項退貨仍拒絕的限制。僅 demo-yushin Emulator、2–5 個實體倉品項、原兩候選倉、completed 初始化。原 shipmentDeliveryContext 只有同時明確啟用 return／cancelled-CLOSE 選項才接受兩個狀態欄位均 cancelled 的整單；原送達確認與撤銷仍拒絕取消訂單。

原 trace 與唯一 commitLocationReturn writer 共用整單 context／取消 guard／來源 reader：每個品項都須無途中貨、無額外打單、無 REPLACE，退貨歷史僅有可對應原入庫的 add；每份原 v2 ledger 必須 released、quantity／shortage 為零、位置為空，並維持相同候選倉及所有權／商品來源。全單出貨 debit 與全單退貨 movement／canonical hash 查核不變，不能忽略兄弟品項。trace 仍只讀來源證據與原批次，不讀庫存或成本；多品項取消的選定 ledger 已由原整單 reader 查核，不重讀一次。

原庫存／批次／Fulfillment Core 處理實收及原批次還原，CLOSE 只增加自由實貨，取消狀態、released 預留、採購／需求／送達事實保留，不重開已交付需求。整單 returnedQty／isDelivered 沿原整單 Core 投影，只改選定品項；原固定 movement ID、actor／role、intent hash、原子提交、重送與提交後自由庫存續傳沿用。退貨後可接原 KEEP_STOCK 收貨及整單恢復，並依當下實貨配置原未出貨需求。

新增十項真實 Emulator 案例：正常及五列取消後退貨／恢復、唯讀 trace 與過期預覽、五角色及重送／所有權、兄弟出貨／ledger／途中／打單／歷史／隱藏憑證損壞、同 ID／超額／跨品項／恢復競態、ALREADY_EXISTS 末端回滾與回覆遺失、原自由庫存續傳及正式閘門，另含真實 PO→出貨→取消→兩產品退貨→KEEP_STOCK 收貨→恢復與取消前後各一筆 CLOSE。既有 Node context 契約更新為需同時明確啟用兩個退貨選項。

本地 Node 1560/1560 通過；完整 Emulator／Auth／Rules 與八組 Chrome 以本批 CI 為準。無新 writer、資料庫查詢、Collection、持久欄位、Rules、Index、Listener、Firebase 部署或正式資料寫入。正式介面／Callable 接線與 Preview 真實登入全線 E2E、混合服務／直送及退貨更正仍待後續整合。


## 2026-10-19 退貨申請／撤回與採購保留入庫介面接線

原 modules/customer-cancellations.js 的三個交易 writer 移入既有 src/services/customer-return.js：saveReturnRecord → commitCustomerReturnRequest、withdrawCustomerReturn → commitCustomerReturnWithdrawal、keepCancelledPurchaseAsStock → commitCancelledPurchaseKeepStock。Feature 保留原輸入、確認、pending 鎖、固定操作 ID、提示與 cache 刷新，已無 runRoleTransaction 或直接 tx 寫入。退貨實收／待檢轉庫存仍沿原 Service，未新增第二個 writer、畫面或操作步驟。

customerReturnPendingQty 原計算原樣移入 Service，不新增退貨額度公式。申請重送核對既有 request 的 ID、item、qty、date、reason、settlement、createdByUid；即使原申請之後已部分實收或撤回，也只回原結果，不再新增。錯誤內容不能沿用原 ID。撤回只關閉原申請未收餘量，保留 receivedQty 與 returnRecords；已完成／已撤回重送不重寫時間。三動作在交易讀取前後、寫入前及回覆前核對目前帳號／前端角色與 capability；真正身份、停用、所有權與作業權限仍交由原 StockPermissions／Client Rules，不以 capability 取代授權。

KEEP_STOCK 沿原採購決策／來源及倉庫驗證。原直送轉原選定實體倉只登記尚未到貨 incoming 與原 redirect movement，不增加 onHand 或預留；沿原 runRoleTransaction 原子同步 receivingSupplyOrders，重試不重複登記。沒有新資料庫查詢、持久欄位、Collection、Index、Rules 或 Listener。

新增六項 Node 行為測試、五項真實 Client SDK＋StockPermissions＋Rules 測試，涵蓋額度、原 ID 意圖／帳號、30 次上限、部分實收撤回、帳號／角色變更、回覆遺失及末端回滾；Client Rules 驗證五角色／偽造 capability、同 ID／超額競爭、停用與外人、部分實收撤回以及 KEEP_STOCK 原子來源／接收鏡像／在途。既有 1280／390 px Chrome suite 擴充原三個 click handler → 真實 Service，驗證未知回覆重試與 incoming 不重複。Chrome 為記憶體傳輸，不是完整 Auth Browser／Firestore 單線 E2E。

本地 Node 1566/1566、建置同步／語法／diff 通過；新增 Client Rules 與 Chrome 以本批完整 CI 為準。本批接線為原一般介面，v2 多倉正式 Callable／UI 閘門不變，沒有 Firebase 部署或正式資料寫入。v2 正式傳輸、Preview 及完整真實登入端對端驗收仍待後續整合。


## 2026-10-19 原打單介面的 v2 Auth 傳輸試點

本節僅擴充 demo-yushin 隔離 Emulator 的介面驗收，未解除正式／Preview v2 限制。原訂單頁與採購頁 markOrderItemDispatchPrepared → prepareOrderDispatch，在明確 YUSHIN_V2_DISPATCH_EMULATOR=true 時轉接 prepareV2OrderDispatchEmulator；其餘一般打單路徑不變。介面沿原 warehouseShipmentState，從原 raw item 的 warehouseShippedQty 計算已消耗的打單額度，不將客戶送達當出貨，也不改寫其他數量投影。原 sessionStorage intent 另保存既有 inventoryReservationAttemptId 作 syncAttemptId，固定操作 ID／數量／打單基準；v2 intent 不得降級改送一般交易。

傳輸要求 localhost／127.0.0.1、Auth 與 Functions SDK 的實際 app.projectId 均 demo-yushin、Auth emulatorConfig 為本機9099，並強制 Functions SDK useEmulator(127.0.0.1,5001)。實際 Auth currentUser.uid 必須等於原前端 actorUid，呼叫前後與回讀訂單後均核對目前帳號／角色；payload 不含 actorUid／role。未載入 Functions、缺同步 ID、環境不符、回覆不明或網路失敗均不 fallback 到一般 writer，保留原作業。成功後只回讀真實 order 更新 cache，不以回應 counters 拼造訂單。

沿既有隔離 v2-return-callable-adapter／runner 新增 prepareV2OrderDispatch，唯一 writer 仍 commitLocationDispatchPreparation。Firebase SDK 驗證登入 token，原 Service 重讀 users 的實際角色／active／disabled；自訂 claims 或 payload 不授權。v2 後端仍允許原 admin／purchaser／warehouse，現有兩頁 UI 仍只有 admin／purchaser 可操作，沒有新增倉管按鈕。正式 functions/index.js 不匯出此入口，沒有 Functions／Auth provider 部署或正式資料寫入。

原 normalizeLocationDispatchIntent 新增可選 expectedPreparedQty，提供時納入 canonical hash 且在讀取原 receipt 確認尚未提交後，於同一交易核對 prepared 基準。不提供者的既有 hash／重送契約不變。僅已確認未提交且基準過期，回 failed-precondition＋details.reason=dispatch-stale，由原 handler 清除舊提案，更新後再確認；未知提交結果不清除。沒有新持久欄位、Collection、Rules、Index、Listener 或數量／預留 writer。

新增五項 Node 測試與四項 Auth SDK→原 UI handler／Service→Functions SDK→原 writer→Firestore 整合：多品項含同商品及另一商品、admin／purchaser 的不明回覆／重新載入原 ID、五角色、即時降權／claim 偽造、未登入／payload UID／停用、同 ID／競爭 ID／打單基準與同步版本。既有八組 Chrome 中，打單 suite 加測1280／390px 原兩頁 renderer 與 click handler，在尚未確認送達的實體出貨後使用正確 Core 額度並跨頁重試；其 Callable 為 scripted local transport，真實 Auth／Backend 由獨立整合測試驗證，不宣稱完整 Browser Auth／Preview E2E。

本地 Node1571/1571、建置同步／語法／diff 通過；完整新增 Auth、Chrome 與既有全部 Emulator／Rules 以本批 CI 為準。v2 初始化、收貨、出貨、送達、取消／恢復與退貨的正式傳輸／UI／Preview 全線仍待逐步接線。

### v2 原介面送達撤銷的暫存（2026-10-20，本機試點）

不新增 Firestore 欄位或集合；權威仍是原 orders.deliveryHistory 的 shipment_confirmation_reversal 及現有送達投影。sessionStorage 的 v2-delivery-reversal:{UID}:{orderId} 只保存待核對 intent（record／item／sync／operation／日期／原因及原角色），不是權威事件。未知回覆保留，確認回覆且重讀 orders 後才清除；同分頁刷新可續傳，不宣稱跨分頁／裝置持久化。確認與撤銷使用獨立 key。正式／Preview 未啟用。

### v2 整單取消／恢復的登入傳輸（2026-10-20，本機試點）

不新增 schema。隔離 Callable 沿 reservationOperationReceipts/single-v2-lifecycle-{operationId} 的 order_v2_lifecycle 原憑證與含 itemId 的原 reserve／release movement；postCommitAllocation 只回報後續原配貨進度，不能當成第二筆取消事實。沒有新 Collection、Rules、Index 或正式資料遷移；前端固定意圖尚未接線。

原本機介面新增 sessionStorage v2-lifecycle:{UID}:{orderId}，保存完整 itemIds、原 lifecycleWarehouseIds、syncAttemptId、目標狀態、日期／原因及操作 ID／原 UID／角色；不是 Firestore schema。只有回覆 receipt／全部 itemIds 核對成功、server 重讀原單並找到相同 operationId／操作者／意圖 history 後才清除。依原權限直接 get 預留帳，不讀受保護 reservationOperationReceipts；只支援同分頁刷新，不宣稱跨裝置保存。

待配貨 UI 沿 inventoryMovements.v2FreeStockSource=CANCELLED_ORDER_RELEASE 單欄位篩選與文件 ID 分頁，原 reservationOperationReceipts/single-v2-free-batch-source_v2_{sourceId hash} 為進度權威。共用 releasedV2FreeStockRunId，瀏覽器不產生替代 ID；沒有新增 sessionStorage 或持久欄位。列表由受驗證的隔離 Callable 讀取，前端不直接開放 checkpoint Rules。每次 drain 回覆該次所接觸的 affectedOrderIds 供 cache 回讀，舊完成批次重送可能回空集合；仍將原訂單／採購頁標記待刷新。清單不複製成本或操作者敏感資料。

真實 Browser Auth 驗收只建立隔離測試帳號及 fixture 文件，沿原 reservationOperationReceipts 的取消／配貨／handoff 與 movement 查核，不新增 schema。原 sessionStorage 取消意圖透過同一 browser context 重開保存，Auth 使用實際 LOCAL persistence；物流進度則從原 checkpoint 重讀。測試確認一次取消 history 與一次換人 handoff，最終批次完成且原 inventoryLots／onHand 不變。正式資料及 Auth providers 不變。

區域 Functions 改從 compat app 取得，原 payload／意圖 hash／operation ID／source runId 契約不變；沒有資料遷移或欄位新增。


## 正式採購多品項後端擴充（2026-10-20）

無新 collection、Rules 或索引。`purchaseOrders` 的 `items`／`supplyOrderIds` 以列序一對一對應；`orderIds` 保存去重的來源訂單。Supply ID 仍為 `po-{encodeURIComponent(poNo)}-{index}`。每列各更新原需求；同來源訂單各品項累積採購與事件在同一次來源 update 保存。回覆多列含 `demandIds`、各列 supply IDs 與合計 `committedQty`；單列保留原 `demandId`。此階段不建立在途、實貨或批次。

原採購文件試點新增可選 `document` 意圖：公司、五欄供應商快照、預計日期／來源及逐列交期；皆精確欄位與型別／上限查核並納入原冪等指紋。後端從權威列重算金額與搜尋 tokens，保存 PO 原欄位、Supply 供應商／交期及訂單↔PO 雙向連結。不帶 document 的既有隔離請求維持原指紋，不遷移舊資料。預計到貨日和原需求 required-by 日期分開；新增欄位不覆寫 demand 的 scheduleDate。


### 原採購單斷線恢復（2026-10-20）

原採購按鈕在呼叫同一 `commitFormalPurchaseOrder` 前，以 sessionStorage 固定原 UID／角色／單號及完整提交內容；未確認作業只允許原意圖重送，不建立新單號意圖。原採購頁提供「確認前次採購結果」，刷新後仍可經同一後端 writer 回讀 PO／來源／Supply，沿原 `registerPurchaseIncoming` 完成在途後才解除 checkpoint。讀取與導覽不得自行提交。僅 demo-yushin 本機試點啟用；正式／Preview 不啟用，未部署 Firebase。

後端交易及需求公式沒有新增第二套；畫面快取同步抽為共用 feature helper。存取失敗在提交前停止；回覆未知、回讀失敗、在途失敗、角色改變或暫存損壞均保留 checkpoint，不默默刪除或降級 client writer。回覆已確認後的畫面更新失敗須與交易未確認分開顯示。checkpoint 僅保存於同分頁 sessionStorage，不承諾跨裝置或關閉分頁恢復；價格資料不送入新 collection。無新 Rules／Index／Listener／正式資料遷移。

實作及尚未驗收範圍見 [整站驗收紀錄](full-site-emulator-boot-20261020.md)。


### 原採購單部分收貨傳輸（2026-10-20，待 CI）

原 receiveSupplyOrderRecord 在明確 YUSHIN_V2_RECEIVING_EMULATOR gate 中轉至 receiveV2Supply，僅 localhost／demo-yushin Auth 9099／Functions 5001 可呼叫，不回退原 client writer。原收貨工作保存 qty／lot／expiry／operationBase；傳輸前須核對 sessionStorage 已保存的同一意圖，回覆後回讀 receipts 權威憑證並核對真實 UID／角色，未知回覆保留既有工作與重試入口。

唯一權威收貨 writer 仍為 src/services/receiving.js。tools/build-receiving-runtime.cjs 從它與現有訂單／需求投影產生 functions/shared/receiving-runtime.js，僅注入每請求身分、SDK 與共用 Core，執行時不使用 eval／VM，不另寫數量或扣帳公式。build-functions-core --check 同時驗證這份 Service 生成內容。隔離後端每次交易重新讀 users 當前 active／disabled／角色、原 Supply／Order／v2 ledger；權限為 admin／purchaser／warehouse，不接受 payload uid、role 或 claims 替代。供應更新在同一交易經既有 sanitizeSupply 更新 receivingSupplyOrders，不暴露成本。

本批新交易入口僅接受正常單品項 WAREHOUSE 客戶訂單 PO、尚未打單／出貨／送達／退貨的來源。已提交憑證以原身分／內容核對後可冪等重試，不再次入庫。舊一般收貨路徑不變，取消、服務型、直送、備庫、多品項與後續履約的此新傳輸尚未開放。無新增 Collection／Rules／Index／Listener，正式 index.js 不匯出，未部署 Firebase。

驗收邊界見 [整站驗收紀錄](full-site-emulator-boot-20261020.md)。


### 同 PO 收齊後原打單與分批寄出（2026-10-21，待 CI）

不新增持久欄位或集合。兩次真實到貨使用不同固定 receipts operationId 與各自 lot；同次回覆遺失後重試保持該次 ID、批號、效期與數量。兩次實體寄出保留既有 warehouseShipmentRecords 與 location-ship-* movements；deliveryRecords 不變。既有 receivingSupplyOrders 繼續由 sanitizeSupply 投影且不含成本。

本批本機語法與建置一致性檢查已通過；真 Auth、Chrome 及全套 Emulator／Rules 的執行結果以本批 PR 最新 CI 為準。未部署 Firebase，未修改正式資料。


### 同 PO 出貨後分批送達與不重扣驗收（2026-10-21，待 CI）

無新欄位／集合。送達沿既有 deliveryRecords 的 shipmentId／shipmentMovementId／intentHash 與 deliveryHistory。首次與最後一次簽收回覆中斷後，sessionStorage 原 intent 維持同操作 ID、來源出貨、數量、日期及備註；重送不新增第四筆簽收。inventory、warehouseStocks、inventoryReservations、inventoryLots、inventoryLotCosts、inventoryMovements、receipts、supplyOrders、procurementDemands 均須完整不變。

本機建置一致性與語法檢查已通過；完整真 Auth／Chrome／Emulator／Rules 結果以本批 PR 最新 CI 為準。未部署 Firebase，未修改正式資料。

首輪整站驗收發現：原 openPartialDeliveryForm 在 renderDeliveryModal 已回填原待確認意圖後，又清空 deliveryQty。現於本機 v2 入口重新呼叫同一 renderer 恢復原數量／來源，不改寫 intent、不另造交易。既有 desktop／phone delivery smoke 同步改走原開表單函式，覆蓋此重整恢復回歸；修 src 後已重建 app.js 並更新靜態版本。修正後全套 CI 仍待執行，不將首輪失敗當通過。


### v2 退貨申請原子實收（2026-10-21，本機隔離契約）

沿用 orders.returnRequests、returnRecords、returnHistory、customerReturnReceipts 與 inventoryMovements；無新集合、Rules、索引或正式資料遷移。normalizeLocationReturnIntent 新增可選 requestId，提供時必須 CLOSE，並納入原 canonical hash；未提供時的歷史序列化及 hash 完全保留。原退貨紀錄帶 requestId／quality=SALEABLE，實收憑證 ID 使用同一 operationId，另保存 movementId／intentHash／receivedByRole／sourceType=WAREHOUSE_CUSTOMER_RETURN，仍保留既有 receipt 的 ownerUid、salesCode、record、STOCK disposition 與 requestIndex 欄位。

唯一 commitLocationReturn 交易先讀目前 users 與原單、原 movement 及同 ID receipt，再沿原出貨／退貨憑證、v2 ledger、公司／分倉及原批次驗證，最後一次寫入公司實貨、分倉實貨、預留帳、原 lot 餘量、退貨事件與 history、申請 receivedQty／PENDING 或 RECEIVED／returnPending、customerReturnReceipts 及 movement。不改原申請 qty／日期／原因／建立者，亦不另造批次。申請已收量必須等於原 linked returnRecords 合計；同品項有待收申請時不得用未連結舊入口繞過申請餘量。

帶 requestId 的角色限 admin／purchaser／warehouse，從交易內 users 真實角色驗證；未帶者沿 admin／本人 sales／engineer。申請撤回或完成後禁止新實收；已提交同 ID 可核對原操作者／角色／hash／receipt／原退貨紀錄後只讀回覆，不能再次入庫。兩個 ID 競爭最後餘量由同一 orders 交易序列化。RESTOCKABLE／SALEABLE 以外品質、REPLACE 與跨倉回收仍拒絕。

本批只接既有隔離 Callable 與後端原交易；原倉管 UI 仍保留未開放訊息及 legacy source guard，尚未接上固定意圖、刷新恢復與真實 UI 實收。正式 index.js 未匯出；未部署 Firebase。測試結果見整站驗收紀錄。


## 2026-10-21 申請實收的前端傳輸準備（UI 未開放）

無新增 Firestore 集合、欄位、Query、Index、Rules 或 Listener。前端同分頁 sessionStorage 以 v2-return-receipt:{UID}:{orderId} 保存 actorUid／actorRole／完整 intent，每人每單一筆；不承諾跨裝置或關閉分頁恢復。新操作定址讀 orders；成功後讀原 customerReturnReceipts/{operationId} 及 orders，核對權威憑證才清除暫存。

本機 Node 1642／1642 通過；新增真 Auth 整合與完整 CI 結果以本批 PR 為準。未部署 Firebase、未變更正式資料或角色；詳細契約與未驗收邊界見 transaction-ui-integration-20261018.md 同日章節。


## 2026-10-21 原倉管退貨收貨畫面（本機 Emulator 試點）

無新集合、欄位、Query、Rules、Index 或 Listener。開表單定址讀原 orders，提交沿既有實收傳輸與憑證回讀。待確認列由原 UID 的 sessionStorage 意圖產生，不依賴 returnPending 查詢，因此最後一批已收齊仍能在重整後確認。讀取列表與開待確認表單均不提交。成功後依原產品／倉失效庫存及批次 cache、刷新原訂單與待收清單。

本機 Node 1648／1648 通過，零失敗／略過；新增6項UI行為測試。原站真Auth／Chrome與完整CI結果以本批PR為準。未部署Firebase，未修改正式資料或角色。


## 2026-10-21 採購草稿非同步載入保護（已實作，待完整 CI）

本批草稿載入保護只有前端暫態旗標／既有視窗 generation，沒有新增 Firestore 欄位、Collection、Rules、Index、listener 或正式資料遷移。在途仍是既有採購後的獨立 checkpoint，沒有合併成新的交易。


## 2026-10-21 文件製作與採購確認分離（已實作，待完整 CI）

沿用 purchaseOrders：新製作文件為 status=DRAFT、documentOnly=true、createdByUid／Role 保存製作者，沒有 supplyOrderIds；確認交易更新為 ORDERED／documentOnly=false，新增 confirmedAt／confirmedByUid 並填既有供應連結。沒有上述旗標的舊採購單仍按既有交易紀錄顯示，不倒退為未採購、不做正式資料遷移。既有 Supply／Demand／庫存權威分工不變；新欄位不是交易授權依據，後端仍查真角色／來源／產品／需求。
本節取代先前「產生 PDF 即登記採購」的操作契約；正式 Firebase 尚未部署。
