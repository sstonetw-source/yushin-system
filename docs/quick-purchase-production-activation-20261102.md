# 手動採購前端正式切換候選（#268）

## 目前完成範圍

本文件與同批 PR 是待授權的正式入口切換候選；合併 main 會自動發布 Pages，必須先取得獨立正式切換授權。

基準 main：`f8cd037112745e38f509b1fe7ea7a92d9dd6126c`。既有 `commitV2QuickPurchase` 已經使用者獨立授權部署至 `yu-shing-company`、asia-east1、Node.js 22；管理回讀 ACTIVE，hash `c88c638cb482ddc0e978b51e0e18a0fd978462b7`，`ENABLE_PRODUCTION_QUICK_PURCHASE=true`。未登入請求401，不代表真 purchaser 交易已驗收。

此 PR 只調整既有路由設定、資產版本及相符的已部署環境旗標紀錄，重用原 Service／Callable／交易核心。沒有新交易計算器、Rules、索引或角色契約變更，不移除仍在使用的舊 writer，也不部署 Functions。

## 可授權的最小切換範圍

1. 核對 PR head／最新 main／必要 CI／審查狀態；重新讀取目標 Callable 的 ACTIVE、hash與後端 gate，若與上述已驗來源不同先停止。
2. 授權後合併此 PR，只在 `https://sstonetw-source.github.io/yushin-system` 及其子路徑，將 `YUSHIN_PRODUCTION_QUICK_PURCHASE`、`YUSHIN_PRODUCTION_QUICK_PURCHASE_LEGACY_BLOCKED` 同時啟用。HTTP、其他連接埠、仿冒網域、其他 repo、Firebase Hosting 網址與本機／Preview不啟用。
3. 保留正式 PO、整單預留及其退役鎖既有設定。前端依然核對 Auth、Functions、Firestore同專案及最新使用者身分；後端逐次驗證 live role／來源與可採購數量。
4. 等 Pages 成功，從正常正式網址回讀 index.html、其實際引用的版本化設定資產，確認內容與 merge SHA 一致，正式網址 quick／退役鎖均true；其他網址仍false。既有 app.js 不變，不為設定變更重新打包或改其資產版本。
5. 這份最小授權**不包含**建立訂單、提交手動採購、調整庫存、修改角色或其他正式資料，也不包含部署 Functions／Rules／索引。正式交易驗收須另有具體範圍與授權。

## 正式角色驗收待辦（不得冒稱已通過）

- 使用既有真 purchaser 身分；先唯讀核對授權的純測試產品與來源訂單／品項、owner、目前數量與可採購需求，確保沒有其他待確認操作。沒有合格來源時先決定限定試單建立範圍，不使用實際客戶單。
- 授權的正常 UI 手動採購呼叫唯一 `commitV2QuickPurchase`，確認不再觸發舊 Rules-only 多文件交易；記錄原 operationId。
- 權威回讀 Order／Demand／Supply／purchaseOperations／company與warehouse incoming／唯一movement，確認來源及數量一致，沒有重複在途或部分完成。
- 已完成的六項隔離安全驗收與原操作恢復成果沿用；正式只補真 purchaser 與部署差異。沒有安全控制能力時，不在正式系統引入提交後故障或更改角色重現罕見時序。
- 不寄供應商信、不進行對外採購、付款、收貨或出貨。試單收尾方式須事前核對正常交易能力，不能假設取消訂單會撤銷已成立的採購／在途。

## 中止與恢復

- 先停止新手動採購，保留原 sessionStorage、operationId、fingerprint及原內容；不要清除網站資料或換 ID。
- 前端暫停路由時，退役鎖在正式網址持續true，新的分頁／沒有pending的操作也禁止回退舊Client Transaction。不得把整份 rollout 設定回到切換前版本，這會撤銷退役鎖。
- 後端停用 `ENABLE_PRODUCTION_QUICK_PURCHASE` 需要獨立授權；新請求明確拒絕。已在處理的請求須逐一回讀原憑證，不假設關gate能撤銷已提交交易。
- 修復及重新授權後恢復同一後端路由，以原ID／原意圖核對，不補寫部分帳目或放寬Rules。
- 前端鎖不能防止仍快取舊程式的客戶端；正式切換與角色驗收完成後，才另外審查舊writer移除及Rules封鎖相容性。

## 完成分界

程式／CI完成、Pages入口啟用、真角色成功交易、全生命週期正式驗收是不同階段。此PR通過不關閉#268，不代表收貨或其他後端入口已正式切換。
