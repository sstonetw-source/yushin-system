const pendingServiceOrderActions=new Set();

function serviceOrderActionButton(order,item,action,label){
    const key=JSON.stringify([currentUser?.uid,order.id,item.itemId,action]);
    const pending=pendingServiceOrderActions.has(key);
    return `<button type="button" class="btn-small" data-service-action="${action}" onclick="confirmOrderServiceAction(${inlineJsValue(order.id)},${inlineJsValue(item.itemId)},${inlineJsValue(action)},this)" ${pending?'disabled':''}>${pending?'處理中…':label}</button>`;
}

function serviceOrderActionButtons(order,items,lifecycle){
    if(!order.serviceFulfillment||!serviceCaseClientProject()||orderInventorySyncIncomplete(order)
        ||lifecycle.status!=='normal'||!canEditPage('orders.list'))return '';
    return items.filter(YushinWorkflow.isServiceItem).map(item=>{
        const category=YushinWorkflow.serviceItemWorkCategory(order,item);
        const name=escapeHtml(item.itemName||item.itemCode||'服務品項');
        if(category==='dispatch'&&['admin','purchaser'].includes(currentUserRole))
            return serviceOrderActionButton(order,item,'PREPARE',`確認打單 · ${name}`);
        if(category==='delivery'&&canManageOrderLifecycleCapability()
            &&(currentUserRole==='admin'||order.ownerUid===currentUser?.uid))
            return serviceOrderActionButton(order,item,'DELIVER',`確認已送達 · ${name}`);
        return '';
    }).join('');
}

window.confirmOrderServiceAction=async function(orderId,itemId,action,button){
    const uid=currentUser?.uid,role=currentUserRole;
    const key=JSON.stringify([uid,orderId,itemId,action]);
    if(!uid||pendingServiceOrderActions.has(key))return;
    pendingServiceOrderActions.add(key);
    if(button)button.disabled=true;
    try{
        const transport=serviceCaseTransport();
        const reply=await transport.call('commitOrderServiceAction',{orderId,itemId,action});
        if(!['applied','already-applied'].includes(reply?.status)
            ||reply.orderId!==orderId||reply.itemId!==itemId||reply.action!==action)
            throw Error('服務操作回覆無法核對。');
        await refreshAffectedOrderCaches([orderId]);
    }catch(error){
        if(currentUser?.uid===uid&&currentUserRole===role)
            alert('服務操作結果待確認，請更新清單或重試。'+error.message);
    }finally{
        pendingServiceOrderActions.delete(key);
        if(button?.isConnected)button.disabled=false;
        if(currentUser?.uid===uid&&currentUserRole===role){
            if(document.getElementById('order-system')?.classList.contains('active'))renderOrdersList();
            if(document.getElementById('purchasing-system')?.classList.contains('active'))renderPurchasingView();
        }
    }
};
