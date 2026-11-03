# 打單／出貨正式切換準備

本批不啟用正式功能、不部署 Functions、不改 Rules 或資料。
沿用唯一 `prepareV2OrderDispatch`（打單）與 `shipV2WarehouseItem`（實際出貨扣庫）；
保留兩種商業動作、既有角色、庫存／批次來源與原子交易檢查。

後端分別需要 `ENABLE_PRODUCTION_DISPATCH_BACKEND=true`、
`ENABLE_PRODUCTION_SHIPMENT_BACKEND=true`，未設定或其他值一律關閉。
只允許 yu-shing-company；各專案環境識別須一致，禁止任何 Emulator 端點。

網站分別需要 `YUSHIN_PRODUCTION_DISPATCH_BACKEND`／`...SHIPMENT_BACKEND`
及對應 `...LEGACY_BLOCKED` 同時為 true。本批四個設定均明確為 false。
網站只允許 https://sstonetw-source.github.io/yushin-system/。
Auth、Functions、Firestore 必須同專案，並核對原登入帳號／角色。

發生回覆遺失或關閉後端時保留原操作 ID。退役鎖啟用後須永久保留，
停用 BACKEND 只能中止交易，不能回復舊 client writer。

## 尚不可單獨啟用

須待新資料契約完成合併、其他生命週期正式路由、舊瀏覽器的 Rules 防護、
資料重置及期初庫存範圍準備完成，再集中取得正式授權。
主交易原有品項／倉庫／配送模式邊界並未由這批擴充；不宣告整體上線。
