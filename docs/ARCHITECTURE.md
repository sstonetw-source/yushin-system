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
| Features | `src/features/products/`, `forecasts/`, `quotations/`, `orders/`, `purchasing/`, `equipment/`, `administration/` | 使用者介面、查詢、表單、顯示。部分業務計算仍混雜，尚需透過 service 抽離。 |
| Transaction workflows（過渡區） | `src/features/transactions/transaction-workflows.js` | 現有收貨、出貨、取消等操作入口；目前仍混合 UI、Firestore 寫入、協調，不應被視為乾淨 service。 |
| Core | `modules/workflow-core.js`, `fulfillment-core.js`, `inventory-core.js`, `reservation-core.js`, `procurement-demand-core.js`, `receiving-core.js`, `supply-core.js`, `order-entry-core.js` | 驗證、純數量投影、供貨／預留演算法。不可在 feature 另造權威公式。 |
| Shared transaction infrastructure | `modules/stock-permissions.js`, app 的 `runRoleTransaction` | 以 Firestore Transaction 執行、附加庫存變更證明。**所有寫入未必已經走同一路徑，待持續稽核。** |
| Workspace / 既有 UI 模組 | `modules/inventory-workspace.js`, `warehouse-logistics.js`, `customer-cancellations.js`, `delivery-settings.js`, `order-entry-ui.js` 等 | 含 UI 與流程呼叫；重複業務規則應逐步改呼叫共同核心。 |
| Infrastructure | `firebase.json`, `firestore.rules`, `firestore.indexes.json`, `functions/` | 儲存、權限邊界、索引與伺服端工作。正式與 Preview 環境不能混用。 |
| Shared | `modules/document-downloads.js`, `page-help.js`，以及現有 app 共用工具 | 共用下載、說明與視圖輔助；不擁有交易事實。 |
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
6. PR #91 為**獨立待合併**的取消／恢復修正；整合時需驗證本分支的新來源檔與生成 bundle 一致，避免直接在 bundle 解衝突。

## 修改方式

```sh
node tools/build-app.cjs
node tools/build-app.cjs --check
node --test tests/app-source-integrity.test.js
node --test $(find tests -maxdepth 1 -name '*.test.js' ! -name 'firestore-rules.test.js' | sort)
```

重整期間任何 commit 若只修改 `app.js` 而未改 `src/`，CI 應失敗。後續模組化要逐步把業務操作和共享狀態從 feature 移至真正服務模組，而不是建立平行 copy。
