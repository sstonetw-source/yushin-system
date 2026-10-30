# 2026-10-31：剩餘分支的主線歷史追溯

查核基準：`710c40226cc742fcb3419dae3922f200aa959161`。起始 Open PR 0、分支 25（main 1 + 待查 24）。本批完成 7 個分支的整合證據，其餘 17 個保留。

## 查核方法

以完整 Git 歷史重算 merge base／全部變更檔；驗證整合 commit 是目前 main 的祖先，再比對整個變更集合在同一主線歷史版本的 blob。不能僅因某個 blob 曾出現就認定整批已整合；非完全相同的少數檔案另逐行檢查。先前的反向 patch 初篩不作為功能遺漏的結論。

| 分支 | 原 PR | 主線整合來源 | 完全相同檔案 | 差異判斷 |
|---|---|---|---:|---|
| `feat/multi-item-shipment-20261018` | 無 | `7013df0` / #174 | 8/10 | 10 個變更檔中 8 個與主線 #174 完全相同；ARCHITECTURE 僅增加多品項出貨實作說明，Emulator test 將原本硬編碼 0/false 改為保留原 deliveredQty/isDelivered 的斷言，沒有移除案例或弱化數量／原子性檢查。 |
| `feat/order-amount-details-20261025` | #283 | `69a6a64` / #292 | 23/26 | 26 個變更檔中 23 個與 #292 完全相同；其餘 app.js 僅加入 #290 Preview 採購路由，Rules 與 Rules test 僅增加 #288 metadata 去重及正反向測試。原訂單金額、商品明細與 15 品項變更完整保留。 |
| `feat/quick-purchase-preview-backend-gate-20261025` | #290 | `69a6a64` / #292 | 5/6 | 6 個變更檔中 5 個與 #292 完全相同；唯一不同的 app.js 為同次整合的 #283 UI，quick-purchase.js 原始碼與 #292 相同，後續 main 另加獨立 production gate、專案綁定及 pending 禁止回退。 |
| `preview/inventory-warehouse-forecast-20260920` | #29 | `7cf9104` | 1/1 | 所有變更僅 app.js；其 blob 與 main 歷史提交 7cf9104 完全相同。雖 #29 closed-unmerged，但修改確實以相同內容進入主線。 |
| `preview/multi-item-order-model-20260920` | #28 | `7cf9104` | 1/1 | 所有變更僅 app.js；其 blob 與 main 歷史提交 7cf9104 完全相同。解除先前 #28 晚於父 PR 合併的疑慮，依實際主線內容而非父 PR 時間判定。 |
| `refactor/architecture-unification-20261015` | #94 | `c1bac37` / #95 | 49/49 | 完整 49 個變更檔在主線 #95 的 c1bac37 同時逐檔完全相同，包含新增 DATA_MODEL 與契約測試；分支後續修改並未遺漏。 |
| `refactor/transaction-core-unification-20261015` | #92 | `3610ddd` | 4/5 | 5 個變更檔中 4 個與主線 3610ddd 完全相同；index.html 唯一差異是 app.js 資產版號由 20261015-11 升到 20261015-15，沒有移除原入口或商業邏輯。 |

這些主線祖先是已完成的歷史整合來源，不是此次新部署。現在 main 的功能仍須依各 Issue 的正式驗收狀態判讀；刪除歷史分支不等於關閉交易問題。

## 驗證與清理邊界

- 相關現行 Node 定向測試 67/67 通過，app/functions core 生成檔檢查通過。
- 未新增或修改交易程式、Rules、旗標或正式資料；新 PR 仍須通過既有完整 required regression。
- 一次性流程只允許 JSON 中七個固定 branch/SHA，執行前再查原 PR、整合 PR、主線祖先、當前 main blob、分支保護與 Open PR。任一不符跳過，不強推或刪 main。
- 清理完成後移除一次性高權限流程，保留此文件、JSON 與實際 Action 紀錄。

## 保留待查

| 分支 | 原 PR |
|---|---|
| `fix/20260920-critical-integrity` | #26 |
| `fix/forecast-ui-brand` | 無 |
| `fix/legacy-reservation-v2-failclosed-20261017` | #123 |
| `fix/lifecycle-duplicate-item-identity-20261015` | #91 |
| `fix/order-autofill-batch-stock` | 無 |
| `fix/order-deletion-linked-record-integrity-20261015` | #89 |
| `fix/product-search-and-stock-diagnostics-20261014` | #65 |
| `fix/reservation-proof-coverage-311` | #338 |
| `fix/stocked-order-purchase-queue-20261014` | #64 |
| `fix/system-terminology` | #51 |
| `merge/all-open-prs-20261025` | #276 |
| `upgrade/admin-simplify-20260924` | #41 |
| `upgrade/ci-integration-validation-20261028` | #344 |
| `upgrade/discussion-fixes-20260923` | #40 |
| `upgrade/final-ui-simplify-20260924` | #42 |
| `upgrade/purchasing-three-workspaces-20260924` | #43 |
| `upgrade/remove-product-line-assignment-20260923` | 無 |

#338 的 Rules 原型與 #344 等包含該原型的分支仍保留，不把曾觸及運算上限的實驗直接合回主線；其餘分支需核對已重構的入口及測試意圖。
