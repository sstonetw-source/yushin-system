# #311：同倉預留憑證完整性（Rules 修正原型／待審查）

## 實際缺口及限制

此批只調整已存在的 `inventoryReservations`、`inventoryMovements`、`inventory` 與 `warehouseStocks` 原子交易驗證；沒有放寬角色、來源、數量或權限，也沒有更改正式資料或部署 Rules。Firestore Standard `(default)`；隔離測試專案 `demo-yushin`。

原本主要憑證將 `reservationIds` 全數計入公司預留差額，卻把 `warehouseReservationIds` 以外的同倉異動忽略，因此兩筆數量各 +1 的預留可能令公司 `reserved=2`、同一分倉 `reserved=1`。次要倉的連結憑證也可能被拆成兩張只列部分本倉項目的 movement。

## 防護策略

1. 主要憑證：所有有本倉數量差額的 global ID 都必須列入 local IDs；所有有數量／倉庫變動的 global sibling 必須指向**相同的公司主要 movement ID**。避免用兩張主要憑證各自證明相同公司差額。
2. 次要憑證：以**所有 global ID** 計算該倉真實差額；本倉差額非零的 ID 不得漏列，local ID 也必須屬於本倉或零量紀錄。保留既有 primary-linked 集合、來源、商品、角色與憑證核對。
3. 保留已存在的單倉驗證、雙倉實際流程與 Warehouse Transfer 專用驗證；不新增 writer 或資料欄位。

## 攻擊與對照案例（Firestore Rules Emulator）

| 類型 | 期望與檢查 |
|---|---|
| 同倉兩筆 +1，兩張 primary 各漏列另一筆 | 拒絕整筆；所有 stock／reservation／movement 不動 |
| 同倉兩張 primary 均完整列出兩筆，試圖重複證明公司差額 | 拒絕整筆；不接受第二個權威 movement |
| 跨倉 A 一筆、B 兩筆，B 分為兩張不完整 linked movement | 拒絕整筆；B 倉不得少計 |
| 跨倉 A 一筆、B 兩筆，兩張完整且正確連結的 movement | 成功；公司 3、A 1、B 2，預留筆筆存在 |
| 已有五角色、五筆兩倉、零公司差額交換、釋放與原調撥測試 | 必須維持成功，且不超過 Rules 運算／文件存取上限 |
| 已有偽造角色、未登入、停用、商品／來源錯配、重送與陣列欄位驗證 | 必須維持拒絕，不產生部分寫入 |

其他攻擊面（未授權讀寫、owner 篡改、商業欄位變更、成本混入、負量／異常型別、跨倉位置偽造、孤立／重放 ledger、零量外來 ID、Rules 查詢限制）依現有 `tests/firestore-rules.test.js` 全套防護測試。這份修正**不是**對全部 Firestore Rules 的重新安全認證，也不能證明既有正式資料目前一致。

## 發布分界

必須在最新 main 上完成 Rule 語法驗證、真 Rules Emulator 負面與合法對照，以及完整 CI。此變更只會以獨立 PR 提供可審查原型；正式 Rules 發布與現存帳務盤點均另取得授權，不與舊資料清理混在一起。
