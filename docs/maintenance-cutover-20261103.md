# 交易切換與重置後維護

本次使用者明確要求執行交易切換與資料重置，並選擇「先歸零並維持維護，待實際盤點匯入與驗收後開放」。

- 正式資料操作固定yu-shing-company／(default)；重置沿main 182eef1的既有清理政策與腳本。
- 完整私有Cloud Storage快照成功並驗證後才清除交易，主檔、成本、估價單、Auth及角色保留。
- 19個Callable均停用交易；正式維護Rules全面拒絕Client讀寫。管理端的重置與核對是唯一受控寫入。
- 七個settings/*Cutover.backendOnly單向鎖在重置完成後建立，禁止未來恢復一般Rules時舊瀏覽器重啟已退役交易。
- 前端正式HTTPS Pages來源切往既有後端路由並保留LEGACY_BLOCKED，入口先顯示獨立維護頁。
  維護頁不載入Auth／Firestore／app.js，不查業務資料；localhost／Emulator／其他網址不啟用正式維護旗標。
- functions/.env.yu-shing-company中的交易旗標全false，避免後續普通部署意外重開交易。

目前正式Rules來源是firestore.maintenance.rules，請使用firebase.maintenance.json核對或發布維護規則。
一般firebase.json仍保留開發／Emulator使用的正常規則設定；**維護期間不得用一般設定覆蓋正式維護Rules**。

解除維護必須先取得實際期初盤點，完成期初匯入、公司／分倉及批次對帳、五角色與新交易完整驗收。
未支援的直送、自行訂貨、保管與待檢轉庫存邊界不得因本次重置自動開放。
之後以另一個具體發布變更核對後端開關、正常Rules、七個單向鎖及前端維護旗標，按原授權範圍執行；
不能只把維護頁拿掉或回退舊writer。故障時維持維護，依私有備份與執行紀錄回復。
