const pendingServiceOrderActions=new Set();
function serviceWorkItemPending(orderId,itemId){
    return ['PREPARE','DELIVER','EXECUTE'].some(action=>uiWorkActionPending('service-work',`${orderId}::${itemId}::${action}`));
}

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
    const uiAction=beginUiWorkAction('service-work',`${orderId}::${itemId}::${action}`,
        `${action==='PREPARE'?'服務打單':action==='DELIVER'?'服務送達':'服務執行'} ${orderId}／${itemId}`,()=>{
            if(document.getElementById('order-system')?.classList.contains('active'))renderOrdersList();
            if(document.getElementById('purchasing-system')?.classList.contains('active'))renderPendingPurchaseOrders();
        });
    if(!uiAction)return;
    pendingServiceOrderActions.add(key);
    if(button)button.disabled=true;
    let confirmed=false,failure=null;
    try{
        const transport=serviceCaseTransport();
        const reply=await transport.call('commitOrderServiceAction',{orderId,itemId,action});
        if(!['applied','already-applied'].includes(reply?.status)
            ||reply.orderId!==orderId||reply.itemId!==itemId||reply.action!==action)
            throw Error('服務操作回覆無法核對。');
        confirmed=true;
        await refreshAffectedOrderCaches([orderId]);
    }catch(error){
        failure=error;
        if(currentUser?.uid===uid&&currentUserRole===role)
            alert((confirmed?'服務操作已完成，但更新畫面失敗；請重新查詢。':uiWorkResultUncertain(error)?'服務操作結果待確認，請先核對原交易，勿直接重新送出。':'服務操作失敗，原畫面已恢復。')+(error.message||error));
    }finally{
        pendingServiceOrderActions.delete(key);
        uiAction.finish(confirmed?'success':failure&&uiWorkResultUncertain(failure)?'unknown':'failure');
        if(button?.isConnected)button.disabled=false;
        if(currentUser?.uid===uid&&currentUserRole===role){
            if(document.getElementById('order-system')?.classList.contains('active'))renderOrdersList();
            if(document.getElementById('purchasing-system')?.classList.contains('active'))renderPurchasingView();
        }
    }
};
