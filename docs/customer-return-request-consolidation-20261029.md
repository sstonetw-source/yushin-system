# 退貨申請／撤回後端整合候選

接續 #347／PR #348，基於其修正後分支，尚未合併 main。這是整合修改批次，完整生命週期及人工驗收留到整體修改完成後集中執行。

## 修改範圍

- 申請與撤回分別匯出 `requestV2CustomerReturn`、`withdrawV2CustomerReturnRequest`，共用一個 request service，僅更新原訂單的申請紀錄，不寫庫存、movement、批次或實收憑證。
- 獨立預設關閉的前後端旗標：Preview 使用 `ENABLE_PREVIEW_CUSTOMER_RETURN_REQUEST`／`YUSHIN_PREVIEW_CUSTOMER_RETURN_REQUEST`；demo 使用 `ENABLE_V2_RETURN_REQUEST_AUTH_EMULATOR`／`YUSHIN_V2_RETURN_REQUEST_EMULATOR`。啟用實收不會順便啟用申請，正式專案無啟用路徑。
- 後端讀取最新使用者與所有權，重用原履約投影、原出貨 movement、退貨憑證及整單 ledger 驗證。適用既有 v2 實體倉來源與原核心 1–5 品項界線；不將純投影 15 項能力視為此入口已支援 15 項。
- 申請餘量以原送達扣除已實收退貨與其他待收申請；每單最多 30 次申請。撤回只取消未實收的申請餘量，已實收紀錄與庫存不動；已實收完成的撤回是明確 `not-pending`，不重新寫入。
- 抽出既有 request history validator，讓申請、撤回、實收共用同一份數量／歷史一致性檢查。
- request ID、固定 operation ID、來源同步識別、原使用者／角色與 canonical hash 保留在原申請紀錄；撤回憑證以原申請內的取消 metadata 保存，不新增集合。這些只存在預設關閉的候選後端，未執行正式遷移。
- 前端先持久保存完整意圖，回覆後核對原訂單內的憑證再清除。重載以原操作恢復；Preview 關旗標或錯誤不得回退 legacy client transaction。原 UI 新增前次結果確認入口，保留正式舊路徑直到實際切換。
- 修正收貨清單最外層恢復區：不再因 Emulator 旗標關閉而隱藏 pending。內層既有角色與原憑證核對仍保留。

## 必要檢查

- Node 定向與一般回歸、生成檔一致性、語法及 diff 檢查，以 PR 實際紀錄為準。
- 既有 Auth／Functions／Firestore 隔離 CI 增加原申請重送、越權、超額與部分實收後撤回的整合案例；harness 使用正式候選匯出，不另複製 writer。
- 本機未執行真 Emulator／Chrome 或真 Preview。既有 CI 自動執行，但不要求使用者逐項人工驗收。

## 前置 PR #348 的 CI 修正

原 CI `40805919904` 的九組測試中，八組成功，stock 組只有一項使用舊「僅允許 demo-yushin」文字的斷言失敗。正式專案仍實際被拒絕。獨立修正 `0eaf8da` 已推回 #348，明確核對 `failed-precondition`、受控環境拒絕訊息與原資料無異動，沒有更改安全閘門；本候選沿用該修正。

## 仍未完成

舊格式／直送退貨、待檢／報廢、取消採購轉備庫、其餘預留與調撥仍待接續整合；本批不表示 #311 或 #291 結案。沒有正式部署、旗標啟用、Rules 變更、正式資料異動或移除仍使用中的舊入口。
