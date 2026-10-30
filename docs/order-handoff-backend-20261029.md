# 單倉訂單業務交接後端候選

相依 #370，關聯 #291。原訂單調撥Service加入HANDOFF獨立動作與handoffOrderTransfer Callable，須ENABLE_ORDER_TRANSFER_HANDOFF_EMULATOR，既有DISPATCH／RECEIVE旗標不構成交接授權。仍demo-only預設關閉，無Preview或正式啟用。

重用原身分／來源／全數預留打單／批次／不可變快照及固定ID。只允許legacy單倉、無客戶履約的商品，目的地必須是目前ownerUid的custody位置；既有custody須啟用且owner一致，否則拒絕。不存在時沿原模型建立。PICKUP限來源主倉，SALES_SHIP須有效收件設定；v2 custody尚未納入位置模型，明確拒絕。

Warehouse Logistics新增planTransferHandoff，以原dispatch與receipt規劃組合計算同筆原子交接，不建另一套庫存演算法。原子扣來源實貨／reserved、加負責業務custody實貨／reserved，原預留位置與item.custodyTransferId一併移動；公司onHand／reserved／途中總量不變，客戶deliveryRecords不動。使用HANDOFF／RECEIVED單據與同一快照冪等；不能再以收貨入口處理交接。

本機Node2098/2098、定向22項、build一致性／語法／diff通過，涵蓋重試、錯誤owner、v2、停旗標、目的批次碰撞與晚期失敗原子性。新增真Auth Callable案例至既有runner，僅臨時demo旗標啟用；本機缺runtime，真Emulator新案例／Chrome／Preview／集中人工驗收未執行，待CI。#369 CI40850466512、#370 CI40851036269完整success，原站既有調撥及v2案例成功，不替代本批交接驗證。

原交接UI仍未接線，受控模式仍拒絕handoff。此批不部署、不開正式旗標、不合併main、不改Rules或正式資料，也不宣稱v2 custody或分散多倉完成。下一步原交接意圖保存／原ID恢復與真UI測試，再處理其餘缺口；最後集中人工驗收。
