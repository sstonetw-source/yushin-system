// Shared order billing service. UI is responsible for feedback, not Firestore writes.
async function setOrderBillingStatus(orderId,newValue,billingDate,logEntry,timestamp) {
    if(typeof newValue!=='boolean')throw new Error('核銷狀態必須明確指定。');
    if(newValue&&!isValidOrderBillingDate(billingDate))throw new Error('請選擇正確的核銷日期。');
    return runRoleTransaction(async transaction=>{
        const ref=db.collection('orders').doc(orderId);
        const snapshot=await transaction.get(ref);
        if(!snapshot.exists)throw new Error('找不到這筆訂單。');
        const order=snapshot.data();
        if((order.items||[]).some(item=>String(item?.productType||'').trim().toUpperCase()==='SERVICE'))
            throw new Error('服務訂單須由後端核對完工憑證後核銷；目前原核銷入口尚未開放。');
        if(normalizedOrderStatus(order)!=='normal')throw new Error('這筆訂單已取消。');
        if(!!order.isBilled===newValue)return {
            isBilled:newValue,billingDate:order.billingDate||'',
            status:order.status||BUSINESS_STATUS.ACTIVE,
            statusHistory:[...(order.statusHistory||[])]
        };
        const updates={
            isBilled:newValue,
            billingDate:newValue?billingDate:'',
            status:BUSINESS_STATUS.ACTIVE,updatedAt:timestamp,
            statusHistory:firebase.firestore.FieldValue.arrayUnion(logEntry)
        };
        Object.assign(updates,orderWorkIndexFields({...order,...updates}));
        transaction.update(ref,updates);
        return {isBilled:newValue,billingDate:updates.billingDate,
            status:BUSINESS_STATUS.ACTIVE,
            statusHistory:[...(order.statusHistory||[]),logEntry]};
    });
}

function isValidOrderBillingDate(value) {
    if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
    const [year,month,day]=value.split('-').map(Number);
    const date=new Date(Date.UTC(year,month-1,day));
    return date.getUTCFullYear()===year&&date.getUTCMonth()===month-1&&date.getUTCDate()===day;
}

async function changeOrderBillingDate(orderId,value,history) {
    if(!isValidOrderBillingDate(value))throw new Error('請選擇正確的核銷日期。');
    return runRoleTransaction(async transaction=>{
        const ref=db.collection('orders').doc(orderId);
        const snapshot=await transaction.get(ref);
        if(!snapshot.exists)throw new Error('找不到這筆訂單。');
        const order=snapshot.data();
        if(normalizedOrderStatus(order)!=='normal'||order.isBilled!==true)
            throw new Error('這筆訂單已取消或尚未核銷，不能更改核銷日期。');
        if(String(order.billingDate||'')===value)return {
            billingDate:value,fieldEditHistory:[...(order.fieldEditHistory||[])]};
        const entry={...history,before:String(order.billingDate||history.before||'')};
        transaction.update(ref,{
            billingDate:value,updatedAt:entry.at,
            fieldEditHistory:firebase.firestore.FieldValue.arrayUnion(entry)
        });
        return {billingDate:value,fieldEditHistory:[...(order.fieldEditHistory||[]),entry]};
    });
}

