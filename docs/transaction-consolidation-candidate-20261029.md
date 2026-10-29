# 2026-10-29 交易整合候選版本

## 範圍與分界

以 GitHub main `747746ca2b7c485d32cbd61731247e426282e684` 為正式基準，整合下列遠端 PR head；保留各原始提交與合併紀錄。這是供集中驗收的候選版本，尚未上傳、建立 PR、合併 main 或部署。不得把本機回歸視為正式交易驗收通過。

| PR | head | 整合範圍 |
| --- | --- | --- |
| #345 | `079e182` | 同倉／跨倉 grouped 與整單初始預留後端 Preview |
| #331 | `891d51c` | 客戶送達確認 Preview，包含於 #332 ancestry |
| #332 | `6eb8257` | 客戶送達撤銷 Preview |
| #336 | `cd53996` | 全單取消／恢復 Preview |
| #337 | `e4d24ad` | 預設關閉的手動採購正式切換設定 |
| #339 | `d45d2bc` | 正式 PO Firestore 專案一致性 |
| #341 | `a4eac77` | 隔離平行 CI 與 regression 必要彙總閘門 |
| #343 | `57544d9` | 移除 7 個無引用 helper，來源碼與生成檔共減 112 行 |

排除 #338：合法五筆雙倉仍超過 Rules 運算上限的原型不得合入候選。也不包含 #334／#335 正式營運資料清理；本次沒有刪除正式資料。

## 整合修正

1. 解決 `tests/v2-return-callable-adapter.test.js` 的互斥索引斷言：同時要求獨立受控的送達確認、撤銷與 lifecycle Callable；仍禁止匯出隔離測試 adapter。
2. 解決 CI workflow 衝突：保留平行套件、17 個原 Chrome smoke 與原 Emulator 檢查，加入 #345 整單 Admin 整合、同倉顯式啟用與整單顯式啟用 Auth Callable 步驟。任何上游失敗、取消或 skipped 都不得通過 `regression`。
3. 整單初始預留 Callable 改為可獨立測試的 transport factory，沿用唯一 `commitOrderReservation` writer。呼叫前核對實際 `db.projectId`；Preview 不接受混合 Emulator 設定，demo 必須同時啟用 Functions、localhost Auth 與 Firestore Emulator。正式專案仍無啟用路徑。
4. `app.js` 由來源重新生成，沒有手動修改生成檔或放寬 Rules。

## 本機驗證

- 非 Rules Node 完整回歸：**1,997／1,997 通過，0 fail、0 skip**。
- 整單預留 Callable 新增驗證：異專案在交易前拒絕、缺少真 Auth 拒絕、混合環境拒絕、偽造欄位拒絕、權限錯誤與不明結果處理。
- `node tools/build-app.cjs --check`、`node tools/build-functions-core.cjs --check` 通過。
- `src`／`functions` JavaScript 語法檢查、差異空白檢查通過。
- YAML 解析與腳本引用比對：main 及 #345 的全部 Chrome／直接 Emulator 腳本引用均保留；兩個顯式預留啟用步驟及 fail-closed regression 閘門保留。
- 本候選 GitHub CI：**未執行**。既有獨立 PR 的 CI 不替代本候選 CI。
- 本候選真 Auth／Functions／Firestore Emulator、Chrome 1280／390px、Rules：**本機未執行**；本機缺少相依、Chrome 與指定 Java 21 環境。
- 真 Preview 與正式角色驗收：**未執行**；先前 PR 記載 Preview 被刪除，本次未透過 Firebase 重新確認或重建環境。

## 舊程式保留與下一階段

| 仍保留路徑 | 保留理由／移除前必要工作 |
| --- | --- |
| `reserveSingleOrderItem` | 正式舊初始預留路徑仍使用；#345 只完成受控新入口，#311 原生 SDK 問題尚未全面封鎖 |
| `commitQuickPurchase` client transaction | 正式手動採購尚待 Preview、旗標、版本及真角色切換驗收 |
| `commitFormalPurchaseOrder` client transaction | 正式 PO 唯一後端切換與角色驗收未完成 |
| lifecycle client transaction | 整合受控 Preview 不等於正式取消／恢復已切換 |
| legacy 送達更正及退貨 writer | 必須先完成對應受控後端、真實切換及回覆不明恢復，再逐項淘汰 |

下一步先上傳此具體候選並建立 Draft PR，跑一次集中完整 CI；保留原 PR 的審查分界，禁止繞過 branch protection 或用整合綠燈宣稱正式已啟用。#311 後續仍需遷移其餘 reservation writer、完成來源與回覆的專案一致性／恢復驗證，才能收緊原生寫入權限並移除舊 writer。正式部署、旗標及資料異動另依專案授權規則處理。

## 上傳阻礙

本次 `git push -u origin feat/transaction-consolidation-20261029` 被自動核准審查拒絕，理由為未明確授權發布此批本機整合內容至遠端。沒有改用其他工具繞過拒絕；待使用者授權此範圍的上傳與 Draft PR 建立。該授權不包含 main 合併、Firebase 部署、旗標或正式資料異動。
