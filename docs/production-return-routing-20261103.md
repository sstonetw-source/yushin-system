# 退貨正式路由準備

沿用 requestV2CustomerReturn／withdrawV2CustomerReturnRequest 與 receiveV2CustomerReturn，
不新增庫存 writer。前者屬業務申請／撤回，後者屬倉庫實收。
實收仍須連結原出貨、原批次、Movement 及原待收申請，依原 CLOSE／RESTOCKABLE 邊界執行。
未擴大補送、多次退貨、直送或 V3 保管模式。

後端需要獨立 ENABLE_PRODUCTION_CUSTOMER_RETURN_REQUEST_BACKEND=true 或
ENABLE_PRODUCTION_CUSTOMER_RETURN_BACKEND=true；只有一致的 yu-shing-company、無 Emulator 才可用。
前端相應 YUSHIN_PRODUCTION_CUSTOMER_RETURN_REQUEST_BACKEND／CUSTOMER_RETURN_BACKEND
與各自 LEGACY_BLOCKED 皆須 true，並限定正式 HTTPS GitHub Pages 專案路徑。
本批全部 false，沒有部署、資料異動、Rules／Index 發布或正式切換。

固定原操作與完整批次意圖，在回覆遺失、重整、旗標停用及專案／角色變動時保留。
退役鎖啟用後禁止舊申請 writer 或一般退貨入庫接手，停用後端只能停止相關操作。
實收成功依原憑證及訂單回讀核對後才移除暫存。

與其他核心路由、舊瀏覽器保護、資料重置及期初庫存集中審核授權後才可正式發布。

## 舊瀏覽器資料庫退役鎖候選

`settings/returnCutover.backendOnly=true` 同時退役舊退貨申請／撤回、實收、
更正及待檢轉庫存。未建立設定或 false 時維持原權限；設 true 後 Client SDK
（包括管理員）不能更動訂單 returnRequests／returnPending／returnRequestMutationIndex／
returnRecords／returnedQty／returnReceiptId，也不能建立、更新或刪除 customerReturnReceipts。
新訂單允許空退貨狀態，不能夾帶退貨事實；既有唯讀權限不變。

設定為單向：瀏覽器不能關閉、移除 backendOnly、換成其他型別或刪除 gate。
可信 Functions Admin SDK 沿原唯一退貨核心與最新角色查核繼續寫入。
舊實收與待檢轉庫存交易在訂單／憑證遭拒時整筆回滾，不會只入庫或只完成申請。
本鎖不代表待檢轉庫存已獲新後端支援；未支援功能維持停用，由管理員處理例外。

只在退貨欄位變更、帶退貨事實的新建與退貨憑證寫入時讀 gate，
不新增 Collection 類型、Query、Index、Listener 或庫存計算核心。
必須另行授權發布 Rules、部署相容後端、啟用路由及真角色驗收；
故障保留退役鎖與原操作 ID，不回退舊 writer。
