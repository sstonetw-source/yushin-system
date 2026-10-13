(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.YushinOrderEntry=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
    const text=value=>String(value??'').trim();
    function validateItem(item={}) {
        if (!text(item.itemName)) return {valid:false,field:'orderItemName',message:'請輸入品名。'};
        if (!Number.isFinite(Number(item.qty)) || Number(item.qty)<=0) return {valid:false,field:'orderQty',message:'請輸入大於 0 的數量。'};
        if (item.unitPrice===null || item.unitPrice===undefined || text(item.unitPrice)==='' || !Number.isFinite(Number(item.unitPrice)) || Number(item.unitPrice)<0)
            return {valid:false,field:'orderUnitPrice',message:'請確認含稅售價；免費品請明確填 0。'};
        if (item.procurementType==='SALES_SELF_ORDER' && item.selfOrderConfirmed===true) {
            if (!text(item.supplier)) return {valid:false,field:'orderSelfSupplier',message:'確認已下訂前，請填寫供應商。'};
            if (item.costPrice===null || item.costPrice===undefined || text(item.costPrice)==='' || !Number.isFinite(Number(item.costPrice)) || Number(item.costPrice)<0)
                return {valid:false,field:'orderCostPrice',message:'確認已下訂前，請填寫含稅單位成本（可填 0）。'};
        }
        if (item.costPrice!==undefined && item.costPrice!==null && (!Number.isFinite(Number(item.costPrice)) || Number(item.costPrice)<0))
            return {valid:false,field:'orderCostPrice',message:'成本請留白，或填寫大於等於 0 的數字。'};
        return {valid:true};
    }
    function deliveryLabel(item={},fallback={}) {
        if(item.fulfillmentType==='DIRECT_SHIP')return '原廠直送客戶';
        const mode=(item.deliveryPlan||fallback).mode;
        return {PICKUP:'我送・主倉自領',SALES_SHIP:'我送・寄給負責業務',CUSTOMER_SHIP:'倉庫寄客戶'}[mode]||'待設定交付';
    }
    function sameDraftItem(a,b) {
        return a.productId===b.productId && a.unitPrice===b.unitPrice && a.procurementType===b.procurementType
            && a.fulfillmentType===b.fulfillmentType && a.supplier===b.supplier && a.costPrice===b.costPrice
            && a.selfOrderConfirmed===b.selfOrderConfirmed && JSON.stringify(a.deliveryPlan||{})===JSON.stringify(b.deliveryPlan||{});
    }
    function validateTrade(order={}) {
        if(!['直','借','扣'].includes(order.transactionType))return {valid:false,message:'請至訂單的交易資訊選擇直、借或扣，再打單／核銷。'};
        if(order.transactionType==='直'&&!text(order.invoiceTitle))return {valid:false,message:'開發票的訂單請先填寫發票抬頭，再打單／核銷。'};
        return {valid:true};
    }
    function copyItem(item={},fallback={}) {
        const draft={};
        for(const key of ['itemCode','itemName','itemNameEn','brand','brandId','productId','productMasterMatched','productCheckStatus','productLine','productType','spec','qty','unitPrice','supplier','costPrice','procurementType','fulfillmentType','warehouseId','deliveryCustomerName']) {
            if(item[key]!==undefined)draft[key]=item[key];
        }
        draft.selfOrderConfirmed=false;
        draft.deliveryPlan={...(item.deliveryPlan||fallback)};
        return draft;
    }
    return {validateItem,deliveryLabel,sameDraftItem,copyItem,validateTrade};
});
