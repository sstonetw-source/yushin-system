# 一次性 Firestore 舊營運資料清理（Issue #334）

> **注意：正式清理尚未執行。** 此工具不會由 `functions/index.js` 載入、也不會隨 Firebase Functions 部署。預設只有唯讀盤點。

## 範圍

- 正式專案 `yu-shing-company`，Firestore `(default)`，Standard，`nam5`。Preview `preview-20135` 於 2026-10-28 的 Firebase Console 顯示「最近已遭刪除」；不要嘗試自動復原。
- 刪除：舊訂單、採購、供應、報價、預測、進出貨、預留、批次、調撥、服務、操作憑證、稽核日誌等 `operational-reset-policy.js` 列出的交易根集合；包含文件底下的子集合。
- 保留：商品、供應商、客戶、使用者、倉庫、成本主檔、品牌、設定等主檔。`inventory` / `warehouseStocks` 文件保留，但庫存數量欄位設為 0；若有內嵌 `lots`，清空陣列。
- 只允許列在 policy 的頂層集合；發現未知根集合必須先審查並修改 PR，不能直接執行。

## 驗收前置條件

1. 使用者已明確授權**不備份**舊資料（2026-10-28）；這不表示可刪除主檔或整個資料庫。
2. 必須先阻止網頁、Cloud Functions、排程與其他所有程式對交易／庫存集合寫入；命令的 `--writes-frozen` 是操作者聲明，**不是自動鎖定**。
3. 在執行機器設定 Firebase Admin SDK Application Default Credentials，且身分必須僅對指定專案有讀取／刪除／更新 Firestore 的必要權限。不要將金鑰、登入代碼或憑證放入 GitHub 及對話。
4. 先在 Emulator 上以可控制的測試資料完成 dry-run、刪除及殘留驗證；再對正式專案跑 dry-run 審閱筆數。
5. 先確定 `products` 等主檔中的內嵌交易欄位及主檔子集合是否需要清理；目前腳本刻意不修改主檔，這些內容可能仍需另外盤點。

## 使用

在 repository 根目錄安裝 Functions 依賴（`npm --prefix functions ci`，依現有鎖檔狀況調整），再執行：

```bash
node functions/scripts/one-time-operational-reset.js --project=yu-shing-company
```

這只會輸出 root classification、各待刪根集合的**頂層文件數**及庫存非零／批次數目，不會寫入。子集合文件沒有包含在計數中。

通過 Emulator 驗收、人工核對所有根集合、完成寫入凍結後，才能執行：

```bash
node functions/scripts/one-time-operational-reset.js --project=yu-shing-company --execute --skip-backup --writes-frozen --confirm=DELETE-OLD-OPERATIONS:yu-shing-company
```

這個命令**無法回復**：`recursiveDelete` 會實際刪除文件及子集合；所有集合與庫存寫入並非同一全域原子交易。中途失敗應保持所有寫入凍結、檢查錯誤並可重跑，不能恢復正常營運直到驗證全部通過。

## 驗收

- 工具輸出 `status: VERIFIED`，待刪根集合從 Firestore 不再出現。
- 保留根集合仍存在；`inventory` / `warehouseStocks` 每筆 `onHand/reserved/available/incoming/shortage` 為 0，內嵌 `lots` 為空。
- 另外以管理端獨立查核 29 個先前存在的根集合及任何巢狀交易集合、交易入口和前端列表。確認不會被舊寫入工作重建後才解除凍結。
- 目前 29 個正式頂層集合中：15 個刪除、12 個保留、2 個歸零；未出現的潛在交易集合在 policy 內仍須處理。

## 限制

- 本工具不是備份或還原功能，使用者已明確選擇跳過備份。
- 預檢根文件數不含子集合；Firestore 管理權限、配額、費用與長時間刪除仍可能阻擋執行。
- 不處理 Firebase Authentication 使用者（依授權保留）。
- 不會自動清除保留主檔內的嵌入交易紀錄；若有此類欄位，必須追加獨立驗證／清理。
- 不可使用既有前台 `executeTestDataReset()` 替代，因它保留 `quotes`，且遇到調撥紀錄會中止。
