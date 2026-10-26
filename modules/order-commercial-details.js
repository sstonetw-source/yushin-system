(function(root){
    function itemMoved(item={}){
        return !!item.transferPendingId||!!item.custodyTransferId||String(item.warehouseId||'').startsWith('custody-')
            ||Number(item.warehouseShippedQty||0)>0||Number(item.deliveredQty||0)>0;
    }
    function beforeReceipt(order={}){
        const items=Array.isArray(order.items)?order.items:[];
        return !order.isBilled&&!order.isArrived&&!order.isDelivered&&Number(order.receivedQty||0)===0&&Number(order.deliveredQty||0)===0
            &&!(order.receiptEvents||[]).length&&!(order.deliveryRecords||[]).length
            &&!items.some(item=>Number(item.receivedQty||0)>0||(item.receiptEvents||[]).length||Number(item.warehouseShippedQty||0)>0||Number(item.deliveredQty||0)>0);
    }
    function canEdit(order={}){
        return canEditPage('orders.list')&&beforeReceipt(order)&&!['cancelled','voided'].includes(order.orderStatus)&&!['cancelled','voided'].includes(order.status)
            &&(currentUserRole==='admin'||(['sales','engineer'].includes(currentUserRole)&&order.ownerUid===currentUser?.uid));
    }
    function procurementLabel(item={}){
        return item.procurementType==='SALES_SELF_ORDER'
            ? `業務自行訂貨（${item.selfOrderConfirmed===true?'已向供應商下訂':'尚未下訂'}）`:'採購統一訂貨';
    }
    function amountLines(items=[]){
        return items.map(item=>{const unit=Number(item.unitPrice||0),qty=Number(item.orderedQty||item.qty||0);return {name:item.itemName||item.itemCode||'品項',unit,qty,total:Math.round((unit*qty+Number.EPSILON)*100)/100};});
    }
    root.YushinOrderCommercialDetails={beforeReceipt,itemMoved,canEdit,procurementLabel,amountLines};
    if(typeof module==='object'&&module.exports)module.exports=root.YushinOrderCommercialDetails;
})(typeof globalThis!=='undefined'?globalThis:this);
