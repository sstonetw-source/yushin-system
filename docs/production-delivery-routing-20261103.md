# 客戶送達確認／撤銷正式路由準備

沿用 confirmV2ShipmentDelivery 與 reverseV2ShipmentDelivery，各自獨立旗標及操作憑證。
不變更實際出貨、庫存、角色、Rules、索引或正式資料。

後端分別需要 ENABLE_PRODUCTION_DELIVERY_CONFIRMATION_BACKEND=true 與
ENABLE_PRODUCTION_DELIVERY_REVERSAL_BACKEND=true，預設關閉。
僅允許一致的 yu-shing-company 環境識別且禁止 Emulator。
前端各自需要 YUSHIN_PRODUCTION_DELIVERY_CONFIRMATION_BACKEND／
YUSHIN_PRODUCTION_DELIVERY_REVERSAL_BACKEND 與相應 LEGACY_BLOCKED 同時 true。
本批四個設定全部 false，只接受正式 HTTPS GitHub Pages 專案路徑與同專案 Auth／Functions／Firestore。

關閉後端仍保留退役鎖；原操作未確認時維持同一 ID，禁止改走舊 writer。
確認送達必須對應原實際出貨；撤銷送達不回補庫存，不等同退貨。
介面的撤銷按鈕同步辨識獨立正式路由，未啟用時不能直接執行舊更正交易。

未部署、未啟用；仍須連同其他交易路由、舊快取防護、資料重置、
實際期初庫存及真實角色驗收集中授權。沿用原 1–5 品項範圍，未擴大 V3 保管模式。
