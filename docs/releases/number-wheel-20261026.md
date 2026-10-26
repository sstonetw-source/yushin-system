# 全系統數字欄位停用滑輪改值

基準：main 865270f。此修正獨立於尚待合併的 PR #296、#297。

## 行為

- 共用 document wheel guard 適用所有 input[type=number]，包括估價單、訂單、採購、庫存、成本、折扣、有效天數，以及動態新增品項與彈窗欄位。
- 只攔截正取得焦點、可編輯數字欄位的 wheel 預設步進；不 blur、不改 value、不派送 input／change 事件。
- 將原滑動量交給最近可捲動容器，保留橫向、縱向、巢狀捲動與 overscroll containment。原生 dialog、既有 modal overlay 到達邊界後不捲動背景。
- 不修改欄位 type、step、min、max、required 或既有數量驗證。保留打字、貼上、Tab 與原生鍵盤操作。
- Ctrl 加滾輪的縮放手勢交由瀏覽器處理；非數字及未聚焦欄位沿用原生行為。已由其他 handler 取消的事件不重複處理。

## 驗證

- 一般回歸測試：1,877 項通過。
- 本機 Chrome 1280／390px：實際 mouse.wheel，值與焦點維持、無 input／change／blur，頁面、巢狀與彈窗捲動，邊界不捲背景，橫向捲動及動態欄位。
- 本機 Chrome：實際系統剪貼簿貼上、Tab 焦點切換、小數、rangeUnderflow／rangeOverflow／stepMismatch 驗證。
- 本機既有新增訂單瀏覽器檢查通過。
- 新增測試加入 GitHub CI。產生程式一致性、語法及 diff 檢查通過。
- 以上為本機自動瀏覽器檢查，沒有連接正式資料。未進行正式環境操作或 Firebase Emulator 測試；此變更沒有資料庫操作。

## 影響與發布

純前端共用互動行為。不改角色、交易、價格、庫存、Rules、Index、Listener 或 PDF／列印版型。不需 Firebase 設定更新。建立 PR，尚未合併 main 或部署。
