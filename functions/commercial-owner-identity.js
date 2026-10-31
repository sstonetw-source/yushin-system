'use strict';

// Sales/engineer records retain their existing salesperson code requirement.
// A code-free administrator-owned record is identified by its live owner profile,
// never by creator metadata supplied with the commercial document.
async function hasCommercialOwnerIdentity(tx,db,uid,actor,order){
  if(!order.ownerUid)return false;
  if(order.salesCode)return true;
  if(order.salesCode!==''||typeof order.ownerUid!=='string'||order.ownerUid.includes('/'))return false;
  let owner=actor;
  if(order.ownerUid!==uid){
    const snapshot=await tx.get(db.collection('users').doc(order.ownerUid));
    if(!snapshot.exists)return false;
    owner=snapshot.data();
  }
  return owner?.role==='admin'&&owner.active!==false&&owner.disabled!==true;
}
module.exports={hasCommercialOwnerIdentity};
