# 主倉備貨調撥需求：後端準備

接續 #351；先整合修改，最後集中人工驗收。

新增獨立關閉的 createV2MainTransferRequest／cancelV2MainTransferRequest，重用既有 Reservation Core 的 planMainTransferHold，不建立第二個庫存計算核心。建立只增加公司與來源分倉的 reserved／transferReserved；取消釋放相同數量。實貨、批次、寄出與收貨均不屬本交易。

後端核對最新 admin／purchaser、實際專案、來源實體倉與具有 isDefault 的目的主倉、庫存身分／數量、公司彙總支持來源分倉。保留原核心有限小數語意，數量不得為字串或非有限值。建立與取消各以固定操作與原角色／意圖 hash 重送，衝突不覆寫；已寄出不得取消。依原流程，來源倉停用後仍可釋放有效未寄出的需求。

旗標為 ENABLE_PREVIEW_MAIN_TRANSFER_REQUEST／ENABLE_MAIN_TRANSFER_REQUEST_EMULATOR，預設關閉，正式專案無啟用路徑。候選在原 stockTransferRequests 補充操作 metadata，不新增集合或執行正式遷移。

本批僅完成後端準備，前端 createMainTransferRequest／cancelMainTransferRequestRecord 尚未接線，仍使用原 writer。下一步須接固定意圖保存、刷新／回覆遺失恢復及禁止 fallback；正式舊入口不得提前刪除。其餘調撥寄出／收貨、訂單調撥與交接仍待整理。

本機定向涵蓋公司／分倉只預留一次、原數釋放、實貨不動、異意圖與角色拒絕、來源失效與失敗無部分寫入。真 Emulator／Chrome／Preview及集中人工驗收尚未執行；必要 CI 由 PR 自動執行。沒有部署、旗標啟用、Rules或正式資料異動。
