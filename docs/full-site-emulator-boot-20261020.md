# 完整首頁 Emulator 啟動驗收

## 範圍與安全邊界

- 在 1280px、390px Chrome 載入原 index.html、未修改的 app.js、所有原本的本機模組與 CSS；不替換導航、權限、快取、登入恢復或訂單清單。
- 測試伺服器僅將外部 SDK / PDF vendor URL 轉向本機真正的 npm 套件。Firebase 使用現有 real compat bundle，非正式 CDN 10.8.0 的逐位元複本。PDF 匯出不在本批驗收範圍。
- 本機模式需 localhost / 127.0.0.1 且 YUSHIN_LOCAL_EMULATOR 嚴格等於 true；只可 demo-yushin，拒絕沿用正式 / Preview app。Auth 9099、Firestore 8080、Functions 5001 在任何讀寫前設定。
- 不新增正式功能旗標、不修改正式 Functions 部署入口、Rules、索引、provider 或角色資料。測試攔截並阻擋非本機網路。

## 驗收內容

1. 真實 Auth 帳密經原登入表單；原 bootstrap 載入角色，重新整理恢復登入。
2. 原導航與訂單清單取消來源訂單。實際 callable 已提交後丟棄 HTTP 回覆；重新整理、原操作入口使用相同 operationId 確認，不重複取消。
3. 倉管原倉庫頁讀取兩倉釋放來源，讀取不配貨；原按鈕配五筆後回覆中斷。
4. 原登出與採購登入、原頁面接手同一批工作，完成七筆預留，僅一筆接手紀錄。實體庫存與 lot 不變。
5. sales / warehouse / purchaser / engineer / admin 共五種真實 fixture 身分登入及恢復；檢查原頁面權限。非本機請求、未捕捉頁面錯誤皆須為零。

保留原先兩個元件型真實 SDK 測試；新增兩個整站型測試。整站通過不代表正式環境或所有流程均完成驗收，仍須通過完整 CI 才可合併。

## 首輪整站實測發現與修正

- 桌機已實際完成取消、重新整理確認及物流接手，但切換角色後發現舊退貨查詢的拒絕未被處理。原導航重複呼叫退貨 queue，繞過 workspace 的 allSettled；已移除重複讀取，仍由既有 workspace 載入並保留失敗重試。
- 退貨 queue 的成功與失敗都核對原 UID、角色及 session generation；舊工作不能回寫新身分畫面。當前身分的真實錯誤仍顯示並回傳給 workspace，不放寬 Rules 或隱藏有效錯誤。
- 手機測試修正為先展開原功能選單再點登出，不使用強制點擊或直接 SDK 登出。
- 新增五項 Node 回歸，後續完整 CI 仍須重新全數通過。

## 跨角色配貨後重新恢復訂單（後續回歸案例）

原整站 Chrome 1280／390 px 測試繼續使用同一筆來源訂單與七筆目標訂單，不新增測試殼或後端 writer。驗收在倉管與採購交接完成、七筆目標預留已落帳之後，重新由原登入表單登入來源業務，透過原訂單清單「恢復訂單」操作。

預期業務原訂單的 12 件剩餘需求，只能重新預留未被分配的 5 件，並產生 7 件缺口；七筆目標訂單先前的預留不可被搶回，公司與兩倉合計仍為 12 件預留。出貨與實體批次無變動、只有一筆恢復歷史。

以真實 Callable 已提交但瀏覽器 HTTP 回覆中斷模擬結果未知，保留原 sessionStorage 作業識別並刷新原網站，按「確認前次取消／恢復結果」以相同 payload 核對，不得二次預留；再重送更早的取消 operationId，確定不得覆蓋已恢復狀態。

此處只擴充本機 demo-yushin 端對端的「取消 → 跨角色配貨 → 恢復」段落，**不代表原頁面建單 → 採購 → 收貨 → 打單 → 出貨 → 送達 → 退貨全流程完成**。沒有改正式 Firebase、Firestore Rules、資料或部署設定。以新 PR 完整 CI 為通過判定。

## 恢復訂單後的缺貨採購需求（下一段端對端驗收）

延續原 Chrome 1280／390 px 真實登入、取消及跨角色配貨後恢復，追加查核原 12 件的來源訂單只剩 5 件可預留時，原 Procurement Demand Core／Service 在同一個恢復交易中對該品項產生**唯一一筆** 7 件採購需求。必須是 requestedQty=7、remainingToOrderQty=7、orderedQty=receivedQty=0，且公司／兩倉實貨、原批次及採購在途沒有被虛增。

重新使用原登入畫面以採購角色進入正式版結構的「採購需求」工作區，確認來源訂單實際顯示於原列表；唯讀瀏覽不應寫入來源或庫存。此項查核是真正 Browser Auth／原整站／Firestore Emulator 的完整需求顯示段落，但**不是**採購單建立、正式進貨及整張訂單最終履約的驗收。測試資料、Auth、Functions 與 Firestore 仍嚴格隔離於本機 demo-yushin。

此批只增加測試與文件；不新增需求 writer、查詢、集合或正式 Firebase 部署。通過標準以對應 PR 最新完整 CI 為準。

## 由原待採購列表開啟正式採購草稿（續段）

整站 Chrome 1280／390 px 的取消、跨角色配貨、恢復、缺貨 7 件驗收，延續到原採購人員工作區。真實登入採購後點擊該需求列的「產生採購單」，而不是直接測試 Service／繞過按鈕；原 PO 編輯器應帶入來源 orderId、itemId、原商品識別、數量 7 與採購需求連結，並顯示尚未建立的正式採購草稿。

本批只在試驗品項加上完整貨號、品名、品牌，避免使用缺少商品身分的純數量 fixture 偽稱真正可用的採購 UI。按鈕操作必須不自行提交採購單、不產生 supplyOrders、不增加 incoming 或實貨；需求與先前已分配的七筆預留均不變。資料只在 demo-yushin Auth／Firestore／Functions Emulator，沒有正式環境存取。

此處驗收的是原介面將權威缺口轉為**可編輯採購草稿**，不是採購單正式儲存、供應承諾／在途註冊、部分實收到貨或客戶交付；仍必須用後續案例逐段接續，不能把現有單獨 Service 測試視為整站連續流程。

## 正式採購 Cloud Functions 安全遷移｜第一階段：唯讀准入查核

針對 Issue #199 原用戶端 PO 多文件原子交易超過 Firestore Rules 1000 運算式上限，先建立 **Emulator-only、唯讀、不產生 PO** 的後端准入入口 `previewV2FormalPurchase`。本階段與既有核心 `modules/procurement-demand-core.js` 共用需求數量投影及 `applyOrder`，不建立第二套數量公式／交易寫入；實際採購仍使用原 `commitFormalPurchaseOrder` 且**正式提交仍未驗收通過**。

後端透過 Firebase Auth UID 查閱交易內最新 users 身分及角色（只允許 active admin/purchaser）；在同一個資料快照查核來源訂單、實體產品主檔、實體倉庫、權威需求與版本；不可採購取消、停用、品項不符、需求過期或超額數量。API 輸入僅允許 `poNo`、`orderId`、`itemId`、`qty`，不能傳入任意欄位、管理員角色或庫存結果。

本機原站 Chrome 1280／390 px、採購實際登入時，原 PO 草稿可在不提交交易的情況下呼叫准入入口，驗證剩餘缺口 7 件允許擬採購 4 件並阻擋超額 8 件；偽造角色、無權限業務、停用使用者、過期需求及重複 PO ID 由獨立後端單元測試查核（不可誤稱已完成真實 Auth 跨角色整站測試）。查核前後 PO、Supply、訂單預留、在途、實貨、需求資料都不變。

**關鍵安全界線：** 唯讀准入不代表安全提交；未來正式 Cloud Function Transaction 必須在真正寫入時重新取得並驗證同批所有權威資料，加入固定 PO 身分／同單重跑／競爭採購/稽核紀錄；不可只憑此前端呼叫結果直接寫入。不接到正式 Functions `index.js`，目前只由隔離 Emulator 的臨時入口匯出；無 Firebase 部署。

## 正式採購後端交易遷移｜第二階段：Emulator 隔離的單品項原子交易

背景：Issue #199，原前端 `commitFormalPurchaseOrder` 對多份資料的 Firestore Rules 驗證已於真實登入整站 Chrome 1280／390px 複現 1000 運算式限制。

新增 `functions/formal-purchase-commit-service.js` 的 `commitV2FormalPurchase`，目前**僅由 `demo-yushin` 隔離 Functions Emulator adapter 匯出**；正式 Functions `index.js`、現行前端提交按鈕、正式環境與 Firestore Rules 均不改。本階段限「**已有單筆 WAREHOUSE 實體商品需求的單一來源訂單／單一品項**」，不涵蓋多品項、跨單合併 PO、原廠直送、SERVICE 或手動備庫，也未完成原 UI 按鈕接線。

此入口與第一階段共用 `validateV2FormalPurchaseTx`（正式提交交易**內**重新讀取真實 Auth UID 的 active role、來源訂單、產品、倉庫、最新需求）。需求計算**直接呼叫同一 `functions/shared/procurement-demand-core.js`**；同一 Firestore Admin SDK Transaction 建立 PO、供應紀錄、更新既有 Demand 與來源訂單。PO 號是確定性冪等 key，記錄完整意圖 SHA-256／創建者，重跑同意圖只回應 already-applied；使用相同號碼改數量或改操作員拒絕，不產生重複承諾。任何驗證失敗均不寫入。此交易階段不登記 incoming、更不建立實貨；後續必須沿用唯一現有 Incoming Service 確認第二段進度識別。

原站 Chrome 真登入採購角色可從既有採購草稿直接呼叫**隔離的後端測試入口**，驗證 7 件缺口只建立 4 件供應承諾、原需求 4 已採購／3 未採購、客戶訂單累積採購量 4；原公司與分倉庫存、實貨批次、訂單預留保持不變。同一 Service 再重跑同單、換演員、使用舊需求或超額申請均須拒絕或安全回應。這些驗收**不代表原採購視窗已正式接線，也不是完整從按鈕到收貨的 Preview 驗收**。既有前端入口仍有 Issue #199 的交易運算限制，PR #198 保留失敗案例，不可視為已解決。

重要風險與待續：後端投影與原前端相同欄位／事件格式的跨模組契約、產品與供應商附加欄位、工作卡快取／狀態、不同來源型態、採購文件下載仍需對照統一；目前只能把此階段視為可驗證後端交易原型，未進行正式 Functions 部署，不能將其誤當作正式環境採購 Service 已切換。


## 正式採購多品項後端擴充（2026-10-20）

延續 #201 的相同後端 Service，擴充 1–5 列實體商品與跨訂單採購；新增 Node 測試及既有 Auth Callable Emulator 測試中的五列雙倉、同號並行、最後一列超額／業務拒絕／使用者停用、兩張 PO 競爭整批需求。沿用真正的初始化 Service 建立來源預留與採購需求，再呼叫同一個 Callable，驗證未產生在途或實貨。

**已實作、待本 PR CI 驗收：** 多列交易及讀取快取。**尚未完成：** 原採購提交按鈕接線、供應商／公司／文件欄位契約、在途與部分收貨的整站連續驗收；原 UI 的 Issue #199 仍未解決，#198 不可直接合併。正式 index.js、Rules 與部署均未修改。

## 原採購提交／在途的後端接線（續段）

本批將上節「按鈕未接線」延伸至本機隔離 gate：Chrome 1280／390 px 在同一恢復後 7 件缺口的原 PO 草稿，實際填入 4 件、成本 20，點原建立 PDF 按鈕。只替代實體 PDF 輸出，核對輸出前權威 PO 已落帳；原 Service 呼叫真實 Auth Callable 進入同一後端 writer，回讀權威資料後續走原在途 Service 和真實 Rules。驗收須確認採購 4／剩餘待採購 3、在途 4、實貨／預留／批次與其他訂單不變，並核對公司、供應商快照、金額及來源連結。

此為 Issue #199 原失敗操作的針對性修正驗收，狀態以本批 PR 最新 CI 為準。不是正式部署；部分收貨、完整履約、斷線後刷新原 PO 恢復、全類型採購與 Preview 切換仍需後續驗收。正式 index.js 與 Rules 不變，#198 仍不得未經整合直接合併。


## 2026-10-20 原採購單斷線恢復（隔離試點）

已實作、待本批完整 CI 驗收：原採購按鈕在呼叫同一 `commitFormalPurchaseOrder` 前，以 sessionStorage 固定原 UID／角色／單號及完整提交內容；未確認作業只允許原意圖重送，不建立新單號意圖。原採購頁提供「確認前次採購結果」，刷新後仍可經同一後端 writer 回讀 PO／來源／Supply，沿原 `registerPurchaseIncoming` 完成在途後才解除 checkpoint。讀取與導覽不得自行提交。僅 demo-yushin 本機試點啟用；正式／Preview 不啟用，未部署 Firebase。

後端交易及需求公式沒有新增第二套；畫面快取同步抽為共用 feature helper。存取失敗在提交前停止；回覆未知、回讀失敗、在途失敗、角色改變或暫存損壞均保留 checkpoint，不默默刪除或降級 client writer。回覆已確認後的畫面更新失敗須與交易未確認分開顯示。checkpoint 僅保存於同分頁 sessionStorage，不承諾跨裝置或關閉分頁恢復；價格資料不送入新 collection。無新 Rules／Index／Listener／正式資料遷移。

驗收：新增執行式 Node 測試涵蓋原意圖凍結、重新載入、Callable／在途失敗、重複點擊、帳號／角色切換、損壞與儲存停用；原整站 Chrome 1280／390 px 在真實後端已完成後中斷 HTTP 回覆，刷新原網站並由按鈕重送完全相同 payload，核對唯一 PO／Supply、四件在途、實貨與原批次不變，再由原歷史載入／下載按鈕確認不重建採購。完整 CI 通過前不得合併。部分收貨、全類型採購、跨分頁關閉及 Preview／正式切換仍未完成。
