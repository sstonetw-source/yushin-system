/* Keep the existing delivery protocol; present business choices in the entry form. */
(function(root){
    if(!root.document)return;
    const $=id=>document.getElementById(id);
    root.refreshOrderEntrySummary=function(){
        const summary=$('orderEntryProductSummary');
        if(summary)summary.textContent=[$('orderItemName')?.value||$('orderItemNameEn')?.value,$('orderSpec')?.value].filter(Boolean).join('｜');
        const p=root.orderShippingInstructions?.()||{};
        const direct=$('orderFulfillmentType')?.value==='DIRECT_SHIP';
        const choice=$('orderDeliveryChoice');
        if(choice)choice.value=direct?'DIRECT':p.mode==='CUSTOMER_SHIP'?'CUSTOMER':'BUSINESS';
        const recipient=[$('orderShippingContact')?.value,$('orderShippingPhone')?.value,$('orderShippingAddress')?.value].filter(Boolean).join('｜');
        const delivery=$('orderEntryDeliverySummary');
        if(delivery)delivery.textContent=root.YushinOrderEntry.deliveryLabel({fulfillmentType:direct?'DIRECT_SHIP':'WAREHOUSE',deliveryPlan:p})+(p.mode==='PICKUP'?'':recipient?'｜'+recipient:'｜請補齊收件資訊');
        const mode=$('orderShippingMode');
        if(mode){
            const label=mode.closest('label');if(label)label.classList.toggle('order-entry-legacy-mode',direct||p.mode==='CUSTOMER_SHIP');
            if(!direct&&p.mode!=='CUSTOMER_SHIP'){
                for(const option of mode.options)option.hidden=!['PICKUP','SALES_SHIP'].includes(option.value);
                if(label?.firstChild)label.firstChild.textContent='領貨方式';
            }
        }
    };
    function businessDefault(){
        const uid=currentUserRole==='purchaser'?$('orderOwnerUid')?.value:currentUser?.uid;
        const person=salesList.find(x=>x.uid===uid);
        if(!person&&currentUserRole==='purchaser')return {};
        return root.YushinDeliverySettings.salespersonPlan(person,defaultWarehouse()?.id||'');
    }
    root.onOrderDeliveryChoiceChange=function(){
        const choice=$('orderDeliveryChoice')?.value||'BUSINESS';
        const before=root.orderShippingInstructions?.()||{};
        $('orderFulfillmentType').value=choice==='DIRECT'?'DIRECT_SHIP':'WAREHOUSE';
        if(choice==='BUSINESS')root.setOrderShippingInstructions(businessDefault());
        else {
            root.setOrderShippingInstructions(before.mode==='CUSTOMER_SHIP'?before:{mode:'CUSTOMER_SHIP',notes:before.notes||''});
            if(before.mode!=='CUSTOMER_SHIP')root.loadOrderCustomerAddresses?.();
        }
        root.onOrderFulfillmentChange();
        root.refreshOrderEntrySummary();
        const details=$('orderRecipientDetails');if(details)details.open=choice!=='BUSINESS'&&!['contact','phone','address'].every(key=>String((root.orderShippingInstructions?.()||{})[key]||'').trim());
    };
    root.defaultOrderEntrySelfOrderStatus=()=>['sales','engineer','admin'].includes(currentUserRole)?'confirmed':'pending';
    root.syncOrderEntrySelfStatus=function(){
        const self=$('orderProcurementType')?.value==='SALES_SELF_ORDER';
        if($('orderSelfStatusWrap'))$('orderSelfStatusWrap').hidden=!self;
        const confirmed=$('orderSelfOrderConfirmed');
        if(confirmed){confirmed.disabled=currentUserRole==='purchaser';if(confirmed.disabled)confirmed.value='pending';}
        root.YushinOrderSelfRequired?.sync();
        root.refreshOrderEntrySummary();
    };
    const previousProcurement=root.onOrderProcurementTypeChange;
    root.onOrderProcurementTypeChange=function(...args){
        const result=previousProcurement.apply(this,args);
        if(args[0]===true&&$('orderProcurementType')?.value==='SALES_SELF_ORDER'&&$('orderSelfOrderConfirmed'))
            $('orderSelfOrderConfirmed').value=root.defaultOrderEntrySelfOrderStatus();
        root.syncOrderEntrySelfStatus();return result;
    };
    const previousShipping=root.setOrderShippingInstructions;
    root.setOrderShippingInstructions=function(value={}){
        if($('orderFulfillmentType')?.value==='DIRECT_SHIP'&&value.mode!=='CUSTOMER_SHIP')value={mode:'CUSTOMER_SHIP',notes:value.notes||''};
        const result=previousShipping(value);root.refreshOrderEntrySummary();return result;
    };
    const previousDefaults=root.initializeOrderDeliveryDefaults;
    root.initializeOrderDeliveryDefaults=function(...args){const result=previousDefaults.apply(this,args);root.refreshOrderEntrySummary();return result;};
    const previousChoice=root.orderDeliveryChoiceChanged;
    root.orderDeliveryChoiceChanged=function(...args){const result=previousChoice.apply(this,args);root.refreshOrderEntrySummary();return result;};
    const previousAddressLoad=root.loadOrderCustomerAddresses;
    root.loadOrderCustomerAddresses=async function(...args){try{return await previousAddressLoad.apply(this,args);}finally{root.refreshOrderEntrySummary();}};
    const previousTyping=root.orderDeliveryCustomerTyping;
    root.orderDeliveryCustomerTyping=function(...args){const result=previousTyping.apply(this,args);root.refreshOrderEntrySummary();return result;};
    const previousAddressSelect=root.selectOrderCustomerAddress;
    root.selectOrderCustomerAddress=function(...args){const result=previousAddressSelect.apply(this,args);root.refreshOrderEntrySummary();return result;};
    $('orderShippingFields')?.addEventListener('input',root.refreshOrderEntrySummary);
    $('orderShippingFields')?.addEventListener('change',root.refreshOrderEntrySummary);
    root.refreshOrderEntrySummary();
})(typeof globalThis!=='undefined'?globalThis:this);
