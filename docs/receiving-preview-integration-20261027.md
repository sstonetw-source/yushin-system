# 收貨入口與 15 品項整合候選（2026-10-27）

整合 #309 的雙側 Preview gate、#310 的純投影、#312 交易預算、#313 後端 15 品項與 #314 原站驗收。這是程式整合與隔離測試，不是 Preview 或正式部署。

## 實際改變

- 原整站 Emulator fixture 改用 `functions/index.js` 真正匯出的 `receiveV2Supply`，與待部署入口相同。原先 `v2-return-callable-adapter.js` 的重複收貨 wrapper 已無呼叫者，刪除此 import／export；其他退貨與履約 wrapper 不變。
- 後端、runtime 的授權與 15 品項上限同時保留，所有交易仍經既有 Receiving Service 和讀寫預算，不重建收貨 writer。
- 前端除了 Auth、Functions、預設 Firebase App，也核對實際 `db.app.options.projectId`；任一不符、缺失、Preview 混入 Emulator Auth、非授權站點或關閉旗標，均在收貨 RPC 前中止。
- Preview 仍需 `ENABLE_PREVIEW_RECEIVING=true`、前端 `YUSHIN_PREVIEW_RECEIVING=true`、固定 preview-20135 專案與官方站點。production 專案無法透過此 gate 啟用。後端未回覆或結果未知時不得退回舊 client writer。

本批沒有啟用任何旗標、沒有部署 Firebase、沒有改正式資料、Rules、Index、Collection、Listener、商業數量定義或正式 PDF。正式環境使用者的操作仍不變；只有隔離測試改為走實際匯出入口。正式舊 client 收貨尚未刪除，必須等正式切換驗收後另批移除。

## 驗證分界

- 前端及入口定向測試包含 Firestore 誤接另一專案，在 RPC 前零送出；原身份、原操作識別與真實 receipt 回讀仍保留。
- 6／15 品項的 Auth → 實際匯出 Callable → Firestore Emulator、五角色限制、餘量競爭與重試，以及 1280／390px 原站收貨走同一入口。
- 新增 Preview-gated handler 對 Emulator-backed project facade 的完整收貨測試：成功提交、原 ID 重試不重寫、關閉／正式／混入 Emulator 的 gate、錯誤 DB 與缺 Auth 拒絕、即時停用拒絕。此案例故意把專案名稱 facade 與 Emulator 儲存綁在一起，只能證明授權分支與 writer 可整合；不能當成真實 Preview Auth／Firestore／Functions 實測。
- 交易量測原本直接呼叫 Service；現在明確傳入已隔離的 Functions Emulator 環境，避免把 Node 測試 runner 誤當 Functions child process。不放寬 backend gate。

本機一般測試與定向 Emulator 的最終數字記錄於 PR。完整 CI 仍須最新整合 head 通過；#312／#313 的已通過結果只屬各自 head，不能替代本整合候選的 CI。

## 後續順序

完成本候選最新 CI／審查並整合後，才能依授權進行真實 Preview 部署及固定五角色驗收；其後另建預設關閉的正式入口候選。15 品項建單初始化、PO、打單、出貨、送達、取消退貨仍各有原有上限，不因收貨整合而自動放寬。
