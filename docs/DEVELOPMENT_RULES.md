# DEVELOPMENT_RULES — 修改規範與驗收閘門

**唯一原始碼**：`app.js` 是由 `src/` 生成的相容部署包，**禁止直接手工修改**。修改各 feature 源碼後執行 `node tools/build-app.cjs`，生成檔與來源需一起提交；`--check` 是 CI 必跑項。

## 實作規範

1. 先定位權威核心與既有 service；不要在頁面另寫交付、預留、在途、退貨、有效交付的第二套計算。
2. 畫面僅處理使用者輸入、讀取、驗證回饋；狀態推導在 core，真正變更由受保護 transaction / 服務協調。
3. 既有 `modules/` 是現行功能模組，**不得只為資料夾好看而複製一份到 src**。遷移需一次調整呼叫、文件、測試，並刪除舊實作。
4. 每個操作都要定義 actor、intent、attemptId、受影響的文件、數量上下限、錯誤回饋、重試／重複行為及權限來源。
5. 不在 Firestore Transaction callback 裡執行非冪等的外部副作用（寄信、瀏覽器通知）；拆為可追蹤的交易後作業。
6. 改 Rules 必須與讀寫程式、Emulator、五角色存取及需要的 Index 同步審查；不能用前端檢視身份取代 Rules。
7. 不為了刪除歷史相容而清空正式資料；若移除欄位需獨立規格、Preview migration 與可重建備份。
8. 正式 Firebase 部署與資料重置和 GitHub 合併是不同操作；未取得部署／刪除授權時只能提交程式。

## 每批提交驗收

- `node tools/build-app.cjs --check`
- `node --test $(find tests -maxdepth 1 -name '*.test.js' ! -name 'firestore-rules.test.js' | sort)`
- GitHub CI Desktop/Phone Chrome smoke + Firestore Emulator；失敗不能合併。
- 涉及交易需驗證正常、部分、取消、恢復、退貨、直送、服務型別及重複提交（各依變更影響範圍）；涉及權限需按角色檢驗。
- PR 說明要包含：變更入口、權威函式、Firestore 寫入與索引/Rules 差異、性能、測試數量、未驗收範圍。
- 沒有實際執行的驗收不能記錄成通過；需要人工或正式資料驗收時明列缺口。

## 待改善技術債

第一批完成來源責任切分及自動建置一致性；後續才讓 UI 與 transaction services 真正隔離、移除跨檔全域變數及保持 PR #91 的取消／恢復修正整合與測試。單純拆檔與生成 bundle 不是商業邏輯全面完成的證明。

- 核銷／核銷日期不能在畫面另開直接 update：必須呼叫 `setOrderBillingStatus` 或 `changeOrderBillingDate`，並保持修改歷史和角色保護。
- 收貨 Service 不得使用 window、document、Storage、UI 快取或呈現函式；Feature 不得自行重開收貨 transaction。提交後快取通知由呼叫端傳入同步 `onStockCommitted`，只在成功提交及身分檢查後執行，不得放在 transaction callback；通知失敗不能當成資料未提交。
- supply-order Service 同樣不擁有採購編輯狀態、取消確認、清單或快取；Feature 用 `onStockCommitted`／`onDemandChanged` 接收同步提交後通知。整張停止中途通知失敗不得將前面已完成的供應視為回滾，也不得提前標示整張完成；必須保留原 checkpoint 續跑。
- 正式建單文件提交一律呼叫 `commitOrderCreation`，包含手動、估價單帶入與 Forecast 多品項轉單。Feature 擁有草稿／待確認 ID／快取，Service 不依賴瀏覽器暫存或畫面。Forecast 訂單及來源 backlink 同交易提交；庫存初始化和延後來源同步仍各自保留 checkpoint，不能宣稱整條流程原子化。
