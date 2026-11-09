# 2026-11-09｜交易舊路徑與系統說明核對

## 後續核對｜P0 期初庫存及盤點切換缺口

最新遠端基準：`main` `9aa4ccbb9f1ab21d6358afa7bcedb94ccf32eafa`；PR #522 的
`0bb3d06e600512f3bdeb042b73aeac114d753910` 仍為 Draft，完整 CI 10/10 通過、
**未合併、未部署、未切換入口**。本段僅比對已存在的程式碼和 GitHub 紀錄，
不代表已即時讀取正式 Firebase 的部署狀態。

| 原始操作入口 | 目前寫入所有者 | 後端專用 Rules 切換前的缺口 |
| --- | --- | --- |
| 期初、人工調整、報廢及批次庫存匯入 | `src/services/manual-inventory.js` 的 `commitManualInventoryAdjustment` 直接以瀏覽器 `runRoleTransaction` 寫入公司／分倉庫存、批次、成本與異動憑證 | `functions/index.js` 尚無對等 Admin SDK Callable；切換 Rules 後不能靠原匯入頁初始化 |
| 庫存數量盤點 | `src/services/inventory-count.js` 的 `commitInventoryQuantity` 直接以瀏覽器 `runRoleTransaction` 寫入公司／分倉及批次／異動 | `functions/index.js` 尚無對等 Admin SDK Callable，盤點將被後端專用 Rules 阻擋 |
| 主倉備貨需求的建立、取消、寄出及收貨 | PR #522 將 `requestId` 路徑交給既有後端，並清掉不可到達的舊需求寫入 | 正式旗標預設關閉；PR 不能先合併發布，舊瀏覽器也須由正式 Rules 封鎖 |
| 一般調撥與訂單調撥 | `src/services/warehouse-transfer.js` 還有非需求型直接瀏覽器 stock writer；訂單調撥後端已有獨立 Callable | 正式三個 ORDER_TRANSFER 前端旗標仍關閉，普通調撥的替代範圍須先界定，不能整段刪除 |

**新阻礙 [Issue #523](https://github.com/sstonetw-source/yushin-system/issues/523)：**
在部署 PR #521 的後端專用庫存 Rules 之前，必須實作並驗證期初庫存／人工調整／報廢／盤點的可信任後端，
或經明確商業決策將受影響操作保持停用；**禁止恢復舊瀏覽器 writer 或放寬 Rules**。
測試至少涵蓋權限、冪等、並行、故障重試、批次成本、不可負庫存、公司及分倉一致性。

另外 [Issue #334](https://github.com/sstonetw-source/yushin-system/issues/334) 記載
2026-11-03 已執行正式舊交易資料清除與庫存歸零；這是既有核對紀錄，
本次沒有再次清除，也尚未重新即時驗證正式資料。後續 C 項應先核對此結果，
不得因缺少最新清理狀態就重複刪除。

---

基準：`main` `5099e397417482a0e35d85feff52df175948068a`（PR #514）。本文件區分**程式碼存在、目前入口路由、正式後端部署、真實角色驗收**，不能以任一項取代其他項。這次核查以版本庫靜態分析與目標測試為主；不等於正式 Firebase 的完整即時證據。

## 本批移除／修正（合併與正式發布仍須另外確認）

| 類別 | 位置 | 處理 | 原因 |
| --- | --- | --- | --- |
| 舊正式前端網址允許條件 | `transaction-rollout-config.js`、`src/services/formal-purchase-order.js`、`src/services/supply-order.js`、`src/services/quick-purchase.js` | 正式交易僅允許 `https://sstonetw-source.github.io/yushin-system/` 路徑；舊 Firebase Hosting 網址不能啟用採購及在途後端 | 符合「正式前端完全不使用 Firebase Hosting」及唯一正式來源 |
| 舊採購單清單讀取 | `src/features/purchasing/purchasing-workspace.js` | 移除 `poListLegacy` 與以 `poNo` 重新查歷史清單的額外查詢；只以 `createdAt` 分頁 | 已決定放棄舊交易測試資料，避免額外讀取、排序和混合結果 |
| 訂單頁說明 | `modules/page-help.js` | 明示打單≠實際出貨／扣庫、出貨≠送達、撤銷送達≠退貨、取消訂單≠取消 PO | 避免操作員將不同交易事件視為同一步驟 |
| 倉庫頁說明 | `modules/page-help.js` | 正式訂單調撥尚未全部開啟時顯示停用說明，明確禁止改用舊瀏覽器提交 | 對齊目前訂單調撥後端啟用階段 |

保留 `src/infrastructure/firebase.js` 裡的 `authDomain: yu-shing-company.firebaseapp.com`：這是 Firebase Authentication 設定，**不是**啟用 Firebase Hosting 前端的允許條件；不可誤刪。

## 尚未可宣稱完全清除的路徑

| 風險 | 位置／狀態 | 必要收斂條件 |
| --- | --- | --- |
| **P0：正式調撥入口不可開放** | `transaction-rollout-config.js` 的 ORDER_TRANSFER 三組 backend/legacyBlocked 仍是 `false`。PR #514 只合併後端 `.env`；三個 Functions 正式重新部署尚未驗證 | 限定部署 `dispatchOrderTransfer`、`handoffOrderTransfer`、`receiveOrderTransfer`；驗證執行時四個環境旗標，再另行切換前端入口與 GitHub Pages 發布。後端切換失敗必須安全中止 |
| **P1：舊瀏覽器調撥 writer 仍留在程式** | `src/services/warehouse-transfer.js` 保留舊 `runRoleTransaction` 路徑；`modules/warehouse-logistics.js` 仍透過 `commitWarehouseTransfer` 共用入口。正式資料庫 `settings/orderTransferCutover.backendOnly = true` 用於拒絕訂單調撥舊寫入，但此項需在正式新版可用後持續檢驗 | 區分訂單調撥、一般備貨調撥與業務交接；三種新後端及真實角色驗收後，移除對應舊 writer；不能把尚無後端替代的普通調撥直接刪到無法出貨 |
| **P1：其他交易 Service 保留非正式舊 writer 分支** | `src/services/formal-purchase-order.js`、`quick-purchase.js`、`order-lifecycle.js`、`delivery-records.js`、`receiving.js` 等含 Emulator／Preview 或舊資料操作支線。正式路徑多數已有後端防回退閘門，但「程式碼已不存在」不成立 | 逐項檢查所有呼叫點、正式 Rules 拒絕證據、後端取代功能；確認無正式呼叫者後分批刪除、調整測試，不能只因名稱含 legacy 就刪除共用純 Core |
| **P1：舊版靜態頁面快取** | 舊 Safari／Chrome、主畫面捷徑可能仍持有舊 `app.js` | 發布時更新資產版本；維持伺服端舊 writer 拒絕，正式驗證從舊頁面不可提交，不能以新頁面驗證替代 |
| **P2：歷史顯示支線** | `src/features/orders/delivery-actions.js` 與 `src/features/orders/lifecycle-workspace.js` 有舊送貨日期推估／取消推估畫面；估價單、產品主檔、廠牌也有舊資料讀取 | 交易資料重置且新單生命週期驗證後，再移除舊送貨推估；估價、產品、廠牌不是可放棄的交易資料，需另外確認 |
| **P2：舊 Functions 名稱** | `functions/index.js` 的 `sendPurchaseOrderEmail` 是明確拒絕的舊呼叫端點，部分服務案件 Callable 僅 Demo 可用 | 分別查核正式呼叫者、部署列表與依賴；需個別取得 Functions 刪除／部署授權後才能安全退役 |

## 與系統說明的差異

1. 原訂單說明「完成打單的品項可先送貨」容易被理解為打單即實際出貨；已改為事件分離說明。
2. 原倉庫說明沒有展示調撥切換狀態；已新增隨正式前端旗標調整的提醒。**前端旗標不是後端已部署的證明**。
3. `docs/ARCHITECTURE.md` 的多篇 10 月試點段落與當時 PR、Demo／Preview 狀態屬歷史記錄；不可直接當成 11 月正式狀態。新工作請先參閱本文件、最新 `main` 和實際部署證據。
4. `docs/HISTORICAL_REQUIREMENTS.md` 的日期與發布欄是 11/05 等較早基線；正式上線結果需以後續版本、部署及真實角色驗收更新。

## 不變的安全限制

- 只允許既有 GitHub Pages 發布正式前端；不得部署任何 Firebase Hosting 或 Preview Channel。
- 不刪 Firestore 正式資料、Auth、角色、系統設定或既有 Functions。
- PR 合併不等於 Functions 部署；Functions 部署不等於前端啟用；前端啟用不等於正式驗收。
- 不為了刪除舊程式而恢復 SDK writer、改變商業規則或讓庫存可重複扣帳。
