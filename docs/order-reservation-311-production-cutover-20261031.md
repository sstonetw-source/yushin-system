# #311｜整單預留正式切換檢查清單（2026-10-31）

> 這是部署前可審閱清單，**不是正式部署或資料清除紀錄**。正式 Firebase Rules、Functions、前端旗標、營運資料清理仍分別受專案授權邊界約束。

## 1. 最新程式與已知正式狀態

- 最新已核對 main：575f132b2526f57313f83f9c6bfad33e80ad4026（#409 已合併；該 PR 只修復 #334 清理工具保留估價單）。
- #404：整單預留狀態和庫存／憑證同一後端交易；#406：跨倉單倉選擇及多倉 fail-closed；#407：網站移除舊逐筆初始化 SDK writer；#408：Firestore Rules 封鎖舊快取初始化寫入。皆已合併 main；#408 PR CI 10/10 通過（含 required regression）。
- 最後一次管理端實際回讀：正式 yu-shing-company 的 commitOrderReservationPreview ACTIVE，但來源仍是早於 #404/#406 的 main 951f341，函式 hash adf722fddd9ecc4fcabce826023ecf03586dca65，後端雙旗標未設定、功能未開；上線前**必須重新回讀**最新狀態，不可沿用此快照作已更新證明。
- 原前端設定 transaction-rollout-config.js 的 YUSHIN_PRODUCTION_ORDER_RESERVATION_BACKEND=false、YUSHIN_PRODUCTION_ORDER_RESERVATION_LEGACY_BLOCKED=false；正式功能仍未切換。正式 PO 的 ENABLE_PRODUCTION_FORMAL_PURCHASE=true 屬**獨立**已啟用入口，不可在更新其他函式時誤覆蓋；Quick Purchase 仍為 false。
- #408 雖已合併，但沒有正式 Firestore Rules 發布紀錄；只刪網站 source 並不能阻擋舊分頁或已快取 JavaScript。
- 舊 Preview preview-20135 已遭刪除、恢復失敗；demo-yushin Emulator 的成功不等於真實 Preview 或正式角色驗收。
- GitHub Pages 隨 main 合併可能自動發布靜態程式；它**不等於** Firebase Functions、Rules 或旗標部署。正式使用網址、版本化 index/app.js/config、快取及任何獨立 Firebase Hosting 須實際核對。

## 2. 發布前 Gate（未全部符合前停止）

- [ ] 唯讀回讀正式 Firebase 專案、(default) Firestore edition/region、八個既有函式及相關部署 hash、現有環境旗標；確認正式網站實際使用的專案與主機名稱。
- [ ] 最新 main、#404/#406/#407/#408 的原始碼、權威 Callable、Rules、產物及相應 CI 仍一致，無新衝突或待審重大權限／庫存問題。
- [ ] 取得正式部署／Rules 發布／前端旗標切換各自可審閱範圍的明確授權；先定義寫入凍結的實際技術措施，而非只聲明凍結。
- [ ] 真實 Preview 若仍不可用，只能將 Emulator 證據與**另外授權**的受控正式試單分開列示；不得把 demo-yushin 當成正式網域。
- [ ] 建立真實、可稽核的維護時段，暫停所有可能寫入 orders、inventory、warehouseStocks、inventoryReservations、procurementDemands、movements 的舊網站分頁、Functions、排程與重送入口；確認已在途操作及原 syncAttemptId/receipt。
- [ ] 確認 #334 資料清理如需同場進行，使用已合併 #409 的新版政策：**保留 quotes、products、priceHistory、productCosts 及必要主檔**。真正正式乾跑、子集合與估價單引用盤點尚未完成，不能直接執行 --execute。

## 3. 受控切換順序（每一步保留回讀證據）

1. **開始維護與確實停止寫入**：記錄操作時間、操作者、主網域、受影響角色、未完成交易憑證。雙旗標仍關閉，不讓使用者於版本交錯期間建立新訂單。
2. **先更新後端 Callable**：只在核准範圍部署最新 main 的 commitOrderReservationPreview，初始保持 ENABLE_ORDER_RESERVATION_BACKEND 與 ENABLE_PRODUCTION_ORDER_RESERVATION_BACKEND 關閉。回讀 ACTIVE、region、部署 hash、專案與所有既有功能旗標；不得順手更新未授權函式。
3. **發布並驗證 #408 Firestore Rules 防火牆**：先經最新 Rules／角色 Emulator 證據核對，在凍結期間正式發布及回讀 Rules 版本。舊快取瀏覽器逐品項預留、假造 completed/保留量必須拒絕；合法已完成訂單的收貨、出貨、取消／恢復、退貨不可誤阻。
4. **準備新前端版本**：以獨立 PR／CI 更新網站的兩個正式前端旗標及 index.html 對 app.js/config 的版本號；核對 GitHub Pages 實際 URL、快取與手機／桌面一致。YUSHIN_PRODUCTION_ORDER_RESERVATION_LEGACY_BLOCKED 正式設為 true 後不得再改回 false 以恢復舊 SDK。
5. **開啟後端雙 Gate 再開放前端入口**：只在已核准部署與防火牆生效後設 ENABLE_ORDER_RESERVATION_BACKEND=true、ENABLE_PRODUCTION_ORDER_RESERVATION_BACKEND=true；核對正式主機、無 Emulator 混接，再釋出前端 YUSHIN_PRODUCTION_ORDER_RESERVATION_BACKEND=true 與永久封鎖旗標 true。兩側不能同時原子發布，因此整段保持維護凍結直到都回讀成功。
6. **真實角色驗收後才解除維護**：以專用試單核對五角色、公司／分倉、正常初始缺貨與最多已驗證品項、替代單倉與多倉 fail-closed、同一 syncAttemptId/receipt 重試、回覆遺失、身份更換、超額及失敗無部分寫入。另查正式 PO #199、手動採購 #268 的獨立狀態，不能因新訂單成功便結案其他入口。

## 4. 故障中止與恢復規則

- 任一部署 hash、Rules、實際前端資產、Auth/角色、存量／分倉核對不一致：**維持維護凍結，不放行新交易**。
- Callable 故障、回覆不明或旗標停用：新訂單初始化 fail-closed；以原 syncAttemptId/receipt 只讀查核結果，不清 checkpoint、不製造新 ID、不把舊版逐筆 SDK 重新開放。
- 不以回退 #408 Rules 或把 LEGACY_BLOCKED 由 true 改 false 當作快速復原；若需要變更正式入口或資料模型，須單獨評估與授權。
- #334 清理是獨立高風險作業；跨集合 recursiveDelete 不具全域原子性，未有正式 dry-run、權限、凍結與保留估價單證據前不得執行。

## 5. 本次可驗證交付與剩餘阻礙

- 本文件只盤點來源、發布先後、停止條件；沒有執行 Firebase CLI、正式 Rules、函式、旗標或任何 Firestore 交易。
- 仍缺：正式 ADC／管理 CLI 的實際回讀、真實資料盤點與 dry-run、技術性寫入凍結方案、實際正式發布範圍核准、正式多角色與完整生命週期驗收。
- 正式切換後應在 Issue #311 記錄來源 commit、Function/Rules hash、主網站資產版本、每個 Gate 的前後值、測試/CI/角色結果及異常處置；符合完整標準才關閉。

參考：#311、#199、#268、#334、PR #404/#406/#407/#408/#409；舊的 docs/order-reservation-311-production-cutover-20261030.md 為當時歷史候選，勿當成目前發布狀態。
