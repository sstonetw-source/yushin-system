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
