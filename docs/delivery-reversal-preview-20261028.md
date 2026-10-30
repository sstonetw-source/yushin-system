# #330 客戶送達撤銷：獨立受控 Preview 後端

本批只移轉「撤銷既有客戶送達確認」交易，不是取消實際出貨、更不是倉庫庫存回補。沿用既存 `reverseShipmentDelivery`、來源出貨 immutable movement、退貨憑證及 Fulfillment Core。**此程式即使合併也不代表允許部署、啟用 Preview 旗標或異動正式資料。**

## 預設關閉的獨立入口

| 專案 | 必要條件 | 結果 |
|---|---|---|
| `demo-yushin` | `ENABLE_V2_DELIVERY_AUTH_EMULATOR=true`、`ENABLE_V2_RETURN_AUTH_EMULATOR=true`、`FUNCTIONS_EMULATOR=true`、本機 Firestore/Auth Emulator | 受控 `reverseV2ShipmentDelivery` Callable |
| `preview-20135` | `ENABLE_PREVIEW_DELIVERY_REVERSAL=true` 且無任何 Emulator 標記與連線 | 受控 `reverseV2ShipmentDelivery` Callable |
| 其他專案（含 `yu-shing-company`） | 任意旗標 | 拒絕，沒有正式生產啟用路徑 |

確認與撤銷**使用不同的 Preview 旗標**，一項開啟不會間接開啟另一項。伺服器在取得資料庫後重新驗證實際專案；transaction 內再次核對 live `users`、admin／原 owner 的 sales／engineer、原簽收紀錄、同步憑證、實際出貨 movement、完整訂單投影及退貨依賴。不同意圖重用同一 `operationId` 必須拒絕；同意圖重送回傳 `already-applied`。取消已被實物退貨引用的送達紀錄仍禁止。

## 前端失敗恢復與舊交易保護

- 僅在 Preview 網域、正確 Auth／Functions／Firestore 專案、原登入 UID 與旗標一致時送到後端；否則拒絕，絕不回退 `runRoleTransaction`。
- 第一次提交前在 `sessionStorage` 固定 `operationId`、`deliveryRecordId`、`itemId`、`syncAttemptId`、撤銷日期與原因。回覆不明、頁面刷新或原紀錄已不在畫面，仍用原憑證重送。
- 必須核對後端成功／冪等回覆的操作、訂單、品項及原送達紀錄，再從伺服器讀回訂單，才能清除 pending 意圖。
- Preview 旗標關閉時不顯示新撤銷按鈕；已留下未確認憑證時，即使環境值被切回舊版，也禁止所有舊送達 writer。舊式送達更正、快速取消與回補庫存並未在 Preview 放行。

## 驗收與 Legacy 淘汰條件

- 定向 Node 測試：獨立閘門正反案例、冒用 Auth／專案、原 ID 回覆遺失與重試、變更意圖拒絕、身份變更、舊路由禁止回退、Callable 錯誤遮罩。
- 正式合併前還需最新 main 全量 Node、生成檔／語法、真 Auth／Functions／Firestore Emulator、1280px／390px Chrome、Firestore Rules 與完整 CI 全綠；若未通過保持 Draft。
- 現有實體來源仍限 1–5 品項，15 品項投影支援不代表撤銷交易已獲准擴大。
- 真 Preview 發布、角色現場驗收、旗標啟用、正式入口切換及 **刪除任何 legacy writer** 皆是後續獨立授權／PR，不能由本批自動執行。
