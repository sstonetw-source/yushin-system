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
