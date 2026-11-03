# 取消／恢復正式路由準備

只補正式路由，不部署或啟用，不改商業規則、角色、Rules、索引或正式資料。
沿用 setV2OrderLifecycle 及 commitOrderLocationLifecycleAndRecover，未新增庫存 writer。

後端使用獨立 ENABLE_PRODUCTION_ORDER_LIFECYCLE_BACKEND=true，僅允許
一致的 yu-shing-company 專案識別且不能包含 Emulator 設定。
前端需要 YUSHIN_PRODUCTION_ORDER_LIFECYCLE_BACKEND 與
YUSHIN_PRODUCTION_ORDER_LIFECYCLE_LEGACY_BLOCKED 同時 true；本批均 false。
只允許正式 HTTPS GitHub Pages origin 與 /yushin-system 路徑。

取消僅釋放未履約預留，不撤銷供應商採購；恢復沿用既有庫存及來源驗證。
保留原操作 ID、完整候選倉、品項、狀態、日期與原因。
後端關閉、回覆遺失、重整或專案／帳號變動時不得改走舊前端交易。
退役鎖一旦正式啟用必須保留，停用後端只能停止新作業。

目前仍沿用原 1–5 品項、1–2 候選實體倉及服務品項契約。
直送、更多品項、V3 保管模式不得因路由存在即宣稱已正式開放。
須連同收貨、打單、出貨、送達及退貨路由、舊瀏覽器 Rules 防護、
資料重置與實際期初庫存完成準備後，集中取得正式發布授權。
