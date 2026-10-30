# 訂單調撥後端寄出／收貨候選

相依 #365，關聯 #291。新增獨立DISPATCH／RECEIVE預設關閉demo Emulator Callable。只接受有效物流角色、已完成初始化、1–15品項中的指定實體商品、全數到貨預留並打單、尚無客戶履約事件的單倉訂單。多倉／custody／handoff／直送／服務與既有出貨送達退貨明確拒絕，不放寬其語意。

寄出依原訂單／品項／預留與已存交付設定，原子提交來源實貨及批次扣除、保留庫存的調撥途中量、訂單pending及後端獨有寄出快照。收貨另用原operationId核對快照、寄出movement、來源批次成本參照與目前pending，原子建立目的倉批次及成本參照、入庫／預留移倉、清除pending及收貨憑證。公司onHand與reserved不因倉間移動改變，客戶deliveryRecords不動。重用既有Reservation／Warehouse Logistics／Inventory核心，最多100來源批次，無不明批次補造。

原操作重播核對最新角色與後端快照；相同ID不同意圖或角色拒絕。舊client writer拒絕接手帶orderTransferIntentHash的單據，不能fallback。原UI尚未接線，固定意圖持久化及刷新恢復仍待下一批；本批不能宣稱已正式使用。

本機Node2089/2089，build一致性／語法／diff通過。主倉與訂單後端定向17項通過，新增原子寄出→收貨、重試不重複庫存、公司總量與保留守恆、無客戶送達、角色／v2／未打單拒絕、晚期失敗與原批次追溯失配。交易測試使用模擬DB；真Auth／Functions／Firestore Emulator新端點、Chrome／Preview與集中人工驗收未執行，不以模擬測試代替。

保持Draft，不合併main、不部署、不開旗標、不改Rules或正式資料。下一步補真Emulator交易覆蓋及原UI固定意圖／回覆遺失／刷新恢復，再處理多倉及業務保管交接；最後集中驗收，整體#291未完成。
