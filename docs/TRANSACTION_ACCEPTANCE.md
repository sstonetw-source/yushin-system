# 核心交易驗收：風險、證據與結束標準

## 2026-10-24｜目前版本整合

- 整合服務分支 `3018c48`（已含 #255、#257、#258、#262）與 main `d135d77`（#259、#260、#263）。保留逐品項服務顯示、已核實純服務分類，以及最新採購來源一致性、超過五品項與 Preview 未啟用後端時禁止舊交易退回的保護。
- 衝突處理保留服務財務 Rules 反例、原服務 Callable、demo Emulator 服務旗標與最新 Preview 拒絕回退測試；app 與 Functions runtime 由共用來源重新產生。
- 本節取代下方歷史版本表的目前版本判斷；#255／#257 已整合，不重做已完成項目。完整 CI 以本整合 PR 最終 head 為準，測試結果另記於 PR。
- 本次僅整合現有功能，沒有新增角色、交易 writer、Collection、Index 或 Listener；服務仍受 demo Emulator gate 限制。混合單、材料耗用、其他分類 writer 與 Preview 端對端仍另有待辦。未合併 main、未部署 Firebase、未操作正式資料。

## 2026-10-24｜服務整合分支同步最新 main（待本整合 head CI）

- 從 #234 服務分支 `0d7cd726` 建立獨立整合分支，併入 main `38c53daf`（#250 Preview 採購 Callable、#251 Hosting 排除、#256 採購在途 Rules 成本修正）。#256 自身的完整 CI `40062418497` 首次及重跑均成功，不能用它冒充本整合 head 的 CI。
- 只解決四個交集衝突：保留服務與採購各自的 Rules 測試；真 Auth Emulator fixture 同時輸出受控服務與 Preview 採購 Callable；啟動器僅在 `demo-yushin` Emulator 同時啟用必要的兩組旗標；驗收文件保留兩批獨立歷程。`firestore.rules`、Functions 入口與 `app.js` 由 Git 正常合併，未放寬安全檢查、重寫交易 Service 或新增集合。
- 本機來源／生成檔一致性及語法檢查通過，相關 Node 421/421、完整 Node 1,816/1,816 通過，零失敗／略過；此主機 Java 17 且沒有安裝 Functions Emulator 依賴，真 Rules／Auth／Chrome 必須以新 PR head CI 為準。
- #255 的逐品項唯讀顯示尚未整合；本分支需先在 CI 完整通過，才能評估與 #255 的相依順序。#234 持續 Draft，不合併 main、未部署 Firebase／Preview、未操作正式資料。#199 與混合服務、其他分類 writer、材料耗用及 Preview 端對端缺口仍保留。

## 2026-10-24｜在途同步 Rules 評估成本（獨立修正，待完整 CI）

- 基準 main `49b8742b`；在途 Service／Stock Permissions 與服務整合分支相同。#255 第一輪 CI `40056066066` 在第二張 PO 成功後的 Client 在途 checkpoint 失敗，log 明示 supplyOrders update 1,000 expressions；同 head 重跑成功不代表已修復。
- 本批只重排 supplyOrders update 的角色分流：從已啟用 users profile 取得一次角色，先選擇購買／收貨／本人直送的合法分支，再保留原識別、數量、來源、取消處理、鏡像及成本限制。管理員仍沿既有允許分支；不增加角色、欄位或資料存取能力，不變更 transaction writer。
- 新增真 Client Rules 的原 registerPurchaseIncoming → Stock Permissions 代表：已有部分收貨的第二張 PO，兩個並行原意圖只增在途一次；鏡像遭拒全部回滾，修正後原 PO 安全重試；偽造 UI 採購角色及停權者不得提交。沿完整 Rules suite 驗證其他身分、更新繞過、來源／數量篡改、直送、取消及重放，無新增低風險數量排列。
- 本機來源一致性、語法、差異檢查與相關 Node 44/44 通過；完整 Node 1,704/1,704 通過；CI 以本批實際結果補記。此主機只有 Java 17，未本機啟動要求 Java 21 的 Emulator；Rules 編譯與上述真 Client 測試尚待 GitHub CI，不能列為已通過。
- 這是待 Emulator／完整 CI 驗證的 Rules 修正版；不能僅憑角色計算減少就宣稱已根除間歇超限。#199 正式 Client 採購入口／Preview 邊界、#234／#255 的有限缺口仍保留。未部署 Firebase、未改正式資料；不以本批關閉整輪核心驗收。

## 2026-10-24 版本與驗收現況（目前判定入口）

以下為目前版本對照，後文保留原代表流程與結案標準。測試通過、合併整合分支、合併 main、部署、正式實測分別記錄；不得互相代替。

| 範圍 | 核對版本／證據 | 判定與下一步 |
| --- | --- | --- |
| GitHub main | `38c53dafe9aed45fe0479b102eed317039fcea54`（#256，已含 #250／#251） | 最新主線；不變更 main 或部署 |
| 服務整合 #234 | 原 head `0d7cd7268ba0cca70635ef0b3b4a57cb2cc7d8d1`；同步 PR #257 待 CI | Draft；#252／#253／#254 已整合，#257 尚未合併，未正式啟用 |
| #254 子 PR | head `cab6e68a`；CI `40052066596` 成功 | 只證明該子 PR head，不冒充整合分支完整 CI |
| 本次逐品項顯示 | 分支 `fix/service-item-progress-acceptance-20261024`，父版 `0d7cd726` | 沿既有整單查核，結果置於對應品項下方；只讀提示，不用於工作分類、篩選金額、核銷或庫存寫入 |
| GitHub 合併保護 | main API `protected:false`；repository rulesets 回傳空清單 | 本批只核對，未修改倉庫管理設定；建議後續要求 PR 與完整 CI 才可合併 |
| 版本整合 | #257 head `aa7b8802` 已含 main #250／#251／#256 | 四個衝突已解決，需 #257 完整 CI 通過並合併至服務分支；#255 的 UI 另以最終 head 驗證 |
| 正式環境 | 另次部署紀錄回報 Rules 與 main 一致、49 索引 READY | 本次未重新查正式 Firebase，不視為本次正式操作驗收 |

### 有限剩餘工作（不再新增數量排列）

1. 本批：部分服務完成後，在原列表對應服務品項顯示後端查核結果；未查核不猜測，失效提示不授權任何交易。查核按鈕顯示執行中、防重複、失敗可重試。列表 render 不自動查詢。
2. 其他 workCategories writer：逐一列出實際寫入入口，沿共用 Core／Service 維護；不另造狀態公式。
3. 商品＋服務混合單：補真正商品交付與服務完成證據；完成前保留核銷拒絕，不用整單 billing 推定每個品項完成。
4. 試劑／零件耗用：先核對既有領用／庫存入口能否共用，再確定缺口，不建立第二份庫存帳。
5. 原八類代表流程的剩餘真入口與 Preview：沿本文件既定邊界補齊；現有 Emulator 證據沿用，受變更影響才重跑。
6. 發布版本核對後，用正式五角色驗證授權範圍內的必要入口；正式交易仍須另有明確執行範圍，不能以測試資料操作冒充正式驗收。

### 本批驗證紀錄

- 靜態：來源／生成 app 與 Functions Core 一致性、語法、diff 檢查通過。
- Node：1,811／1,811 通過，零失敗／略過。
- Chrome：1280／390px 原列表 renderer 與服務視窗，逐品項結果、列表重畫不額外讀取；使用受控後端回覆，非 Firebase 真傳輸。
- Firebase Emulator：Auth／Functions／Firestore 與原整站 Chrome 的 1280／390px 兩個代表案例均通過；涵蓋原四服務案件與角色接手、遺失回覆恢復、部分完成後逐品項顯示及原核銷限制。無略過。來源訂單仍沿原案例的明列 fixture，非 Preview 端對端。
- GitHub 完整 CI：#255 head `32070f5a` 的第二輪 CI `40056066066` 全成功，首輪曾遇在途 Rules 1,000 expressions；本次將沿已併入 #256 的最終整合 head 重新驗證，不以重跑通過視為正式問題消失。
- Preview／正式帳號：本批未執行。Rules／Index／Functions 無修改需求；未合併 main、未部署。


更新：2026-10-22。核對基準：main `9faf78b`（#232，已含 #230／#231）。本文件取代歷史交接中不斷增加數量排列的施工順序；原商業契約、安全測試及環境限制仍保留。合併後以最新 main／CI 為準，不以測試總數判定完成。

## 客觀評估

現有測試找出過 Rules 上限、多品項事件錯配、未知回覆後入口消失等真實問題，不能整批刪除。但每個小改動重跑相同完整流程、每種數量各開一批、文件只累積「待 CI」，會使完成條件不斷移動。

保留完整回歸作為合併閘門，開發時依影響選層。相似數量只在共同 Core 測邊界，原介面沿用單品項及三品項兩倉代表。不同 writer、角色、集合、失敗恢復或事件契約仍須測；未證明等價前不刪既有安全測試。

## 風險與執行層級

| 級別 | 保留證據 | 開發時機 |
| --- | --- | --- |
| P0 | 實貨／預留／在途守恆、來源一致、原子回滾、固定 ID 重送及異意圖拒絕、相同／競爭 ID 併發、最新角色／所有權／停權、Rules／Admin SDK 安全、未知結果恢復 | 修改相關 Core／Service／Rules／傳輸時跑該組；合併前完整 CI |
| P1 | 下表八類代表流程，真入口與交易串接，桌機／手機重要操作 | 入口或操作契約改變時跑受影響案例；沿用已保存證據 |
| P2 | 文案、純樣式、共同核心下其他數量排列、已有整合覆蓋的靜態斷言 | 局部檢查，不逐排列新增完整流程或 PR |

## 八類流程證據與有限缺口

「部分完成」表示已有可重用成果，並非要求全數重測。Emulator、Preview、正式分別記錄。

| 流程 | 已有證據／入口 | 必要缺口或限制 |
| --- | --- | --- |
| 正常訂單完整履約 | `emulator-v2-lifecycle-browser.cjs` 單品項／三品項原畫面採購至送達；#228 真 Client 建單來源、#229 原手動單倉建單已全 CI 合併 | v2 初始化仍為 Service fixture；單倉 UI 不代表多品項 v2 手動建單；Preview 未驗收 |
| 部分採購／收貨／分批出貨 | 同一整站案例＋`emulator-v2-return-callable.cjs`、原 Receiving Service 與供應 checkpoint | 不新增另一種 4/7 或 1+2 排列；待相同部署契約的 Preview |
| 同產品多倉預留／分配 | `emulator-order-location.cjs`、`emulator-single-item-location.cjs`、三品項兩倉原畫面 | v2 入口限 demo Emulator；單倉 UI 不代表 v2 初始化真傳輸 |
| 取消／恢復 | 真 Auth Callable、原整站單品項與 #227 收貨後三品項取消恢復 | 保留競爭、回滾、舊 ID 重送與部署限制，不擴張排列 |
| 退貨／重新下單 | #226 原多品項分倉實收；#232 同一筆實收來源從原畫面選不同商品／價格、普通 Client 建單、獨立預留與刷新不重建，CI `39737752323` 成功並合併 | Emulator 代表流程已完成；Preview 仍待驗收，不開放未完成 REPLACE 補送 |
| 原廠直送 | 既有收貨 Core／Service、真 Rules 與原入口 smoke；新增真 Auth 原整站同步→文件→確認採購→業務分批直送到貨案例（本批待 CI） | 須以本批最新 CI 判定原 Client 路徑是否可完成；來源表單輸入及實體 PDF 為明列 fixture，Preview 尚未驗收 |
| 服務型不入庫 | 既有型別檢查及多倉拒絕測試 | 拒絕 SERVICE 進實貨交易不等於正向履約完成；須一條服務完成且無 lot／實貨 movement／一般入庫的代表 |
| 估價單／Forecast 轉單 | 建單 Service 共用入口、Forecast backlink 原子性／重試；Rules 真 Client 原 Service 驗證 Forecast 轉單及估價單來源同步恢復；`phase1.test.js` 來源同步失敗保留建單 | 尚缺原畫面真 Auth 代表轉單；兩種來源契約不可互相冒充，已存在的來源恢復測試不重做 |

## 開發期間的最小必要測試

1. Core／Service：先跑相關 `node --test tests/<相關檔>.test.js`，包含受影響呼叫端，不從整站起跑。
2. 交易／權限：補對應 Emulator；真身分傳輸用 `node tools/run-v2-return-auth-emulator.cjs --suite=callable`。此組含部分 UI adapter 測試，不含整站瀏覽器檔。
3. 原畫面／恢復入口：`node tools/run-v2-return-auth-emulator.cjs --suite=browser`。交易或角色變更不可只跑此組。
4. `--list` 查看所選檔，不啟動 Emulator；無參數預設全部。局部通過不能當完整驗收。
5. 合併前完整 GitHub CI，所有必要步驟成功、head 不變、無衝突。main 更新須核對差異，必要時整合重跑。

CI 保留 Node、10 組 Chrome smoke、分組預留、真 Auth／Functions／整站、雙倉、出貨／退貨及 Rules。本批僅將根目錄兩次重複依賴安裝合為一次，不刪測試或降低閘門。

## 本輪結束標準（全部滿足才結案）

- [ ] 八類 P1 各有必要層級的代表證據，明列真入口及 fixture 邊界。
- [ ] 沒有未解 P0；試點成功不能關閉仍影響現行入口的問題。
- [ ] 數量沿共同 Core，交易沿權威 Service，沒有第二套公式或 writer。
- [ ] 原子性、冪等、併發、未知結果恢復有實際證據；分段交易列 checkpoint，不宣稱整條原子化。
- [ ] Firestore 一致性、權限、故障回滾整合通過。
- [ ] 最終整合 head 完整 CI 成功，無未解失敗、取消或安全測試略過。
- [ ] Preview 使用預定部署入口完成必要操作，記錄 commit／專案／角色／尺寸／斷言／結果；Emulator 不可勾選此項。

全部滿足即標記「本輪核心驗收完成」，停止增加未改動入口的低風險排列。後續只重開受新變更影響的風險項，不自動重開整輪。

## 固定剩餘工作與後續順序

1. 已收斂：#228／#229 全 CI 成功並合併，#226／#227 亦已合併。不再重寫建單或重做此批驗收。#228 CI `39733007540`：2239 項；#229 CI `39733010048`：2241 項，皆零失敗／略過，另 10 組 Chrome smoke。
2. CLOSE 至新單已由 #232 完成。繼續補直送、服務、估價單／Forecast 的正向代表；直送原站案例已納入本批，結果仍待 CI。只補入口與資料契約缺口，不擴張數量排列。
3. 解決發布／可用性阻擋：#198 原 Client PO 的 Rules 上限仍與 #199 追蹤。main 後端採購受 `YUSHIN_FORMAL_PURCHASE_EMULATOR` 本機 gate 保護，`functions/index.js` **截至 2026-10-22** 未匯出新版 PO／履約 Callables；Emulator 成功不代表正式入口修復。後續獨立的受控 Preview PO Callable PR 須有最新 CI 和實際部署證據才可更新此結論。不可合併舊失敗 PR 冒充解決。#131 舊 CI 曾失敗，須比較現行實作後決定採用或淘汰，不直接合併。
4. 沿同一 Service 完成受控 Preview 接線／必要驗收。不另造 writer，不順便遷移、刪除正式資料或變更敏感角色。
5. 七項結案後依序：產品識別／重複主檔、價格匯入續傳、Firebase 讀取效能、資訊複製、桌機手機介面、過時邏輯清理。主檔先唯讀稽核，正式去重／遷移另行授權。

現況：已有大量有效自動化及原畫面 Emulator 證據，**部分完成，尚不能結束整輪或宣稱正式可用**。本文件不變更商業規則、資料模型、Rules、部署或正式資料。

## 2026-10-22｜直送失敗與隔離後端試點（待最新 CI）

PR #233 原 Client 的 1280／390px「確認已採購」在 CI 39743049294 遭 Firestore Rules 1000 上限阻擋（整站 64 通過、2 失敗，後續部分步驟略過）。本批沿用唯一原採購 Service 與僅限 demo-yushin 的 Functions 試點擴充 DIRECT_SHIP，原網站經本機明確啟用的後端通道驗收；不得將此視為 #199 正式路徑已修復，不能跳過權限或勾選 Preview。正式 Firebase 資料與部署皆不動。

## 2026-10-22｜Service 與 Goods 混合訂單的初始庫存隔離（PR 待 CI）

實作範圍：既有 `reserveSingleOrderItem` 在交易內重新讀取 Service 產品主檔、來源訂單、既有需求及預留紀錄；確認產品主檔為啟用的 Service 才跳過倉庫、實貨預留、一般商品採購需求與庫存異動。初始化不產生虛擬庫存、批號或 movement；原訂單 Service 品項保留待履約數量，`reservedQty/shortageQty=0`、`reservationStatus=not_required`，Goods 品項仍沿原權威預留。舊實貨預留、已下採購或入庫的 Service 來源、異常主檔及 Service 直送模式均拒絕，不會自動清帳。

新增 Node 代表案例：純 Service、Goods＋Service、固定來源重送以及主檔／預留／供應衝突回滾。仍缺真正的服務完成紀錄、原畫面真 Auth／Rules、開票及混合單完整履約的端對端測試；此批不能把「初始不入庫」當作「服務型流程全部完成」。未部署 Firebase，無正式資料異動或主檔修正。CI 成績與合併狀態須以本 PR 最新 head 實際結果更新。


## 2026-10-22｜四類服務的實貨隔離與必要的正向驗收

PR #234 的範圍只包含訂單初始化 Service 不入庫、無實貨預留與假在途，以及一般商品送貨／退貨 writer 的 Service 禁行防護。現有「已送貨」不可冒充服務作業完成；純 Service 單的送貨視窗不提供一般商品交付操作；混合單的商品仍可走既有實貨流程。新增四服務類型的拒絕寫入測試，不取代真登入交易驗收。

未來唯一正向代表流程為：Bioplex 共用試劑（單次真採購入庫、兩張客戶單共同使用實驗批次且不重複扣整盒）、移液器送外部並返還、切片委外及成果交付、維修有／無零件兩種分支。每條需分別證明客戶受託物未進公司商品庫存、委外費用未成為實貨、完工／客戶實收／核銷各有憑證；與 Goods 同單也不能互相誤記。尚未完成這些正向路徑，PR #234 不得被描述成服務功能上線。


### 本批補強：Service／Goods 主檔雙向驗證與完工界線

訂單初始預留除驗證宣告為 Service 的品項外，也在 Goods／一般商品路徑的 transaction 內讀取產品主檔：若主檔實際為 Service，拒絕將品項偽裝成 Goods 扣占實貨。這增加每個具有 productId 的非 Service 品項一次產品主檔 transaction 讀取；因涉及貨品與服務分類正確性，暫優先保障一致性，後續再從既有主檔快取與 Rules 配合降低讀取量，不用前端聲明取代權威檢查。

Workflow Core 也不再使用一般送貨紀錄、舊 deliveredQty 投影或單純「已核銷」將 Service 判為已完成：**尚未建立真正服務完工事件以前，四類服務均保持待服務處理**。Bio-Plex 所需共用試劑仍必須經另一筆真實產品的備庫採購／入庫，不得由每張服務銷售訂單各自產生一整盒試劑需求。已有 Core／Service 代表測試；真正受託物、委外送返、材料消耗、完工交付、混合單 UI 與 Preview 尚未通過正向驗收。此階段不算服務履約功能上線。


## 2026-10-22｜原建單畫面的服務隔離代表驗收（待最新 CI）

新增 1280／390px 的純 Service 與 Goods＋Service 四個代表案例，沿原空白建單畫面、真 Auth／Client Rules、原預留初始化及重新整理，檢查服務無實貨／批號／movement／商品採購需求，混合單僅預留真商品。刻意保留未填完整的商品收件欄位，確認服務儲存及「加入下一品項」不要求虛構商品配送。後者原本仍無條件驗證物流地址，已修正並補行為回歸；商品地址及服務直送拒絕保留。

本機 Node 全套先前 1707／1707 通過，修正後成績以最新執行結果補記。Java 17 不能啟動要求 Java 21 的本機 Emulator，真 Auth／Chrome 及完整 CI 以本 PR 最新 head 結果為準，未跑過不可記為通過。此批仍不含真正服務完工、客戶交付、委外收返、材料耗用及 Preview／正式部署。


### 正規化與摘要的共同缺口修正（待最新完整 CI）

審查混合單後續更新發現，Fulfillment Core 的 normalizeItem 仍把服務未完成量重新投影成實貨缺口；已在此唯一正規化來源將 Service shortageQty 維持 0，保留既有實貨／供應數字供驗證器拒絕，不自動清帳。訂單採購摘要補傳 productType；實貨出貨摘要只計 Goods，純服務標示無需實貨出貨，既有純直送標籤保留。來源、app.js 與 Functions Core 同步建置。新增正規化冪等／衝突保留及原摘要行為回歸；原站四案例也核對正規化後的服務零缺口、無需採購與正確實貨總量。最新完整 CI 是合併閘門，尚不代表服務完工或 Preview 已驗收。

## 2026-10-23｜服務案件進度的受控唯讀查詢（相依 PR，未啟用正式環境）

沿用唯一 `serviceCases` 事件及 `YushinServiceWork.projectServiceCase` 投影，不額外建立狀態帳或快取。新增 `getServiceCaseStatus` 後端讀取契約，僅在 `demo-yushin` 真 Auth／Firestore／Functions Emulator 明確啟用；正式環境 gate 預設拒絕。讀取交易重驗登入者的 users 角色與停權狀態、來源訂單及 Service 品項；業務僅能查看自己的訂單，倉管／工程師／管理員沿既有服務作業角色規則。既有案件回傳受驗證的事件、保管位置與下一步；不存在的 case ID 明確回報 `exists:false`，不建立虛構案件。已取消訂單可唯讀歷史，不能繼續寫入事件。

新增 Node 授權／壞資料／無副作用測試及 Emulator 原 Auth→Callable 的不存在、建立、委外寄送、他人拒絕、取消後歷史可讀、停權拒絕案例。這**不是**案件搜尋／建立操作介面或可用服務模組：仍需案件與訂單數量綁定、正式授權入口、原站桌機／手機、客戶交付／核銷與 Preview 驗收。未部署或修改正式 Firestore。


### 2026-10-23｜服務案件的原產品綁定（demo Emulator）

新案件由唯一 `commitServiceCaseEvent` 在交易內保存 `productId`，後續寫入、同事件重送與 `getServiceCaseStatus` 均核對來源訂單品項的產品識別及服務類型；相同 itemId 換成另一個服務產品也不得接續或套用原歷程。未保存 productId 的既有試點案件明確拒絕，不從目前品項猜測補綁、不遷移正式資料。歷史查詢仍驗證當前登入權限與來源品項，保留取消後唯讀；產品主檔停用、刪除或分類變更不抹除已綁定的歷史保管證據，新增事件仍需有效主檔。

不增加 Collection、索引、Listener、查詢或資料庫讀取；唯一既有案件文件增加 productId。案件數與訂單數量、原頁面操作、客戶交付與核銷及 Preview 仍待完成，PR #234 維持 Draft，正式功能未啟用。

驗證：Node 與真 Auth／Callable Emulator 新增原產品換檔後讀取、接續及同 ID 重送拒絕，以及取消後原主檔不存在仍可唯讀歷史。完整 CI 以本 PR 最新 head 結果為準。


### 2026-10-23｜原訂單列表的受控服務進度提示（PR 相依，唯讀）

原訂單的「服務案件」視窗在使用者**主動查詢單一服務品項**後，會將後端已依註冊案件索引與 Workflow Core 驗證的 `completedQty / orderedQty`、`itemWorkCategory` 顯示在該訂單的列表金額欄下方。僅限 `demo-yushin` Emulator 閘門、同一登入 UID／角色／session、同一訂單／品項，記憶體提示最多保留 120 秒；資料來源不一致或回覆延遲被廢棄，不能從訂單 `deliveredQty`、`isDelivered` 或 `isBilled` 反推服務完工。未主動查核不會觸發每列 Callable，也不新增 Firestore 讀寫、collection、索引或 listener。

這是**最近查核的畫面提示，不是權威持久履約分類**：不修改訂單 `workCategories`、工作圖卡數量、核銷按鈕與 `setOrderBillingStatus`。另一人更新服務案件後，需再點「服務案件」重查；原訂單列表／工作卡的完整分類與核銷 writer 仍需在後端接上全部服務案件證據，混合單與 Preview 尚未驗收。正式 Firebase 未啟用。


### 2026-10-23｜整張服務訂單的單次權威查核（本 PR，未整合核銷 writer）

在原「服務案件」視窗新增使用者明確觸發的「查核整張服務單進度」。原 `service-work-core`、`workflow-core` 與 `serviceCases` 案件索引仍是唯一計算／事件來源；`getServiceOrderProgress` 只在同一後端 Firestore Transaction 中重讀登入者角色、來源訂單、所有 Service 品項、產品與案件索引，合計各品項已核實完成數量及待完成量。Goods 同單時標記 `mixedOrder`，不將 Goods 送貨、訂單 `isBilled` 或前端緩存當成服務完工證據。

查核可讀範圍：最多 30 品項、最多 100 個已註冊服務案件／整單；超過上限明確拒絕整單查核並保留各品項獨立讀取，不暗自截斷案件。只在使用者點查核時發生，原訂單列表 render 不增加 Callable、collection、索引、Firestore 寫入或 listener。業務只能查負責訂單，停權或未授權角色不得讀取。已取消訂單仍可查核歷史，但該服務品項狀態為停止履約。畫面顯示服務完成量與上次核實工作分類；既有僅供參考的列表提示可沿用該次回覆。

**明確未完成：**此時不會改寫 `orders.workCategories`，不啟用服務核銷 writer，也不宣稱整張混合訂單可核銷；`billingRecorded` 僅反映訂單現有財務旗標，與服務完成證據分離。仍限 `demo-yushin` Auth／Functions／Firestore Emulator 閘門，正式部署與 Preview 驗收尚未開始。

## 2026-10-23｜正式採購 Preview Callable 接線（待 CI 與實際 Preview 驗收）

- 唯一交易仍是 `functions/formal-purchase-commit-service.js` 的 `commitV2FormalPurchase`：同一 transaction 讀取真 Auth 使用者、訂單、產品、倉庫、採購需求，再提交 PO、Supply、需求、來源訂單；沒有第二套 writer 或新增庫存帳。
- `functions/index.js` 匯出經 `formal-purchase-preview-callable.js` 保護的 `commitV2FormalPurchase`。後端必須 `ENABLE_PREVIEW_FORMAL_PURCHASE=true` 且實際專案、Firestore 同為 `preview-20135`；正式 `yu-shing-company` 即使有同名開關亦拒絕。完整本機 Auth／Firestore／Functions demo Emulator 才可用 `demo-yushin`。**預設關閉，合併 GitHub 不等於已在 Preview 部署或啟用**。
- Preview 網站需在已載入畫面的同一 session 明確設定 `window.YUSHIN_PREVIEW_FORMAL_PURCHASE=true`；原「確認已採購」才轉接後端。網站限定 `preview-20135.web.app` 或 `preview-20135.firebaseapp.com`，核對真登入專案與 UID，拒絕把 Preview Auth 指向本機 Emulator。任何 Callable 失敗／未知回覆都**不回退**舊 Client writer，保持原 PO 編號與核對憑證。
- 已有客戶訂單實體品項的 1–5 列、倉庫入庫或原廠直送可參與試點；手動補貨、服務品項、超過五列及混合不符合者維持明確拒絕，不得臨時放寬後端驗證。產生文件與確認已採購仍是兩個動作。
- 真 Auth demo Emulator 持續透過 `node tools/run-v2-return-auth-emulator.cjs` 測試同一 Preview adapter；本機 Node gate 測試包含正式專案拒絕、匿名／不同專案拒絕、原畫面接線及未知回覆。**仍須在實際 Preview 專案**取得登入角色、4/7 部分採購、重複提交、拒絕／回滾及來源／Supply／需求回讀證據，才可標記 Preview 已驗收。
- 本批不得直接部署 `yu-shing-company`、啟動正式後端，或修改正式資料；#199 維持開啟直到正式切換另行授權且正式環境驗證成功。
