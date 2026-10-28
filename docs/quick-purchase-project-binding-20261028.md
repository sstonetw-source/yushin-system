# 手動採購後端切換：專案綁定補強（2026-10-28）

## 本批完成條件

1. 受控手動採購的預設 App、Auth、Firestore、Functions 必須屬於同一個授權專案。
2. Firestore 綁定缺失或錯配時，在 Callable 前拒絕；非同步 SDK 載入結束後再次確認 Firestore 綁定。
3. 不觸發舊 client transaction，不清除既有待確認憑證；恢復正確連線後沿用原 operationId。
4. 原成功、回覆遺失、權威回讀及重送測試維持通過。

## 修改

`src/services/quick-purchase.js` 原本已檢查 App/Auth/Functions，現在也檢查實際 `db.app.options.projectId`，避免後端提交與前端權威回讀分屬不同專案。Emulator、Preview、production 各沿用原授權專案與旗標，不新增 writer 或數量公式；同步產生 app.js。

測試使用三環境的 App/Auth/Firestore/Functions 缺失或錯配矩陣，核對零 RPC、零 legacy transaction，以及有／無既存 checkpoint 的行為。另驗證 SDK 載入期間 Firestore 錯配與修正後原 ID 重送。既有 VM fixture 補上與真 Firebase compat SDK 相同的 Firestore app 身分。

## 已執行驗證

- `node --test tests/quick-purchase*.test.js`：31/31 通過，無略過。
- 一般應用 Node 測試（排除獨立 Firestore Rules 測試）：1,892/1,892 通過，無略過。
- app 與 Functions 共用核心產物一致性、語法及 diff 空白檢查通過。
- 本機未執行 Auth/Functions/Firestore Emulator 或 Chrome；完整流程由 PR CI 執行，結果須另核對，不能用 VM 測試代替。

## 與既有工作分界

以 main `115e4d3388a7c40371001c2525ae7c8d0c74192e` 為起點，沒有帶入尚未合併的收貨 PR #309–#318。main 已有原 Quick Purchase 桌機／手機測試，桌機包含後端成功後中斷 HTTP 回覆、重新載入並由原復原面板重送；不能再沿用「只有 VM 模擬刷新」的舊交接結論。

本批未部署、未啟用旗標、未改正式資料／Rules／Index／Collection／Listener。#268 的正式 purchaser 403、#199 的正式 PO 入口與正式切換仍未宣稱解決。正式舊 client writer 仍在使用，須等後端正式切換及驗收後再獨立移除，不可在此提前刪除。

下一個具體工作：核對 PR #307 與本批的完整 CI 及六項固定驗收證據，整理可審閱的部署／旗標切換／原操作恢復方案；正式切換依專案指示另行授權。

Refs #268, #289, #291.
