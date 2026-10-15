// Transaction service: UI must not mutate order or dispatch records directly.
async function prepareOrderDispatch(orderId,itemId) {
    let saved;
    await runRoleTransaction(async tx=>{
            const ref=db.collection('orders').doc(orderId);
            const snap=await tx.get(ref);
            if(!snap.exists)throw new Error('找不到訂單。');
            const order=snap.data();
            if(normalizedOrderStatus(order)!=='normal')throw new Error('已取消訂單不能打單。');
            const tradeValidation=globalThis.YushinOrderEntry.validateTrade(order);if(!tradeValidation.valid)throw new Error(tradeValidation.message);
            const items=normalizedOrderItems(order);
            const index=items.findIndex(item=>item.itemId===itemId);
            if(index<0)throw new Error('找不到訂單品項。');
            const item=items[index],state=itemDispatchState(order,item);
            if(state.pending<=0)throw new Error('此品項目前沒有待打單數量。');
            const now=new Date().toISOString(),actor=deliveryActor();
            items[index]={...item,dispatchPreparedQty:state.prepared+state.pending};
            const dispatchRef=db.collection('dispatchRecords').doc();
            tx.set(dispatchRef,{
                orderId,itemId,qty:state.pending,ownerUid:order.ownerUid||'',salesCode:order.salesCode||'',
                customerName:order.customerName||'',itemCode:item.itemCode||'',itemName:item.itemName||'',
                preparedByUid:currentUser?.uid||'',preparedBy:actor,createdAt:now
            });
            const nextOrder={...order,items,updatedAt:now};
            tx.update(ref,{items,...orderWorkIndexFields(nextOrder),updatedAt:now});
            saved=nextOrder;
    });
    return saved;
}
