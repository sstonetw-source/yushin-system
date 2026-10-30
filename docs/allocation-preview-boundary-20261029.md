# 分配協調器受控 Preview 接線

相依 #362，關聯 #291。free-stock writer、automatic coordinator及movement續傳共用新的Preview資料庫判定：只允許preview-20135、獨立ENABLE_PREVIEW_FREE_STOCK_ALLOCATION=true，而且不得含Functions／Firestore／Auth Emulator環境。主倉來源入口另須ENABLE_PREVIEW_MAIN_TRANSFER_ALLOCATION=true；Production即使複製旗標也拒絕。原Admin Emulator harness保留，初始預留及其他Emulator-only清單沒有開放。

共用旗標也涵蓋既有取消釋放、退貨及到貨movement續傳；Preview啟用時，這些post-commit recovery可實際執行，須納入真Preview整合驗收。本批未設定環境旗標。

前端重用SDK／角色／專案／Auth邊界，在明確Preview旗標與指定主機下使用真正Functions端點，不呼叫useEmulator。pending接受demo或指定Preview，跨專案不能重用；關旗標禁止fallback。

本機Node2077/2077通過，新增雙旗標／專案錯配／混用Emulator拒絕、Preview前端回覆遺失恢復及清單，以及Preview設定下原來源→協調器→完成投影→權威清單的模擬資料庫交易。不是實際Preview網路或部署驗收。本機真Emulator／Chrome／真Auth新案例／實際Preview未執行，CI另記PR。

保持Draft，未合併main、部署、開旗標、切正式入口、改Rules或正式資料。不宣稱採購403或整體#291完成。下一步確認CI與既有Preview環境，再按最後集中驗收規劃處理；其餘訂單調撥交接及舊writer仍待整理。
