# #330 客戶送達確認：受控 Preview 後端與舊交易禁止回退

本批建立獨立的「客戶已收到貨」後端入口，不是實體倉出貨，也不做第二次庫存扣帳。以已存在的 `commitShipmentDelivery` 原子交易及 `projectOrderShipmentReturns` 為權威；不改動其庫存、批次、實際出貨 movement 和退貨 Core。**程式合併不代表部署、啟用旗標或批准任何正式資料操作。**

## 後端閘門

| 專案 | 必要條件 | 結果 |
|---|---|---|
| `demo-yushin` | `ENABLE_V2_DELIVERY_AUTH_EMULATOR=true`、`ENABLE_V2_RETURN_AUTH_EMULATOR=true`、`FUNCTIONS_EMULATOR=true`、本機 Firestore/Auth Emulator | 可用受控 `confirmV2ShipmentDelivery` Callable |
| `preview-20135` | `ENABLE_PREVIEW_DELIVERY_CONFIRMATION=true`、無 Emulator 標記與連線 | 可用受控 `confirmV2ShipmentDelivery` Callable |
| 其他專案（包含正式環境） | 即使設定仿冒旗標 | 拒絕；無正式啟用分支 |

伺服器比對 Functions 環境專案與實際 Firestore 專案，拒絕匿名請求；在 transaction 內重新讀取 `users` 的啟用狀態、角色、訂單所有權、同步識別碼、完整出貨／退貨憑證及整單投影。僅管理員、業務或工程師可送達確認，業務／工程師仍只能操作自己的訂單。無法用客戶端提供的 UID、角色、任意欄位或其他操作 ID 冒充交易；失敗後相同 ID 重送為既有冪等契約。送達撤銷 Callable **未**因此公開。

## 前端保護

- 在 `preview` 環境，送達一律進入受控模式；沒有 `YUSHIN_PREVIEW_DELIVERY_CONFIRMATION=true`、不是 Preview 正確網域、Auth／Functions／Firestore 專案不一致或登入身分變更時，明確拒絕且不走 `runRoleTransaction`。
- 成功或回覆遺失後，`sessionStorage` 保留同 UID／訂單的固定意圖與 operationId；成功回覆必須核對送達來源後，再從伺服器讀取訂單才能清除。改動數量、品項或來源出貨不能當作相同重試。
- 若原 Preview 回覆不明確後，前端旗標甚至環境值被改掉，只要尚有固定的送達意圖，舊版新增、快速完成、取消全部、編輯與更正 writer 都拒絕執行。
- Preview 僅開放送達確認：不顯示「撤銷送達確認」入口，也不開放舊式送達更正／庫存回補、歷史推估清除等寫入；撤銷仍需另一項獨立後端驗收。既有本機 Emulator 撤銷測試入口保持原限制。

## 驗證與待辦

本地 `node --test`（不包含需要安裝獨立相依套件的 `firestore-rules.test.js`）在同步已合併的 PR #329 main 後通過 **1,945／1,945**；包含 Preview 權限／環境閘門、回覆遺失重開頁面、關閉旗標禁止舊 writer、舊送達功能相容、建置一致性。`node tools/build-app.cjs --check` 通過。

仍需在 **#330 獨立 PR CI** 驗證完整 Rules／Emulator／Chrome，再由明確授權的獨立部署流程驗收 Preview 真實帳號、1–5 品項、多倉分批送達與失敗重試。驗收前不能刪除舊 writer、放寬 Firestore Rules、修改正式旗標、正式資料或執行 Firebase 部署。
