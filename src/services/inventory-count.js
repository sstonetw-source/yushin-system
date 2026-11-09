// An uncertain count must retain its operation ID; no browser transaction is
// allowed to adjust the inventory or stock ledger.
async function commitInventoryQuantity(input,{actorUid=currentUser?.uid,actorRole=currentUserRole,onStockCommitted=null}={}){
 const {item={},warehouseId,target,note,operationId}=input||{};
 const productKey=String(item.productKey||item.productId||'').trim();
 return commitManualStockBackend('INVENTORY_COUNT',{operationId,productKey,warehouseId,target,note},
  {actorUid,actorRole,onStockCommitted});
}
