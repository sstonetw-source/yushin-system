# 2026-10-31：歷史分支唯讀盤點與一次性清理

**資料來源**：當次 GitHub API 的 199 個 branches 與 377 個已關閉 PR；唯一正式主線 `main` SHA `47c471290370c3757041ac143d99f7321c9d3d95`。

## 分類與處理

| 分類 | 數量 | 處理 |
|---|---:|---|
| 目前 branch head = 已合併 `main` PR head | 152 | 經執行時重新核對後刪除 |
| 目前 branch head = 已先合併到 #234 整合分支的 PR head，且早於 #234 合併 `main` | 18 | 經執行時重新核對後刪除 |
| 有 PR 但未合併 | 21 | 保留，另行比對 patch/功能 |
| 合併後有新 Commit | 2 | 保留 |
| 無 PR | 4 | 保留 |
| 合併到上層分支時間晚於上層進 `main` | 1 | 保留，可能有遺漏內容 |
| **合計非 main** | **198** | **清理候選 170／保留 28** |

完整分支、head SHA、PR、關閉或整合來源見 `docs/maintenance/branch-inventory-20261031.json`。

## 安全刪除條件

此工作流程僅在 **合併此 workflow 檔到 `main` 的 push** 執行。執行前逐筆從 GitHub API 重新檢查：PR 已 merged、同倉庫、head SHA 與分支現在 SHA 完全一致、`base` 為 main 或已證實早於 #234 合併的相依 PR、分支不受保護、沒有 Open PR、`main` 永遠不刪。當任何條件不符時跳過。只執行 `deleteRef`，不修改 Commit、Rules、Firebase、正式資料或功能旗標。Workflow 執行結果會在 Actions 日誌與 Summary 記錄。

### 特別保留

- `preview/multi-item-order-model-20260920` #28 在上層 #27 合併 `main` **之後**才合併，不得因顯示 merged 直接刪。
- `preview/inventory-warehouse-forecast-20260920`、`refactor/architecture-unification-20261015` 在原 PR 合併後 head 已前進，保留。
- #283、#290、#338、#377、#385、#390 等未合併或 superseded 的原始分支保留，待逐檔或功能驗收後另行處置。

## 可復原性

刪除分支 **不會刪除 Git Commit 或已合併的 PR 內容**；但歷史 dangling commits 可能遭 GitHub 垃圾回收，因此只清理具備合併證據且 exact head 不變的分支。此次不刪除保留清單，亦不透過強制推送修改歷史。

## 實際執行與安全驗證（已完成）

- PR [#397](https://github.com/sstonetw-source/yushin-system/pull/397) 已合併 `main`：`efe5a8cd86d5d3b64b27d2ac5d52f01dced2cf25`。合併前 CI 10/10 全綠，含 required `regression`。
- 一次性 [GitHub Actions run #41095913044](https://github.com/sstonetw-source/yushin-system/actions/runs/41095913044) **completed/success**。原始 Job 日誌：`Merged-branch cleanup: deleted=170, skipped=0, failed=0, retained_for_review=28`。
- 刪除後重新查詢 GitHub branches 共 **29 個**：main 1 + 待查 28；未發現超出清單的刪除。
- 一次性 `.github/workflows/branch-cleanup-20261031.yml` 清理完成後由後續 PR 移除，以免倉庫長期留存 `contents:write` 的分支刪除流程。歷史 workflow 程式及審計日誌仍保留於 PR #397／run #41095913044。
- 仍未證明的 28 分支全部保留，尤其 #28 晚於父 PR #27 進 main 的合併；要先進行逐項等效性比對再考慮刪除。此步驟未改 Firebase、Firestore Rules、正式資料、交易程式或正式旗標。

