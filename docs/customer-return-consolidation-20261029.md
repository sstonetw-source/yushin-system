# 退貨實收後端整合候選

關聯 #347、#291、#311。來源 main `96905aa`。依目前指示，先完成交易整合與清理，再集中完整驗收。

## 已修改

- `customer-return-callable.js` 匯出獨立的唯讀批次追溯與實收 Callable；沿用 `planLocationReturnTrace`、`commitLocationReturn`，不新增庫存計算核心。
- 預設關閉。demo 必須是本機 Auth／Firestore／Functions Emulator 且明示 `ENABLE_V2_RETURN_AUTH_EMULATOR=true`；Preview 僅允許固定 `preview-20135`、無 Emulator 混合設定且 `ENABLE_PREVIEW_CUSTOMER_RETURN=true`。每次呼叫核對實際 `db.projectId`；正式專案無啟用路徑。
- 前端以既有收貨畫面接線，Preview 另需 `YUSHIN_PREVIEW_CUSTOMER_RETURN=true` 與固定 Preview 網域；App、Auth、Functions、Firestore 同專案，使用原 UID／角色，每個非同步步驟後重新檢查。
- Preview 只允許原申請連結、可再銷售、CLOSE 結案及原出貨倉；既有服務內的 live role、來源、批次、預留、退貨餘量與原子性驗證保留，不放大品項／批次上限。
- pending checkpoint 加入 backendProject；舊未標記 checkpoint 僅視為 demo，不允許跨環境接手。旗標停用後仍可顯示未確認紀錄，使用原操作恢復；一般退貨 writer 不得接手未確認後端結果。
- 刪除隔離 adapter 的重複退貨包裝，改委託同一 Callable factory；Auth harness 改接 index 的實際匯出。保留正式仍在使用的 legacy writer。

## 必要檢查與集中驗收分界

- Node 回歸、生成檔一致性、語法與 diff 檢查依 PR 紀錄記載。
- 定向涵蓋旗標／環境／實際專案拒絕、原操作重送、遺失回覆、關旗標保留 checkpoint、跨專案 checkpoint 拒絕及 legacy 禁止接手。
- GitHub CI 自動執行既有必要套件；本批不要求使用者逐項人工驗收，不新增一輪正式或 Preview 部署。
- 真 Preview、完整生命週期集中驗收與正式角色驗收仍未執行；不能將此候選視為正式退貨已啟用或 #311 已結案。

## 其餘整合缺口

- 退貨申請／撤回目前仍有舊 client writer，須繼續統一；本批只接實收與唯讀追溯。
- 舊格式退貨、待檢／報廢、直送退貨、取消採購轉備庫與調撥仍須按現有核心逐項整理，不擅改政策或移除正式入口。
- 預留其餘 writer 尚未全面集中，Rules 原生 SDK 覆蓋缺口 #311 仍 open。

沒有部署 Firebase、啟用旗標、修改正式資料或 Rules。
