# 訂單調撥真Auth／Callable驗證接線

相依 #366，關聯 #291。原隔離runner的all／callable群組加入emulator-order-transfer-callable.cjs；臨時Functions fixture引用正式index輸出的dispatchOrderTransfer／receiveOrderTransfer，不另建測試writer。只有臨時demo環境檔啟用兩個獨立旗標，正式設定不變。

新增五個真Auth SDK→Functions Callable→Firestore案例：相同ID並行寄出／收貨及丟棄回覆後重播；未登入／途中撤銷角色／v2／不同意圖拒絕；目的批次碰撞後原操作修復續傳；真Firestore晚期create碰撞整筆回滾；不同寄出ID競爭同一品項只能成功一次，以及寄出後訂單改派負責人拒絕收貨。檢查公司與分倉實貨／reserved、批次成本參照、兄弟品項、原憑證及無客戶送達。

補上原後端收貨對寄出ownerUid／salesCode與最新訂單的綁定，避免訂單改派後沿舊來源繼續收貨；本機新增模擬交易確認拒絕時無寫入。初始訂單仍為Admin fixture，不是原建單UI驗收；丟棄回覆後重播也不等同真實網路故障測試。

本機Node2090/2090、build一致性／語法／diff及runner --suite=callable --list通過。本機沒有firebase-admin／firebase-tools／Emulator runtime，未執行本機真Auth／Functions／Firestore，五個新案例由遠端CI執行，待結果；不得寫成已通過。原網站Chrome新流程／Preview／集中人工驗收未執行。

原UI尚未接線，仍是預設關閉demo-only入口，無多倉／custody／業務交接接管。保持Draft，未合併main、部署、開正式旗標、改Rules或正式資料。下一步看CI結果修正，再接原介面持久意圖／回覆遺失／刷新恢復；最後集中人工驗收。
