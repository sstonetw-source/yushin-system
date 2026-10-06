const {onCall,HttpsError}=require('firebase-functions/v2/https');

// Supplier email delivery was removed; retain a rejecting endpoint for old clients.
exports.sendPurchaseOrderEmail=onCall({region:'asia-east1'},()=>{
  throw new HttpsError('failed-precondition','供應商 email 功能已取消。');
});
