# 同產品跨倉多品項的預留交易證明

## 2026-10-25 整合修正

本批處理同產品最多五筆、各自單倉的預留；驗收上限為兩個倉庫。不啟用單品項多位置 ledger，不新增 Collection、Query、Listener、Index 或第二份數量帳。

沿用 StockPermissions.run、reservationStockDeltas、既有 inventoryReservations／inventoryMovements／inventory／warehouseStocks。每筆預留仍驗證來源訂單、品項、產品、商務數量、歸屬及目前角色；變動預留須連結同筆交易新建立的 movement，完整比對憑證。公司及分倉差額均從交易前後的預留數量核對，跨倉合併不得搬動原正量位置。業務／工程師原 stockOperations 與專用單筆調撥路徑保持相同。

### 修正內容

- 證明清單只包含本次數量或倉位實際改變的預留；同產品未異動兄弟列保留為交易讀取，不重複參與差額查核。
- 首筆公司憑證選自實際變動的倉庫；每倉分別使用自身代表列及 movement。
- 跨倉群組轉為僅單倉異動時，明確寫入 crossWarehouse:false、空 companyMovementId 及空 warehouseReservationIds，避免 merge:true 留下上一筆巢狀 map 的舊憑證欄位。
- 僅省略完全相同的單筆 flat primitive merged reservation patch；多筆覆寫、物件、欄位轉換及實際中繼資料異動均維持原寫入。未知回覆、原子性與讀取衝突檢查不變。
- Rules 重用一次 nullable get 的舊文件快照，省去重複 exists/get；依實際清單長度合計差額，並重用數量及角色值。保留完整來源、型別、數量、公司／分倉、不可變來源與新憑證檢查，不新增角色權限。
- 後端 stock-permissions 副本由既有建置工具產生；更新前端模組快取版本。

### 驗收與限制

本機 Node 1,865/1,865、完整 Rules Emulator 203/203（0 略過）、來源與生成副本一致性及差異檢查已通過。GitHub 最新 head 的完整 Chrome／Auth／Functions／Firestore CI 全部成功後才可合併。五筆兩倉測試包含採購／倉管的新增、部分釋放、公司零差額互換與全量釋放；原生反例包含錯帳、缺倉／movement、型別偽造、清單欺騙、第三倉偷搬、異產品及憑證重用。完整 Rules 套件配置 4 GiB Node heap，避免新增回歸在測試程序原有約 2 GiB 預算耗盡；不跳過或弱化測試。

未部署 Firebase、未修改正式資料。前端與 firestore.rules 仍需配套發布；GitHub 合併不代表正式環境已更新。多於兩倉的最大批次、單品項多位置履約與正式環境五角色實測不在本批完成範圍。歷史 ruleCoverage 工具僅供本機診斷，不作為通過驗收的證據。
