'use strict';
// Emulator fixture adapter around the existing incoming-registration Service.
// This prepares PO receipts; it is not original purchase-UI acceptance.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
async function registerV2PurchaseIncomingFixture(db,uid,poNo){
 if(!process.env.FIRESTORE_EMULATOR_HOST||db.projectId!=='demo-yushin')throw Error('Incoming fixture requires demo-yushin Emulator');
 const c=vm.createContext({db,currentUser:{uid},currentUserRole:'purchaser',currentUserName:'採購',
  canCreatePurchaseOrderCapability:()=>true,canAccessPage:()=>true,YushinReceiving:require('../../modules/receiving-core'),
  isPurchaseTerminalStatus:status=>['CANCELLED','CLOSED'].includes(String(status||'').toUpperCase()),
  supplyOrdersCollection:()=>db.collection('supplyOrders'),inventoryNumbers:require('../../modules/inventory-core').normalizeStock,
  warehouseStockDocId:(wh,p)=>encodeURIComponent(wh)+'__'+encodeURIComponent(p),resolveBrandName:value=>value,
  brandIdForName:()=>'',buildInventorySearchTokens:()=>[],
  runRoleTransaction:callback=>require('../../modules/stock-permissions').run(db,callback,uid,false,'purchaser')});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../../src/services/supply-order.js'),'utf8'),c);
 await c.registerPurchaseIncoming(poNo,(await db.collection('purchaseOrders').doc(poNo).get()).data());
}
module.exports={registerV2PurchaseIncomingFixture};
