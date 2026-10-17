const {onCall,HttpsError}=require('firebase-functions/v2/https');

// Supplier email delivery was removed; retain a rejecting endpoint for old clients.
exports.sendPurchaseOrderEmail=onCall({region:'asia-east1'},()=>{
  throw new HttpsError('failed-precondition','供應商 email 功能已取消。');
});

// Staged, explicitly gated migration of two-warehouse grouped reservations.
// Default is disabled in deployed Functions until Preview integration is accepted.
const admin=require('firebase-admin');
if(!admin.apps.length)admin.initializeApp();
const {getFirestore}=require('firebase-admin/firestore');
const {commitGroupedWarehouseReservation}=require('./grouped-reservation-service');
exports.commitGroupedWarehouseReservation=onCall({region:'asia-east1'},async request=>{
  if(process.env.ENABLE_GROUPED_RESERVATION!=='true')
    throw new HttpsError('failed-precondition','跨倉後端交易尚未完成 Preview 驗收');
  if(!request.auth?.uid)throw new HttpsError('unauthenticated','請先登入');
  try{return await commitGroupedWarehouseReservation(getFirestore(),request.auth.uid,request.data);}
  catch(error){
    const allowed=['invalid-argument','permission-denied','failed-precondition','not-found','already-exists'];
    if(allowed.includes(error.code))throw new HttpsError(error.code,error.message);
    console.error('Grouped reservation transaction failed',error);
    throw new HttpsError('internal','跨倉預留交易失敗');
  }
});
