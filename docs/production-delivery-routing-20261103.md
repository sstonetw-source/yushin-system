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

## 舊瀏覽器資料庫防護候選

`settings/deliveryCutover.backendOnly=true` 是單向退役鎖，預設不存在或 false 時不切換。
啟用後所有 Client SDK（包含管理員）不能更動訂單的 deliveryRecords、deliveredQty、
isDelivered，也不能建立／刪除 deliveries 憑證；現有讀取不變，Functions Admin SDK 不受影響。
新建訂單仍可使用空送達紀錄／零數量，不能夾帶既有送達事實繞過鎖。
管理員瀏覽器不能將 true 改為 false、移除欄位或改為字串，不能刪除設定文件。

這個鎖必須隨整體履約切換啟用：舊實際出貨與直送收貨也會更動上述送達欄位，
因此不能在這些流程仍依賴 Client SDK 時單獨啟用。它不改寫庫存計算；
只要舊交易嘗試更新訂單送達事實，整筆原子交易（含庫存／批次／預留）均拒絕。
故障時維持鎖定，以原操作 ID 核對後端憑證，不恢復舊 writer。

必要驗證涵蓋未啟用前合法送達／庫存交易、啟用後原子撤銷拒絕與零部分寫入、
五角色舊訂單更新及憑證寫入拒絕、不可逆設定、一般備註更新及可信後端寫入。
Rules 修改不增加查詢、Index、Listener；只有送達事實修改／帶送達事實的建立
與 deliveries 寫入才查切換設定。這是尚待正式發布審核的規則候選，
Emulator／CI 通過不能代替正式角色驗收。
