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
