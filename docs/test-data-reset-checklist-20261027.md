# 正式 Firebase 測試營運資料清理清單（僅規劃，未執行）

日期：2026-10-27  
來源：`main` 的 `src/features/products/product-master-import.js` 現有「測試資料初始化」程式、`docs/DATA_MODEL.md`、相關訂單／採購／庫存／收貨與物流模組。  
目標環境：`yu-shing-company` 的 Firestore `(default)`（僅由使用者截圖辨識；未連線讀取正式資料）。  
**本文件不是刪除授權、不是可直接執行的腳本，也未變更任何 Firebase 資料。**

## 1. 固定範圍與完成條件

- [ ] 完整盤點擬清理集合、子集合、資料筆數與跨集合引用；不得僅憑 Firestore 主控台可見清單判定。
- [ ] 保留產品／價格／客戶／品牌／供應商／員工／權限／倉庫／系統設定及儀器主檔；**估價單預設保留**，除非另行授權。
- [ ] 交易事件、操作冪等憑證、批次及庫存帳依同一重置批次處理；不得留下可重試但失去來源的殘留憑證。
- [ ] 先在隔離 Emulator 以相同集合布局做清理預演與故障注入；完成前不得在正式環境執行。
- [ ] 正式資料清除須另取得明確授權、建立可驗證備份、確認無進行中的寫入並完成維護時段安排。
- [ ] 清除後對帳：清理目標符合預期筆數、公司與分倉庫存歸零、無孤兒文件／未終止操作、保留主檔可讀、角色權限不變、頁面可正常使用。
- [ ] 驗收結論須保存實際執行日期、操作者、清理前／後筆數、備份識別與失敗及修復紀錄。

## 2. 截圖中 27 個集合：保留或清理

| 集合 | 建議 | 理由及注意事項 |
|---|---|---|
| `auditLogs` | 清理候選，最後處理 | 稽核與冪等證據；須先封存清理操作證據並確認沒有仍需回復的交易 |
| `brandSupplierMappings` | **保留** | 預設品牌供應商對應，估價單／採購設定仍使用 |
| `brands` | **保留** | 品牌主檔 |
| `customers` | **保留** | 客戶主檔 |
| `dispatchRecords` | 清理候選 | 打單／出貨憑證，與訂單及交付相關 |
| `equipment` | **保留** | 儀器主檔、維保資訊 |
| `forecasts` | 清理候選，需先盤點 | 舊初始化會刪除 Forecast；若有欲保留商機，須先排除 |
| `inventory` | **歸零並保留文件** | 公司庫存彙總／庫存策略；清理前分辨哪些欄位應保留 |
| `inventoryLotCosts` | 清理候選 | 庫存批次成本；僅授權角色可接觸 |
| `inventoryLots` | 清理候選 | 庫存批次、效期、批次餘額 |
| `inventoryMovements` | 清理候選 | 庫存異動與部分交易冪等憑證 |
| `inventoryReservations` | 清理候選 | 訂單庫存預留 |
| `orders` | 清理候選 | 測試訂單；須與採購需求、出貨、收貨和預留一致處理 |
| `priceHistory` | **保留** | 產品價格與成本變更歷史，可能涉及主檔 |
| `productCosts` | **保留** | 產品受保護成本 |
| `products` | **保留** | 產品主檔；Beckman 重複產品屬另一個專案清理 |
| `purchaseOrders` | 清理候選 | 採購單／操作重送依據 |
| `quotes` | **保留** | 現有初始化刻意保留估價單；其指向已刪訂單／Forecast 的連結另行檢查 |
| `receipts` | 清理候選 | 供應收貨及入庫憑證 |
| `receivingSupplyOrders` | 清理候選 | 倉庫角色可讀之去成本供應投影 |
| `salesCodes` | **保留** | 業務代號及交接 |
| `settings` | **保留** | 全域參數、功能旗標與權限相關設定 |
| `stockTransfers` | **暫停條件；不得直接清** | 原初始化發現任一文件便拒絕執行；必須連同調撥／操作憑證用獨立後端方案清理 |
| `suppliers` | **保留** | 供應商主檔 |
| `supplyOrders` | 清理候選 | 在途、採購需求對應與收貨累計 |
| `users` | **保留** | 帳號、角色、責任歸屬 |
| `warehouseStocks` | **歸零並保留文件** | 分倉庫存彙總；需與公司庫存及批次同步一致 |

**重要：** 上表的「清理候選」不代表可以依列順序直接用 Firebase Console 刪除；正式作業應視為一組受控的跨集合重置。

## 3. 其他關聯集合／子集合（截圖可能尚未顯示）

依 `docs/DATA_MODEL.md` 及程式可見的額外名稱，正式清理前必須先確認是否存在、文件數量及是否為測試資料：

| 集合／子集合 | 預設處理 |
|---|---|
| `procurementDemands` | 清理候選：採購需求投影 |
| `deliveries`、`customerReturnReceipts` | 清理候選：交付／退貨憑證 |
| `stockTransferRequests`、`stockOperations` | **暫停條件**：與 `stockTransfers` 一樣，現有前台初始化要求空集合 |
| `reservationOperationReceipts` | 需確認：後端預留冪等／恢復 checkpoint，不得遺漏 |
| `purchaseOrderCommunications` | 需確認：採購對外傳送紀錄是否須隨 PO 清理 |
| `externalDispatchNotices` | 需確認：倉庫配送通知是否依賴已清理訂單 |
| `serviceCases` | 需確認：服務案件操作憑證是否為測試資料 |
| `pendingInventoryItems` | 需確認：待處理庫存項目是否仍有有效用途 |
| `forecasts/{id}/progress` | **先刪子集合，才可刪 Forecast 文件** |
| `productLines`、`warehouses` | **保留**：產品線及倉庫主檔 |
| 其他由程式／Rules／資料庫枚舉出的集合與子集合 | 先加入盤點；未知集合預設不刪 |

備註：Cloud Firestore 刪除父文件不代表會自動刪除其子集合；需在盤點表中另外列出並驗證。

## 4. 現有前台初始化的實際行為與缺口

來源：`src/features/products/product-master-import.js`。

1. 預覽 `quotes`、14 個 `TEST_DATA_RESET_DELETE_COLLECTIONS`、`forecasts`、`inventory`、`warehouseStocks` 的數量，另外計數 Forecast progress。
2. 如果 `stockTransfers`、`stockTransferRequests` 或 `stockOperations` 任一非空，直接拒絕。
3. 刪除 Forecast progress，再逐一刪除 14 個營運集合及 Forecast；將 `inventory`／`warehouseStocks` 的 `onHand/reserved/available/incoming/shortage` 設為 0。
4. 保留 `quotes` 和主檔；原程式明示估價單可能留下失效訂單／Forecast 連結。

**不可直接視為完整安全重置：**

- 刪除以每批最多 300 筆的批次提交進行，**整個清理流程不是單筆原子交易**；執行中斷時可能已刪除部分資料。
- 尚未覆蓋第 3 節所有操作憑證與歷史集合，也未證明保留資料的跨集合引用都安全。
- 預覽與真正執行之間沒有完整寫入凍結；正式資料筆數未知。
- 不能以放寬 Firestore Rules 或用管理員權限強行跳過安全檢查作為解法。
- 因此**本清理計畫不得直接呼叫 `executeTestDataReset()` 於正式環境**；應先設計有中斷復原、完整盤點及復驗的後端受控方案。

## 5. 實際操作順序（未執行）

1. **盤點及分類**：列出正式環境所有 root collections／subcollections，對每個集合記錄路徑、筆數、文件範例架構、引用關係、負責模組及保留／清理／待確認分類；特別查核第 3 節操作憑證。
2. **備份與凍結**：建立可還原的完整 Firestore 備份並確認備份位置／存取權限；暫停使用者交易與 Cloud Functions 相關寫入，確認無 pending 採購、收貨、出貨、預留、重送或維修操作。
3. **隔離環境預演**：在 Emulator 複製具代表性的跨集合文件，模擬正常完成、重試、並行、半途失敗、中斷後續跑、僅存在子集合、合法與非法角色；驗證重置後不會留下孤兒憑證或重新產生庫存。
4. **執行前乾跑**：再次盤點每集合文件數與受影響引用，確認保留名單、預計刪除數、零值欄位與清理批次識別。若任何集合未分類或備份失敗，**停止**。
5. **經授權後執行**：使用單一受控後端作業編排跨集合清理與 checkpoint；按**子集合 → 訂單／採購／收退貨／物流互相依賴的交易集合 → 庫存預留／異動／批次及成本 → 庫存彙總歸零 → 稽核資料最後處理**。具體提交單位須由一致性與冪等性測試決定，不能單靠刪除順序保證安全。
6. **執行後對帳**：各目標集合歸零或符合預期、`inventory` 及 `warehouseStocks` 可用與在途數一致、保留 master 未異動、保留估價單／主檔沒有未處理的無效連結；刷新 UI，驗證建立新單、採購、收貨、出貨的基本功能及越權防護。
7. **異常處理**：若中途失敗，保持維護凍結；用原批次 ID 續跑或依已驗證備份還原，不允許重新以不同操作 ID 執行、不人工補寫庫存數量。
8. **完成記錄**：提交匿名化的清理報告、每集合前後筆數、Emulator 與 CI 證據；再恢復交易功能。

## 6. 執行前決策與驗收欄

- [ ] 尚未取得正式資料刪除授權；本 PR 僅新增計畫文件，不執行 Firebase 任何變更。
- [ ] 已確認完整刪除範圍與要保留的估價單／Forecast：**預設保留估價單，Forecast 視測試資料清除**。
- [ ] 已確認 `stockTransfers`、`stockTransferRequests`、`stockOperations` 及後端 checkpoint 的處置。
- [ ] 已完成正式資料計數與引用檢查，並保存資料備份。
- [ ] 已有獨立於前端的受控清理工具，實作失敗恢復與重入防護。
- [ ] Emulator 清理流程／權限／冪等／故障注入測試通過。
- [ ] GitHub CI 通過、必要審查完成；正式刪除另行明確批准。
- [ ] 清理後有逐集合對帳與主檔保留驗收證據。

## 7. 變更界線

此文件只定義清理範圍與驗收門檻。**不修改前端、交易核心、Firestore Rules、索引、正式資料，也不部署 Firebase。**  
下一階段另行處理「盤點工具及受控一次性清理工具」；與手動採購 PR #284／採購交易 #268／Rules #199 的程式修復分開，避免影響 P0 任務。
