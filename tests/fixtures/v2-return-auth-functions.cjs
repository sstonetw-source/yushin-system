'use strict';
// The runner copies only this entry into a temporary Functions source.
// All business logic and SDKs are loaded from the real checkout, not copied writers.
const path=require('node:path'),{createRequire}=require('node:module');
const {root}=require('./checkout.json');
const runtime=createRequire(path.join(root,'functions/package.json'));
const {onCall,HttpsError}=runtime('firebase-functions/v2/https');
const {getApps,initializeApp}=runtime('firebase-admin/app');
const {getFirestore}=runtime('firebase-admin/firestore');
if(!getApps().length)initializeApp();
const standard=require(path.join(root,'functions/v2-return-callable-adapter')).createV2ReturnCallables({
 onCall,HttpsError,getDatabase:getFirestore});
// Use the real, demo-gated service endpoints for original full-site UI acceptance.
const service=require(path.join(root,'functions/index'));
// Exercise the same guarded endpoint that functions/index.js exports for
// Preview, instead of silently testing the older Emulator-only PO wrapper.
const previewPurchase=require(path.join(root,'functions/formal-purchase-preview-callable'))
 .createPreviewFormalPurchaseCallable({onCall,HttpsError,getDatabase:getFirestore});
const quickPurchase=require(path.join(root,'functions/quick-purchase-callable'))
 .createQuickPurchaseCallable({onCall,HttpsError,getDatabase:getFirestore});
module.exports={...standard,handoffOrderTransfer:service.handoffOrderTransfer,dispatchOrderTransfer:service.dispatchOrderTransfer,receiveOrderTransfer:service.receiveOrderTransfer,previewV2CustomerReturn:service.previewV2CustomerReturn,
 requestV2CustomerReturn:service.requestV2CustomerReturn,withdrawV2CustomerReturnRequest:service.withdrawV2CustomerReturnRequest,
 receiveV2CustomerReturn:service.receiveV2CustomerReturn,prepareV2OrderDispatch:service.prepareV2OrderDispatch,
 shipV2WarehouseItem:service.shipV2WarehouseItem,setV2OrderLifecycle:service.setV2OrderLifecycle,
 receiveV2Supply:service.receiveV2Supply,commitV2FormalPurchase:previewPurchase,commitV2QuickPurchase:quickPurchase,
 commitServiceCaseEvent:service.commitServiceCaseEvent,
 getServiceCaseStatus:service.getServiceCaseStatus,
 getServiceOrderProgress:service.getServiceOrderProgress,
 commitServiceOrderBilling:service.commitServiceOrderBilling};
