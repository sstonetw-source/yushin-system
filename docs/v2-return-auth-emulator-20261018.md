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

上游order／inventory為Admin fixture，預留／打單／出貨／確認／取消／恢復沿既有Service建立真實業務事件；來源inventoryReservationStatus completed仍為明確fixture checkpoint。此批只驗收退貨傳輸與登入邊界，不能宣稱完整訂單初始化、真實UI／正式端點或Preview已可使用。正式Callable／前端接線、完整初始化與其他物流模式、退貨更正／撤銷／REPLACE後續仍未完成。
