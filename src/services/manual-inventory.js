// The browser only submits intent; stock and lot ledger mutations belong to
// commitV2ManualInventory on the trusted Admin SDK backend.
async function commitManualInventoryAdjustment(input,{actorUid=currentUser?.uid,actorRole=currentUserRole,onStockCommitted=null}={}){
 const {type,productKey,warehouseId,operationId,row={}}=input||{};
 const payload={type,productKey,warehouseId,operationId,qty:row.qty,
  lotNo:String(row.lotNo||'').trim(),expiryDate:String(row.expiryDate||'').trim()};
 if(type==='initial'&&['admin','purchaser'].includes(actorRole)){
  if(String(row.unitCost??'').trim()==='')throw Error('期初庫存必須填寫實際單位成本。');
  payload.unitCost=Number(row.unitCost);
 }
 return commitManualStockBackend('MANUAL_INVENTORY',payload,{actorUid,actorRole,onStockCommitted});
}
