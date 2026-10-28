# 整單雙倉初始化 6–15 品項（2026-10-27）

依 #308／#291 接續收貨前置。收貨已支援 15 品項，但原子整單初始預留仍限制 5；本批讓原 `commitOrderTwoWarehouse` 接受 1–15 個唯一來源品項，不新增 writer 或數量公式。

沿用原來源順序逐列共享 companyStates／warehouseStates，後一列只能使用前一列配置後的餘額；完整查核全部品項後才寫入。原角色／負責人、同步 attempt、收貨／物流尚未開始、兩個候選倉、主檔／庫存／既有預留憑證檢查保留。Service 行保持不參與物理庫存，直送仍不在這個實體雙倉初始化契約內。

成功只更新原預留 ledger、公司／分倉預留、來源品項的預留／缺口與既有 operation receipt／預留 audit，不增減實貨，也不把採購在途當可用庫存。來源初始化完成與需求發布仍由原 coordinator 管理，不能把預留提交當成所有建單後續已完成。

## 固定驗收

- 6／15 同商品多列共享 7 件實貨，只能依原來源順序占用 3、3、1，其餘為缺口；不受 caller itemIds 的順序影響。
- 同 ID 競爭與回覆遺失後重送，僅一張 operation receipt，不重複占用。
- 15 個不同商品、每個均跨兩倉配置，量測真實每次 transaction attempt 的 reads／writes；另驗證 14 商品＋1 Service 無服務 ledger／實貨異動。
- 第 15 列失效、漏列／重複／第 16 列、既有預留合計超過原公司／分倉帳，整筆拒絕且所有文件不變。
- 兩張 15 品項單同時競爭 7 件庫存，合計預留不能超過 7；五角色沿原即時角色／負責人限制，停用或業務改派後不能重播結果。

本機一般 Node 1,905 項通過；Firestore Emulator 整個整單預留檔案 25/25 通過。15 個不同商品雙倉實測 80 次讀取／92 次寫入；14 商品加 1 Service 為 77／86，均在本次固定驗收的各 100 次上限內。最新完整 CI 以 PR 記錄為準。未執行正式或 Preview 實測。

## 上線界線

仍只允許 demo-yushin Firestore Emulator 的內部 writer，不新增正式 Callable、不啟用 Preview／正式旗標。未放寬 grouped-reservation、採購、出貨、送達、取消或退貨入口。

無新 Query／Listener／Collection／Rules／Index 或 PDF／CSS 變更，無部署／正式資料操作。正式角色操作不變；原頁面完整 15 品項流程須在各入口補齊後驗收。
