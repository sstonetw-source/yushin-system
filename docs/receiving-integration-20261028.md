# 收貨後端與預留初始化整合（2026-10-28）

## 固定驗收與範圍

以已通過完整 CI 的 main `ef0e3328e09630184bcee8797f0d65bdf9c3f3a3` 為基礎，整合 #309、#313、#314、#315、#316、#317、#318 的既有變更。這是交易架構整合與舊包裝清理，沒有新建數量帳、writer 或前端框架。

1. 真 Auth/Functions/Firestore Emulator 與原站均沿 functions/index.js 的唯一 receiveV2Supply 匯出，已無呼叫者的舊 adapter 收貨 import/export 移除。
2. 實體收貨來源支援 1–15 品項，直送仍限制 1–5；同一 transaction 重新核對角色／來源／PO／庫存／預留／需求，沿用 main #312 的讀寫預算與失敗零寫入保護。
3. 分批到貨、原 ID 重送、回覆遺失及頁面重載不重複入庫；成本仍只留受保護集合，Service 品項不產生實貨帳。
4. 直送確認共用原 PO 來源查核，不再反推倉庫缺貨或假預留；異常既有預留仍交由原交易檢查，不掃描或改寫正式舊資料。
5. 原整單雙倉初始化支援 1–15 個唯一來源品項，仍限 demo Emulator；保留即時角色／負責人、原 attempt、全部來源及同倉庫存競爭／冪等檢查。
6. 保留 #322 的手動採購專案綁定與旗標停用後的未確認憑證保護，完整一般回歸、原站、Emulator 及 Rules CI 全綠後才合併。

## 整合處理

先前本機預檢的唯一衝突在 supply-receipt-service 舊5列／新實體15列准入區段；採用已在原分支驗收的實體15、直送5契約及直送PO查核，保留 staged transaction 預算。同步最新 main 後沒有新增衝突或修改數量公式。

#309 原始提交與 #315 的整合版不是同一 commit，但其隔離 gate／Callable 契約已由 #315 合入同一入口。本整合保留兩者為父提交，讓原 PR 可追溯；不以刪除舊測試 wrapper 當作已刪除正式 client writer。

順帶更正 functions/index.js 過時的手動採購註解，使其與 main #307／#322 的三環境獨立、預設關閉 gate 一致；沒有改變旗標值或可用環境。

## 驗證證據

- 同步最新 main 後，本機一般 Node 1,917/1,917 通過，零失敗／略過。
- app.js 與 src、Functions 共用核心與收貨 runtime 產物一致；語法及 diff 檢查通過。
- #309／#313–#318 各原 head 的完整 CI 已成功；各自結果不能代替本整合 head 的 CI。
- 本機未執行新組合的 Chrome 或 Firebase Emulator。整合後完整 CI、五角色及原站1280／390px、15品項交易預算／競爭／重送與 Rules 結果待 PR 執行後核對，不提前宣稱通過。

## 發布分界與後續

後端只允許 demo-yushin Emulator 或獨立授權的 preview-20135，production 無法透過此收貨 gate 啟用。前端核對實際 App/Auth/Functions/Firestore 專案，錯配、未授權或回覆不明均不得改走舊交易。

沒有部署 Firebase、開啟旗標、改正式資料／Rules／Index／Collection／Listener／PDF，也沒有移除仍在使用的正式 client 收貨。真 Preview 尚未部署驗收；project facade 僅證明授權分支與 writer 可整合。正式切換與正式舊 writer 移除仍須後續獨立驗收及授權。

15品項來源的建單畫面、採購、打單、出貨、送達、取消／恢復／退貨不因本批一起開放；部分來源仍由 Admin fixture 建立，不宣稱完整15品項原建單到履約端到端完成。

本階段完整 CI／審查完成後，接續核對現行未完成交易入口及其1–15品項契約；發現新的實質缺陷另建獨立 Issue／PR，不持續擴充本批同類測試。

Refs #308, #291, #309, #313, #314, #315, #316, #317, #318.
