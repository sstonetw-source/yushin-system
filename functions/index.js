const {onCall,HttpsError}=require('firebase-functions/v2/https');

// Supplier email delivery was removed; retain a rejecting endpoint for old clients.
exports.sendPurchaseOrderEmail=onCall({region:'asia-east1'},()=>{
  throw new HttpsError('failed-precondition','供應商 email 功能已取消。');
});

// Staged, explicitly gated migration of two-warehouse grouped reservations.
// Default is disabled in deployed Functions until Preview integration is accepted.
const {getApps,initializeApp}=require('firebase-admin/app');
if(!getApps().length)initializeApp();
const {getFirestore}=require('firebase-admin/firestore');
const {createPreviewFormalPurchaseCallable}=require('./formal-purchase-preview-callable');
// Production is disabled by default; only an independent explicit backend
// rollout flag may enable the already-validated strict transactional writer.
exports.commitV2FormalPurchase=createPreviewFormalPurchaseCallable({onCall,HttpsError,getDatabase:getFirestore});
const {commitGroupedWarehouseReservation}=require('./grouped-reservation-service');
const {allowGroupedReservation,allowGroupedReservationAmend,
  allowGroupedReservationSameWarehouse}=require('./grouped-reservation-gate');
exports.commitGroupedWarehouseReservation=onCall({region:'asia-east1'},async request=>{
  if(!allowGroupedReservation())
    throw new HttpsError('failed-precondition','跨倉後端交易尚未完成 Preview 驗收');
  if(!request.auth?.uid)throw new HttpsError('unauthenticated','請先登入');
  if(request.data?.mode==='amend'&&!allowGroupedReservationAmend())
    throw new HttpsError('failed-precondition','同步後跨倉預留調整尚未單獨授權啟用');
  try{return await commitGroupedWarehouseReservation(getFirestore(),request.auth.uid,request.data,{
    allowSameWarehouse:allowGroupedReservationSameWarehouse()});}
  catch(error){
    const allowed=['invalid-argument','permission-denied','failed-precondition','not-found','already-exists'];
    if(allowed.includes(error.code))throw new HttpsError(error.code,error.message);
    console.error('Grouped reservation transaction failed',error);
    throw new HttpsError('internal','跨倉預留交易失敗');
  }
});

const {createOrderReservationCallable}=require('./order-reservation-callable');
exports.commitOrderReservationPreview=createOrderReservationCallable({onCall,HttpsError,getDatabase:getFirestore});

 
// Safe transport-only trial. This callable cannot be enabled outside the
// isolated demo Auth + Firestore Emulator, even by environment flag alone.
// Service writer does not touch stock, delivery, purchase, billing or order qty.
const {commitServiceCaseEvent,getServiceCaseStatus,getServiceOrderProgress}=require('./service-case-service');
const {allowServiceCaseEmulator}=require('./service-case-gate');
exports.commitServiceCaseEvent=onCall({region:'asia-east1'},async request=>{
  if(!allowServiceCaseEmulator())
    throw new HttpsError('failed-precondition','服務案件功能尚未完成 Preview 驗收');
  if(!request.auth?.uid)
    throw new HttpsError('unauthenticated','請先登入');
  try{return await commitServiceCaseEvent(getFirestore(),request.auth.uid,request.data);}
  catch(error){
    const allowed=['invalid-argument','permission-denied','failed-precondition','not-found','already-exists'];
    if(allowed.includes(error.code))throw new HttpsError(error.code,error.message);
    console.error('Service case event transaction failed',error);
    throw new HttpsError('internal','服務案件交易失敗');
  }
});

// Read-only history/status transport. Explicitly isolated to demo-yushin;
// no direct Firestore client reads and no production feature activation.
exports.getServiceCaseStatus=onCall({region:'asia-east1'},async request=>{
  if(!allowServiceCaseEmulator())
    throw new HttpsError('failed-precondition','服務案件查詢尚未完成 Preview 驗收');
  if(!request.auth?.uid)
    throw new HttpsError('unauthenticated','請先登入');
  try{return await getServiceCaseStatus(getFirestore(),request.auth.uid,request.data);}
  catch(error){
    const allowed=['invalid-argument','permission-denied','failed-precondition','not-found'];
    if(allowed.includes(error.code))throw new HttpsError(error.code,error.message);
    console.error('Service case status read failed',error);
    throw new HttpsError('internal','服務案件查詢失敗');
  }
});

// Explicit, bounded Service order progress verification. No Firestore writes,
// and never treats Goods delivery or financial billing as service completion.
exports.getServiceOrderProgress=onCall({region:'asia-east1'},async request=>{
  if(!allowServiceCaseEmulator())
    throw new HttpsError('failed-precondition','服務整單查核尚未完成 Preview 驗收');
  if(!request.auth?.uid)throw new HttpsError('unauthenticated','請先登入');
  try{return await getServiceOrderProgress(getFirestore(),request.auth.uid,request.data);}
  catch(error){
    const allowed=['invalid-argument','permission-denied','failed-precondition','not-found'];
    if(allowed.includes(error.code))throw new HttpsError(error.code,error.message);
    console.error('Service order progress read failed',error);
    throw new HttpsError('internal','服務整單進度查核失敗');
  }
});

// Pure-Service billing trial; same demo-only Auth/Firestore gate as cases.
const {commitServiceOrderBilling}=require('./service-billing-service');
exports.commitServiceOrderBilling=onCall({region:'asia-east1'},async request=>{
  if(!allowServiceCaseEmulator())
    throw new HttpsError('failed-precondition','服務核銷尚未完成 Preview 驗收');
  if(!request.auth?.uid)throw new HttpsError('unauthenticated','請先登入');
  try{return await commitServiceOrderBilling(getFirestore(),request.auth.uid,request.data);}
  catch(error){
    if(['invalid-argument','permission-denied','failed-precondition','not-found','already-exists'].includes(error.code))
      throw new HttpsError(error.code,error.message);
    console.error('Service billing transaction failed',error);
    throw new HttpsError('internal','服務核銷交易失敗');
  }
});

// Manual purchasing has independent, default-closed Emulator/Preview/production gates.
const {createQuickPurchaseCallable}=require('./quick-purchase-callable');
exports.commitV2QuickPurchase=createQuickPurchaseCallable({onCall,HttpsError,getDatabase:getFirestore});

// Isolated receiving migration candidate: only demo Emulator or separately
// authorized Preview can call this, never the production project.
const {createSupplyReceiptCallable}=require('./supply-receipt-callable');
exports.receiveV2Supply=createSupplyReceiptCallable({onCall,HttpsError,getDatabase:getFirestore});

// Explicitly gated dispatch-preparation Preview candidate. It only changes
// paperwork preparation, not physical shipment or customer delivery.
const {createDispatchPreparationCallable}=require('./dispatch-preparation-callable');
exports.prepareV2OrderDispatch=createDispatchPreparationCallable({onCall,HttpsError,getDatabase:getFirestore});

// Customer acknowledgement is independent of shipment stock accounting.
// Production cannot enable this explicitly gated Emulator/Preview candidate.
const {createDeliveryConfirmationCallable}=require('./delivery-confirmation-callable');
exports.confirmV2ShipmentDelivery=createDeliveryConfirmationCallable({onCall,HttpsError,getDatabase:getFirestore});

// Delivery reversal only corrects acknowledgement; shipped inventory stays
// outside this transaction. It has its own default-closed Preview gate.
const {createDeliveryReversalCallable}=require('./delivery-reversal-callable');
exports.reverseV2ShipmentDelivery=createDeliveryReversalCallable({onCall,HttpsError,getDatabase:getFirestore});

// Physical customer shipment is a separate atomic transaction from paperwork.
// Both the demo Emulator and Preview gates are disabled unless independently
// authorized; production has no enablement path.
const {createWarehouseShipmentCallable}=require('./warehouse-shipment-callable');
exports.shipV2WarehouseItem=createWarehouseShipmentCallable({onCall,HttpsError,getDatabase:getFirestore});

// Whole-order cancellation/restoration is a separate default-closed Preview
// transaction; the old client writer remains until a later rollout approval.
const {createOrderLifecycleCallable}=require('./order-lifecycle-preview-callable');
exports.setV2OrderLifecycle=createOrderLifecycleCallable({onCall,HttpsError,getDatabase:getFirestore});

// V3 owner-Custody cancellation/restoration has its own strictly demo-only
// authority gate until full shipment/return and Preview acceptance is complete.
const {createCustodyLifecycleCallable}=require('./custody-lifecycle-service');
exports.setV3CustodyOrderLifecycle=createCustodyLifecycleCallable({onCall,HttpsError,getDatabase:getFirestore});

// After a verified physical V3 HANDOFF, the owner can separately ship from
// Custody to the customer.  Demo Auth/Functions/Firestore Emulator only.
const {createCustodyShipmentCallable}=require('./custody-shipment-service');
exports.shipV3CustodyItem=createCustodyShipmentCallable({onCall,HttpsError,getDatabase:getFirestore});

// V3 customer receipt is separate from Custody stock deduction. Demo only.
const {createCustodyDeliveryCallable}=require('./custody-delivery-service');
exports.confirmV3CustodyDelivery=createCustodyDeliveryCallable({onCall,HttpsError,getDatabase:getFirestore});

// Return to the exact Custody source lot after customer receipt; no automatic
// free-stock allocation or formal production enablement.
const {createCustodyReturnCallable}=require('./custody-return-service');
exports.receiveV3CustodyReturn=createCustodyReturnCallable({onCall,HttpsError,getDatabase:getFirestore});

// Independent, default-closed return Preview; no second inventory writer.
const {createCustomerReturnCallables}=require('./customer-return-callable');
const customerReturnCallables=createCustomerReturnCallables({onCall,HttpsError,getDatabase:getFirestore});
exports.previewV2CustomerReturn=customerReturnCallables.previewV2CustomerReturn;
exports.receiveV2CustomerReturn=customerReturnCallables.receiveV2CustomerReturn;

// Application/withdrawal is independently gated from physical receipt.
const {createCustomerReturnRequestCallables}=require('./customer-return-request-callable');
const customerReturnRequests=createCustomerReturnRequestCallables({onCall,HttpsError,getDatabase:getFirestore});
exports.requestV2CustomerReturn=customerReturnRequests.requestV2CustomerReturn;
exports.withdrawV2CustomerReturnRequest=customerReturnRequests.withdrawV2CustomerReturnRequest;

const {createCancelledPurchaseCallable}=require('./cancelled-purchase-service');
exports.keepV2CancelledPurchaseStock=createCancelledPurchaseCallable({onCall,HttpsError,getDatabase:getFirestore});

const {createMainTransferRequestCallables}=require('./main-transfer-request-service');
const mainTransferRequests=createMainTransferRequestCallables({onCall,HttpsError,getDatabase:getFirestore});
exports.createV2MainTransferRequest=mainTransferRequests.createV2MainTransferRequest;
exports.cancelV2MainTransferRequest=mainTransferRequests.cancelV2MainTransferRequest;

// Physical dispatch and receipt retain independent gates and operation identities.
const {createMainTransferPhysicalCallables}=require('./main-transfer-physical-service');
const mainTransferPhysical=createMainTransferPhysicalCallables({onCall,HttpsError,getDatabase:getFirestore});
exports.dispatchV2MainTransfer=mainTransferPhysical.dispatchV2MainTransfer;
exports.receiveV2MainTransfer=mainTransferPhysical.receiveV2MainTransfer;

const {createMainTransferAllocationCallable}=require('./main-transfer-allocation-callable');
exports.resumeV2MainTransferAllocation=createMainTransferAllocationCallable({onCall,HttpsError,getDatabase:getFirestore});

const {createMainTransferAllocationListCallable}=require('./main-transfer-allocation-list');
exports.listV2MainTransferAllocations=createMainTransferAllocationListCallable({onCall,HttpsError,getDatabase:getFirestore});

const {createOrderTransferPhysicalCallables}=require('./order-transfer-physical-service');
const orderTransferPhysical=createOrderTransferPhysicalCallables({onCall,HttpsError,getDatabase:getFirestore});
exports.dispatchOrderTransfer=orderTransferPhysical.dispatchOrderTransfer;
exports.receiveOrderTransfer=orderTransferPhysical.receiveOrderTransfer;

exports.handoffOrderTransfer=orderTransferPhysical.handoffOrderTransfer;
