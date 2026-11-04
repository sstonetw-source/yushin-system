# 正式 PO 在途銜接修正

正式 PO 確認後仍呼叫舊 Client 在途 writer，與已啟用的 purchasingCutover.backendOnly 衝突。
原 PO 交易只建立供應承諾，incomingRegisteredQty 為 0，因此不能略過在途登記或宣稱已完整採購。

修正使用現有 commitV2FormalPurchase Callable 的獨立 action=register-incoming，僅接受原 poNo。
沿既有 registerFormalPurchaseIncoming 權威核心及原 po-incoming 憑證，一筆原子交易處理整張 PO，
不新增函式、不放寬 Rules、不把確認採購與登記在途混成同一商業動作。
正式 gate、實際資料庫專案、最新 users 角色與供應來源仍由後端核對。
原 demo-only registerV2FormalPurchaseIncoming 端點不新增正式啟用路徑。

## 驗證與發布順序

定向驗證涵蓋正式入口、公司及雙倉在途、重送、回覆遺失、越權、錯專案、額外欄位及最後來源失敗零寫入。
必要 CI 通過後，先限定更新 yu-shing-company 的 commitV2FormalPurchase，再發布前端資產。
其他 18 個已部署函式、Rules、Indexes、角色及資料重置不在本修正範圍。
如果後端尚未更新，新前端會保留原 PO checkpoint 並失敗中止，不回退舊 writer。

本修正不代表已完成正式角色驗收或實際期初盤點。
