# 主倉調撥缺貨分配：共用協調器接管

相依 PR #356，關聯 Issue #291。先整合修改與清理，最後集中人工驗收。

## 本批交付

- 主倉實貨收貨的 `<transferId>-in` movement 可作為既有 `advanceReleasedV2FreeStock` 來源。以該 movement 推導固定 run ID，不新增另一套分配帳或庫存演算法。
- 每次續傳重新驗證最新角色、原子寄出／收貨憑證、原收貨意圖、入庫異動與目的倉批次。顯示用 `allocationCompleted`、`autoAllocatedQty` 不構成分配信用。
- 共用自由庫存 writer 可更新 1–15 品項來源中的一個指定品項；完整保留兄弟品項，正確記錄需求的 sourceItemIndex。每次仍只交易一個目標品項，不代表一次原子分配十五個品項。
- 刪除未接線的第二套 batch planner、候選排序包裝與對應測試，沿用既有 FIFO 與每批最多五步的續傳協調器。

## 明確界線

- 分配仍限 `demo-yushin`，須 Functions／Auth／Firestore Emulator 與獨立 `ENABLE_MAIN_TRANSFER_ALLOCATION_EMULATOR=true`。Preview／正式不支援分配，不沿用 inspection 的 Preview gate 開放寫入。
- 既有 FIFO 最多掃描 500 筆候選；本入口只接受正整數且每來源至多 1000 件。超限保留原收貨事實，拒絕分配，不能重建收貨。
- 既有無採購、無履約事件與原候選實體倉限制保留；有供應承諾或履約紀錄的目標會停止並保留原 checkpoint，不宣稱已完成全類型缺貨分配。
- 未改前端收貨成功語意、未宣告 stockTransfers 顯示旗標為權威完成、未接正式 UI、未部署、未切換旗標、未改 Rules／正式資料。

## 驗證

- 定向 Node：原寄出→收貨→既有協調器→多品項預留／需求；原 movement 重播、顯示旗標偽造、憑證／批次竄改、停用角色／旗標、晚期交易中斷及原 pending 命令續傳。
- 另覆蓋十五品項指定更新、十六品項／重複 itemId 拒絕。
- 新增 `tests/emulator-main-transfer-allocation.cjs` 至 stock CI：真 Firestore 寄出／收貨，並行相同來源分配、兄弟品項保留、重播不重複預留。尚待遠端 CI 執行結果，本機無 Emulator runtime，不寫為已通過。

下一階段：共用協調器的 Preview 權限／環境邊界與原 UI 恢復入口，然後訂單調撥／交接及剩餘舊 writer。不要另建平行的分配核心。
