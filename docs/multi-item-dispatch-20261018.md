# 整單履約投影與多品項打單

基準 main `71cd8fe5`（PR #172）。本批把既有內部 v2 打單 Service 接上原履約 Core 的整單投影，支援 1–5 個穩定品項。仍僅 demo-yushin Emulator，未接正式 UI／Callable 或部署 Firebase。

## 權威 Core

`modules/fulfillment-core.js` 新增 `projectOrderShipmentReturns`，先驗證完整品項與全部事件，再按穩定 itemId 分組呼叫原 `projectShipmentReturns`。每品項出貨、待送達、有效交付、CLOSE／REPLACE 及剩餘需求的算法不變；整單只合計這些權威結果。全部品項都送達才算整單完成，不能把某一品項的 deliveredQty 當成全單總量。

來源限 1–5 筆唯一 ID、正整數且 qty／orderedQty 一致；shipments／deliveries／returns 各最多 200 筆。未知品項、重複事件、不同訂單或產品、跨品項借用 shipmentId、錯誤日期及超過安全整數的合計均拒絕。不能先 filter 再忽略找不到來源的紀錄。Core 沒有資料庫、庫存、批次分配或權限寫入。

以原 `tools/build-functions-core.cjs` 產生 functions/shared 副本。已執行既有 app.js 建置工具及一致性檢查；沒有 src 改動，因此 app.js 無需改變內容。

## 原 Service 接線

| 責任 | 本批行為 |
|---|---|
| `commitLocationDispatchPreparation` | 原入口／固定 operationId／intent hash 不變；讀真實 profile，支援最多五個實體倉品項 |
| 原 `readLocationReturnProofs` | 多品項時只做一次整單有界查詢，先核對所有實際退貨憑證數量／品項，再逐品項交給原 Core 驗證 hash 與完整入庫紀錄 |
| 原出貨證明 | 多品項打單前讀取所有原出貨 movement，沿用 `validateShipmentMovement` 核對真實扣帳與批次明細 |
| 原預留 ledger | 同一 transaction 核對每個品項的來源、所有權、數量、狀態及原雙倉範圍；不借用另一品項預留 |
| 打單量 | 仍由原 `warehouseShipmentState` 計算待打單及可出貨量 |
| 寫入 | 原 dispatchRecords/v2-{operationId} 與 orders.items 同交易；只更新選定品項 dispatchPreparedQty，其他品項原樣保留 |

打單不修改實貨、分倉、ledger、批號、出貨或送達紀錄。採購 incoming 不參與打單額度。相同 ID 已提交就回原結果；改角色、換 actor 或換意圖不能挪用。不同 ID 競爭時重讀當前打單量，不能超印；不同品項同時執行仍透過讀取來源訂單的 transaction 衝突重跑保留各自更新。

單品項既有流程與 schema 保留。多品項仍只接受正常且初始化 completed 的實體倉訂單；服務型／直送混單、停用產品、調撥途中、錯誤 sibling ledger／整單履約投影全部拒絕。REPLACE 目前僅 Core 有計算能力，打單入口仍沿用 CLOSE-only 驗證，不因此開放補送流程。

## 驗收

新增 7 項 Core 行為測試，涵蓋同產品兩列的逐品項一致性、全單送達、CLOSE／REPLACE 的原語意、未知／重複事件、跨品項引用、日期與實際當日已交付上限、五品項／事件上限及數量 overflow。

新增 11 項 Firestore Emulator 打單測試，涵蓋真實整單初始化、同產品五列、原兩倉與需求缺口、五角色及目前停用／角色異動、重試與競態、不同品項並行、兄弟商業資料保留、損壞來源與原候選倉拒絕、末端 create 碰撞回滾、回覆遺失及不同 actor 重送。

履約／退貨證明案例由原單品項出貨／送達／CLOSE Service 產生真實憑證，再 seed 一筆獨立 v2 sibling，以驗證新的整單讀取與打單。包含另一品項已有交付／退貨、扣帳／入庫憑證損壞及刪掉 return cache 但實際入庫憑證仍在時拒絕；**不把這些 fixture 說成多品項出貨／退貨 writer 已完成**。

全套 Node、Firestore／Auth／Functions Emulator、Rules 與八組桌機／手機 Chrome 以此 PR CI 為準。Chrome 使用記憶體傳輸；整單初始化／打單仍為 Admin SDK 測試 adapter，正式登入瀏覽器／Preview 全線 E2E 尚待驗收。沒有新 Collection、Rules、正式權限修改或資料遷移。

## 接續工作

1. 讓原出貨／送達 Service 使用此整單投影及原證明 reader，完成多品項跨倉分批出貨與獨立送達；不能直接刪除單品項限制。
2. 收貨 Service 在多品項已有打單／出貨後仍會拒絕，須接同一整單投影及原憑證驗證，才能繼續分批收貨。
3. 多品項取消剩餘、恢復、CLOSE 退貨與取消 KEEP_STOCK 收貨；服務型／混合直送、超過五品項仍待契約。
4. 真實 Auth 傳輸、Preview 及正式 UI 接線與完整端對端驗收。草稿 #131 保留失敗分析，不移植其 Rules 寫入方案。
