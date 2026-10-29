# 主倉分配原來源續傳入口

相依 #357，關聯 #291。#357 完整 CI 40835993244 已 success，包含真 Firestore 的主倉實貨與並行分配測試；不代表真 Preview 或正式啟用。

新增獨立 `resumeV2MainTransferAllocation` Callable，只接受原 transferId，固定轉為 `<transferId>-in` 來源、每次最多五步，沿用既有穩定 run ID。不得由前端指定分配數量、operationId 或步數，不建立第二個 checkpoint。分配進度維持原 coordinator 的 active／completed 與 recoveryPending，實貨收貨與分配為獨立操作。

入口先查環境旗標與登入，再核對資料庫專案；共用核心每步重新驗證最新角色、來源憑證與 checkpoint。將來源 adapter 與 Callable 的 Emulator 邊界集中為同一個 gate，要求 demo-yushin、Functions Emulator、localhost Auth／Firestore 與專用旗標。Preview／正式專案持續拒絕，即使誤設旗標也不會開放。

本批尚未接原 UI、未將共用分配核心開放 Preview、未執行真 Auth Callable 新案例。本機覆蓋固定來源重試、未登入、未啟用、專案錯配、遠端 Emulator host、越權參數與角色拒絕；延續 #357 的實際來源及原子 writer 測試。集中人工驗收留到最後，沒有正式部署、旗標切換、Rules 或正式資料異動。

下一步：原 UI 的獨立分配續傳及刷新恢復；Preview 開放仍須先完成共用 coordinator 的專案權限邊界，不可由此 endpoint 直接繞過。
