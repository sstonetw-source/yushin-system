# 原站訂單調撥桌機／手機Emulator案例

相依 #368，關聯 #291。於既有emulator-v2-lifecycle-browser.cjs加入1280px與390px兩個Chrome案例，沿既有runner browser／all群組執行；不新增另一套瀏覽器架構，不改正式程式。

載入完整原index／app／modules及真Firebase compat SDK，原登入、庫存頁按鈕、調撥出貨／收貨與恢復按鈕，真Auth／Callable／Firestore。桌機在伺服器寄出成功後攔截丟棄回覆，重載後按原寄出恢復；手機同樣丟棄收貨回覆，重載後先關旗標確認無新call且保留暫存，再恢復旗標以原receipt operation核對。檢查同payload、公司與分倉實貨／reserved、來源預留移倉、無客戶送達及無pageerror。

來源單據由Admin建立，展示快取以真server文件限定到本案例，沒有替換writer、Callable或原render handler。因此這是原站操作接線測試，不是原建單流程／完整營運查詢涵蓋驗收。等待失敗提示才重載，避免在請求尚未提交時提前中止造成錯誤的lost-reply證據。

本機一般Node2094/2094、build一致性／語法／diff通過。本機沒有Emulator／Chrome runtime，新兩個Chrome／真Auth案例尚未執行，遠端CI待結果；不得寫成已通過。#367完整CI40844826178、#368完整CI40845671088均success，包含前批真Callable測試；不替代本批新UI案例。Preview／正式角色／最後集中人工驗收尚未執行。

本批只有測試與文件，沒有正式程式變更、部署、旗標、Rules或正式資料異動。保持Draft。下一步依本批CI修正，再繼續多倉及業務交接後端，最後集中人工驗收。
