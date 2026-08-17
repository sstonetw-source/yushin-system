# 又鑫管理系統 — 部署與設定說明

這個資料夾裡的檔案就是完整的網站，全部都是純前端（HTML/JS），資料庫用
Firebase Firestore，登入用 Firebase Authentication。適合直接放上 GitHub Pages。

## 檔案清單
- `index.html`：頁面結構（估價單系統／儀器管理系統／管理員後台）
- `app.js`：所有邏輯（估價單計算、Firebase 讀寫、登入驗證）
- `sales.csv`：業務名單的初始匯入來源（第一次沒有雲端資料時會用這份）
- `stamp_yushin.png` / `stamp_morningstar.png` / `stamp_MULTI-LIFE.png`：三間公司的估價章圖檔
- `firestore.rules`：Firestore 安全規則，**務必**照下面步驟貼到 Firebase Console

---

## 第一步：設定 Firebase（一定要做，否則資料庫是不設防的）

網站用的是你原本雛形裡已經有的 Firebase 專案（`yu-shing-company`）。因為程式碼會
公開放在 GitHub 上，任何人都看得到 `firebaseConfig` 裡的 API 金鑰——這是 Firebase
的正常設計（金鑰本身不是密碼），**真正的防線是 Firestore 安全規則**，所以這一步不能省略。

1. 前往 [Firebase Console](https://console.firebase.google.com/) → 選擇 `yu-shing-company` 專案
2. 左側選單「Firestore Database」→「規則」分頁
3. 把 `firestore.rules` 的內容整份貼進去，按「發布」
4. 左側選單「Authentication」→「Sign-in method」→ 啟用「電子郵件/密碼」
5. 「Authentication」→「Users」→「新增使用者」，幫需要用「儀器管理系統」「管理員後台」
   的同仁建立帳號（Email + 密碼）。**這裡沒有開放註冊功能**，帳號都是你手動建立，
   比較安全，也比較符合內部工具的使用情境。

> 估價單系統（開單、查單）維持原本雛形的設計，不需要登入。
> 只有「儀器管理系統」和「管理員後台」（含刪除、修改業務/價格表等功能）才會跳出登入視窗。

---

## 第二步：放上 GitHub Pages

1. 在 GitHub 建立一個新的 repository（例如 `yushin-system`）
2. 把這個資料夾裡「除了 README.md 和 firestore.rules 以外」的檔案全部上傳進去
   （`index.html`、`app.js`、`sales.csv`、三張 `stamp_*.png`）
   - `firestore.rules` 不需要上傳到 GitHub，它是給 Firebase Console 用的設定檔，
     放不放在 repo 裡都可以，但不影響網站運作
3. 進 repo 的 Settings → Pages
4. Source 選擇 `Deploy from a branch`，Branch 選 `main`（或你的預設分支）／`/ (root)`
5. 存檔後等 1-2 分鐘，GitHub 會給你一個網址，格式類似：
   `https://你的帳號.github.io/yushin-system/`
6. 之後要更新網站，只要把新版檔案再上傳（或用 `git push`）覆蓋舊檔即可，
   GitHub Pages 會自動重新部署

> 注意：GitHub Pages 免費版必須是「公開 repository」，程式碼任何人都看得到——
> 這也是為什麼第一步的 Firestore 規則格外重要。如果不希望原始碼被看到，
> 需要改用付費的私有 repo + 其他部署方式（例如 Firebase Hosting）。

---

## 三大模組使用說明

### 📄 估價單系統（沿用原本雛形，未改變操作方式）
含稅/未稅單價互算、自動產生單號、列印/存 PDF 時自動同步存回 Firestore。
新增功能：品項的「中文品名」欄位如果在管理員後台的價格表裡有建過，
輸入時會出現自動建議，選了之後型號/廠牌/單價會自動帶入。

### 🔬 儀器管理系統（新增，需登入）
用來記錄**客戶端**儀器的維修保養／校正紀錄：
- 每台儀器記錄客戶、型號、序號、放置地點、安裝日期、保養/校正週期（月）
- 系統會依「最近一次保養/校正日期 + 週期」自動算出下次到期日，並用顏色標示：
  - 🟢 正常　🟡 30 天內到期　🔴 已逾期
- 點一台儀器可以展開，新增一筆一筆的保養/校正/維修紀錄（歷史紀錄會保留）
- 新增「保養」或「校正」紀錄時，會自動把該儀器的「最近保養/校正日期」往後推，
  到期日就會自動重新計算

### ⚙️ 管理員雲端後台（新增，需登入）
- **業務名單**：直接在網頁上增刪改業務，按「儲存到雲端」後，估價單頁面的
  業務下拉選單會改用雲端版本（不用再手動改 CSV 檔重新部署網站）
- **價格表**：維護常用品項的中文/英文品名、型號、廠牌、單價，
  存檔後會在估價單品項的「中文品名」欄位出現自動建議
- **估價單記錄**：搜尋/瀏覽所有雲端上的估價單、一鍵載入回估價單頁面、刪除、
  匯出目前清單為 CSV

---

## 已知限制 / 之後可以再做的事
- 目前「登入」只有電子郵件/密碼一種方式，沒有忘記密碼的自助流程
  （需要的話可以到 Firebase Console 的 Authentication 頁面手動重設）
- 估價單系統本身沒有鎖登入，如果之後想連業務開單也要登入才能用，
  把 `firestore.rules` 裡 `quotes` 那段的規則改成 `if request.auth != null` 即可，
  同時把 `app.js` 的 `switchMainTab` 裡 `needsAuth` 判斷式也把 `quote-system` 加進去
- 儀器的保養/校正紀錄目前存成同一份文件裡的陣列，單一客戶儀器紀錄如果多到
  幾百筆才會需要改成子集合（subcollection），目前規模下不需要擔心
