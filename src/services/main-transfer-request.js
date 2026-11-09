// Main-warehouse requests reserve real stock exclusively in the trusted Callable.
// The browser never writes stockTransferRequests, warehouseStocks or inventory.
async function createMainTransferRequest({id,inventoryId,fromWarehouseId,qty}) {
    if(typeof commitMainTransferRequestBackend!=='function')
        throw Error('主倉調回後端尚未載入，禁止使用舊庫存寫入。');
    return commitMainTransferRequestBackend(id,'CREATE',{
        id,inventoryId,fromWarehouseId,toWarehouseId:defaultWarehouse()?.id||'',qty
    });
}

async function cancelMainTransferRequestRecord(id) {
    if(typeof pendingMainTransferDispatch==='function'&&pendingMainTransferDispatch(id))
        throw Error('原實貨寄出結果未確認，請先確認原寄出操作再處理需求。');
    if(typeof commitMainTransferRequestBackend!=='function')
        throw Error('主倉調回後端尚未載入，禁止使用舊庫存寫入。');
    return commitMainTransferRequestBackend(id,'CANCEL',{id});
}
