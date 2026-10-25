# 退貨 Auth／Callable 整合（2026-10-18）

僅 demo-yushin 的 Auth、Functions、Firestore Emulator。未部署Firebase，未啟用新正式Callable／操作頁，未更動正式Auth provider或帳號。

## 邊界與執行

functions/v2-return-callable-adapter.js 使用Firebase v2 onCall包裝原planLocationReturnTrace與commitLocationReturn。正式index.js不匯出adapter；tools/run-v2-return-auth-emulator.cjs在臨時Functions目錄載入tests/fixtures/v2-return-auth-functions.cjs，再引用實際checkout的原服務與SDK。只新建傳輸adapter，沒有另一個writer／Core。

入口要求ENABLE_V2_RETURN_AUTH_EMULATOR=true、FUNCTIONS_EMULATOR=true、demo-yushin、本機Auth／Firestore host，以及實際db.projectId一致。臨時.env.local供Functions discovery／runtime載入旗標；checkout.json只保存本機來源位置，執行後刪除。Firebase本身驗證token，原Service在交易內重讀users角色與active、order所有權和實際來源；不信任token自訂role或payload身份。可預期業務錯誤轉為對應HttpsError，未分類錯誤只回通用internal訊息。

本機需Node22與Java21，先安裝根目錄firebase／firebase-admin@14.2.0與functions依賴，再執行：

```sh
npm install --no-save --no-package-lock firebase firebase-admin@14.2.0
npm install --prefix functions --no-save --no-package-lock
node tools/run-v2-return-auth-emulator.cjs
```

runner固定--project demo-yushin、--only firestore,auth,functions；不接受正式project輸入。CI在原Auth／Callable測試後另開獨立一輪Emulator，避免互相污染。

## 驗收內容

七組實際整合：正常與取消CLOSE的登入查核→入庫→重送→刷新剩餘額度；五角色；陌生所有權／偽造UID與role／挪用receipt；token已發出後降權及停用、自訂claim不得越權；未登入／壞token／缺profile；併發同ID只入庫一次及意圖衝突；來源sync變更。另三組一般Node測試驗證環境gate、未登入／錯資料庫不進服務、正式index無export。結果以本批實際CI為準。

每份測試從Auth Emulator建立合成帳號並透過Client Auth SDK登入，再由Functions SDK帶真實ID token呼叫；唯讀比對前後資料無寫入，入庫核對stock／lot／order／movement、真實actorUID與固定receipt。庫存與批次、預留、商業數量仍由原Service／Core計算，沒有第二套回應假資料。

## 驗收限制

上游order／inventory仍為Admin fixture；初始化現透過tests/fixtures/v2-order-initialization.cjs載入原src同步、雙倉預留協調、採購需求與索引，完成狀態由原writeOrderInventorySyncState產生，不再直接設completed。品項預留只轉接原v2 Service，沒有第二個writer／Core；初始自行訂貨不在本輪範圍。

新增七組Firestore實際初始化驗收：有缺口需求、預留後需求前中斷、完成重送、舊工作晚回覆、角色／所有權／active、完成回覆遺失、切換帳號與恢復。原七組真實登入退貨現在全數走這個初始化流程，再做原打單／出貨／送達／取消／CLOSE。測試adapter以Admin SDK讀寫，初始化本身尚未接Client Rules／登入傳輸與建立訂單UI；來源建立及初始庫存仍為種子資料，不能宣稱完整ERP初始化或正式Preview／UI已可使用。結果以本輪實際CI為準。


## 2026-10-19 原打單介面的 v2 Auth 傳輸試點

本節僅擴充 demo-yushin 隔離 Emulator 的介面驗收，未解除正式／Preview v2 限制。原訂單頁與採購頁 markOrderItemDispatchPrepared → prepareOrderDispatch，在明確 YUSHIN_V2_DISPATCH_EMULATOR=true 時轉接 prepareV2OrderDispatchEmulator；其餘一般打單路徑不變。介面沿原 warehouseShipmentState，從原 raw item 的 warehouseShippedQty 計算已消耗的打單額度，不將客戶送達當出貨，也不改寫其他數量投影。原 sessionStorage intent 另保存既有 inventoryReservationAttemptId 作 syncAttemptId，固定操作 ID／數量／打單基準；v2 intent 不得降級改送一般交易。

傳輸要求 localhost／127.0.0.1、Auth 與 Functions SDK 的實際 app.projectId 均 demo-yushin、Auth emulatorConfig 為本機9099，並強制 Functions SDK useEmulator(127.0.0.1,5001)。實際 Auth currentUser.uid 必須等於原前端 actorUid，呼叫前後與回讀訂單後均核對目前帳號／角色；payload 不含 actorUid／role。未載入 Functions、缺同步 ID、環境不符、回覆不明或網路失敗均不 fallback 到一般 writer，保留原作業。成功後只回讀真實 order 更新 cache，不以回應 counters 拼造訂單。

沿既有隔離 v2-return-callable-adapter／runner 新增 prepareV2OrderDispatch，唯一 writer 仍 commitLocationDispatchPreparation。Firebase SDK 驗證登入 token，原 Service 重讀 users 的實際角色／active／disabled；自訂 claims 或 payload 不授權。v2 後端仍允許原 admin／purchaser／warehouse，現有兩頁 UI 仍只有 admin／purchaser 可操作，沒有新增倉管按鈕。正式 functions/index.js 不匯出此入口，沒有 Functions／Auth provider 部署或正式資料寫入。

原 normalizeLocationDispatchIntent 新增可選 expectedPreparedQty，提供時納入 canonical hash 且在讀取原 receipt 確認尚未提交後，於同一交易核對 prepared 基準。不提供者的既有 hash／重送契約不變。僅已確認未提交且基準過期，回 failed-precondition＋details.reason=dispatch-stale，由原 handler 清除舊提案，更新後再確認；未知提交結果不清除。沒有新持久欄位、Collection、Rules、Index、Listener 或數量／預留 writer。

新增五項 Node 測試與四項 Auth SDK→原 UI handler／Service→Functions SDK→原 writer→Firestore 整合：多品項含同商品及另一商品、admin／purchaser 的不明回覆／重新載入原 ID、五角色、即時降權／claim 偽造、未登入／payload UID／停用、同 ID／競爭 ID／打單基準與同步版本。既有八組 Chrome 中，打單 suite 加測1280／390px 原兩頁 renderer 與 click handler，在尚未確認送達的實體出貨後使用正確 Core 額度並跨頁重試；其 Callable 為 scripted local transport，真實 Auth／Backend 由獨立整合測試驗證，不宣稱完整 Browser Auth／Preview E2E。

本地 Node1571/1571、建置同步／語法／diff 通過；完整新增 Auth、Chrome 與既有全部 Emulator／Rules 以本批 CI 為準。v2 初始化、收貨、出貨、送達、取消／恢復與退貨的正式傳輸／UI／Preview 全線仍待逐步接線。


## 2026-10-19 實體倉分批出貨的隔離 Auth 傳輸

在同一個只供本機 demo-yushin 的 v2 Auth／Functions／Firestore Emulator adapter 新增 `shipV2WarehouseItem`，直接呼叫已存在的 `commitLocationShipment`，不建立第二個出貨 writer。沿用原 adapter 的真實 Firebase 登入 token、Emulator 閘門、projectId 檢查、業務錯誤轉換及交易內 users 即時角色驗證；請求不得帶 actor 身分或自訂權限。原 Service 驗證庫存來源同步、完整 1–5 品項證據、倉庫、批次、打單額度、出貨意圖與固定 operationId；出貨扣實貨／預留，但不視為客戶送達。

新增真正 Auth SDK → Callable → 原 shipment Service → Firestore 的第二倉部分出貨、原 ID 重送、意圖碰撞、五角色／中途降權／偽造 token claims、未登入與無效資料拒絕測試。此批**只補齊後端傳輸驗證入口**，原倉庫出貨 UI 尚未改走 v2，正式 `functions/index.js` 沒有匯出；不代表 Browser Auth／Preview E2E 已完成。未部署 Firebase、未修改正式資料，須待完整 CI 及後續介面接線再評估啟用。
