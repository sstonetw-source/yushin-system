// A legacy estimate is metadata, not a physical shipment or stock movement.
// Re-read in the protected transaction so a stale modal cannot erase real records.
async function clearOrderLegacyDeliveryEstimate(orderId) {
    const actor=deliveryActor(),at=new Date().toISOString();
    let savedOrder;
    await runRoleTransaction(async transaction=>{
        const ref=db.collection('orders').doc(orderId);
        const snapshot=await transaction.get(ref);
        if(!snapshot.exists)throw new Error('找不到這筆訂單。');
        const order=snapshot.data();
        if(savedDeliveryRecords(order).length)
            throw new Error('這筆訂單已有實際送貨紀錄，請重新整理後逐筆更正。');
        if(returnedQuantity(order)>0)
            throw new Error('這筆訂單已有退貨紀錄，請先更正退貨紀錄。');
        if(!deliveryProgressInfo(order).isLegacyEstimated){savedOrder=order;return;}
        const history={action:'clear_legacy_estimate',
            before:{isDelivered:true,estimatedDate:order.orderDate||''},
            after:null,by:actor,at};
        const updates={isDelivered:false,deliveredQty:0,deliveryRecords:[],
            deliveryHistory:firebase.firestore.FieldValue.arrayUnion(history),updatedAt:at};
        Object.assign(updates,orderWorkIndexFields({...order,...updates}));
        transaction.update(ref,updates);
        savedOrder={...order,...updates,deliveryHistory:[...(order.deliveryHistory||[]),history]};
    });
    return savedOrder;
}
