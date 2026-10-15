# DATA_MODEL — Firestore 集合與資料責任地圖

版本：2026-10-15。來源：`firestore.rules` 實際 match、`firestore.indexes.json` 與程式引用；不是資料庫內容或正式環境實際部署狀態。對應 `docs/BUSINESS_RULES.md` 與 `docs/system-architecture-20260923.md`。

## Firestore 集合（規則中實際宣告）

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
