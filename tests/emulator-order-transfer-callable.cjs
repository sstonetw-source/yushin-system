'use strict';
// Real Auth -> exported Callable -> original atomic Service -> Firestore.
// Admin seeds legacy source documents; this is not original order-entry UI acceptance.
const test=require('node:test'),assert=require('node:assert/strict');
const admin=require('firebase-admin'),{getFirestore}=require('firebase-admin/firestore'),{getAuth:adminAuth}=require('firebase-admin/auth');
const {initializeApp,deleteApp}=require('firebase/app');
const {getAuth,connectAuthEmulator,signInWithEmailAndPassword}=require('firebase/auth');
const {getFunctions,connectFunctionsEmulator,httpsCallable}=require('firebase/functions');
const {commitOrderTransferPhysical}=require('../functions/order-transfer-physical-service');
const clients=[];let server,db,accounts;
const env={GCLOUD_PROJECT:'demo-yushin',FUNCTIONS_EMULATOR:'true',FIRESTORE_EMULATOR_HOST:'127.0.0.1:8080',FIREBASE_AUTH_EMULATOR_HOST:'127.0.0.1:9099',ENABLE_ORDER_TRANSFER_DISPATCH_EMULATOR:'true',ENABLE_ORDER_TRANSFER_RECEIVE_EMULATOR:'true'};
test.before(()=>{
 for(const key of ['FIRESTORE_EMULATOR_HOST','FIREBASE_AUTH_EMULATOR_HOST'])assert.match(process.env[key]||'',/^(localhost|127\.0\.0\.1):[0-9]+$/);
 assert.equal(process.env.GCLOUD_PROJECT||process.env.GCP_PROJECT,'demo-yushin');
 server=admin.initializeApp({projectId:'demo-yushin'},'order-transfer-auth');db=getFirestore(server);accounts=adminAuth(server);
});
test.after(async()=>{await Promise.all(clients.map(deleteApp));if(server)await server.delete();});
async function fixture(tag,{login=true}={}){
 const prefix='order-transfer-auth-'+tag,uid=prefix+'-U',productKey=prefix+'-P',orderId=prefix+'-O',from=prefix+'-A',to=prefix+'-B',transferId=prefix+'-T';
 const app=initializeApp({apiKey:'fake-api-key',projectId:'demo-yushin',appId:prefix},prefix);clients.push(app);
 const auth=getAuth(app);connectAuthEmulator(auth,'http://127.0.0.1:9099',{disableWarnings:true});
 if(login){const email=uid+'@example.test';await accounts.createUser({uid,email,password:'EmulatorOnly!123456'});await signInWithEmailAndPassword(auth,email,'EmulatorOnly!123456');}
 const functions=getFunctions(app,'asia-east1');connectFunctionsEmulator(functions,'127.0.0.1',5001);
 const batch=db.batch(),set=(name,id,data)=>batch.set(db.collection(name).doc(id),data);
 set('users',uid,{role:'warehouse',active:true});set('products',productKey,{productType:'Goods',active:true});
 set('warehouses',from,{active:true});set('warehouses',to,{active:true});
 set('inventory',productKey,{productKey,onHand:3,reserved:3});set('warehouseStocks',from+'__'+productKey,{productKey,warehouseId:from,onHand:3,reserved:3});
 set('inventoryLots',prefix+'-L',{productKey,warehouseId:from,remainingQty:3,qty:3,lotNo:'LOT',expiryDate:'2027-01-01'});
 set('inventoryLotCosts',prefix+'-L',{unitCost:99});
 const sibling={itemId:'SIBLING',productId:'OTHER',qty:1,reservedQty:0,shortageQty:1};
 set('orders',orderId,{status:'active',inventoryReservationStatus:'completed',ownerUid:'OWNER',salesCode:'01',items:[sibling,{itemId:'I',productId:productKey,qty:3,reservedQty:3,shortageQty:0,warehouseId:from,dispatchPreparedQty:3,deliveryPlan:{mode:'TRANSFER',warehouseId:to,contact:'Warehouse',phone:'123',address:'Taipei'}}]});
 set('inventoryReservations',orderId+'__I',{orderId,itemId:'I',productKey,warehouseId:from,quantity:3,shortageQty:0,status:'active'});await batch.commit();
 const send={id:transferId,orderId,itemId:'I',fromWarehouseId:from,toWarehouseId:to,qty:3},receive={id:transferId,operationId:prefix+'-receive'};
 const call=name=>input=>httpsCallable(functions,name,{timeout:30000})(input).then(r=>r.data);
 const paths=[['inventory',productKey],['warehouseStocks',from+'__'+productKey],['warehouseStocks',to+'__'+productKey],['inventoryLots',prefix+'-L'],['inventoryLots',transferId+'-0'],['inventoryLotCosts',transferId+'-0'],['orders',orderId],['inventoryReservations',orderId+'__I'],['stockTransfers',transferId],['inventoryMovements',transferId+'-out'],['inventoryMovements',transferId+'-in'],['reservationOperationReceipts','order-transfer-dispatch-'+transferId],['reservationOperationReceipts','order-transfer-receipt-'+receive.operationId]];
 const read=async(name,id)=>(await db.collection(name).doc(id).get()).data();
 return {prefix,uid,productKey,orderId,from,to,transferId,send,receive,sibling,read,
  dispatch:call('dispatchOrderTransfer'),receipt:call('receiveOrderTransfer'),
  snapshot:async()=>Promise.all(paths.map(async([name,id])=>({path:name+'/'+id,data:await read(name,id)})))};
}
test('authenticated concurrent dispatch and receipt preserve stock and sibling data; replay original IDs after discarding replies',async()=>{
 const f=await fixture('race');await Promise.all([f.dispatch(f.send),f.dispatch(f.send)]);
 let before=await f.snapshot();assert.equal((await f.dispatch(f.send)).status,'already-applied');assert.deepEqual(await f.snapshot(),before);
 assert.equal((await f.read('inventory',f.productKey)).reserved,3);assert.equal((await f.read('warehouseStocks',f.from+'__'+f.productKey)).reserved,0);
 await Promise.all([f.receipt(f.receive),f.receipt(f.receive)]);before=await f.snapshot();assert.equal((await f.receipt(f.receive)).status,'already-applied');assert.deepEqual(await f.snapshot(),before);
 const order=await f.read('orders',f.orderId);assert.deepEqual(order.items[0],f.sibling);assert.equal(order.items[1].warehouseId,f.to);assert.equal(order.logisticsTransfersPending,0);assert.equal(order.deliveryRecords,undefined);
 assert.equal((await f.read('inventory',f.productKey)).onHand,3);assert.equal((await f.read('warehouseStocks',f.to+'__'+f.productKey)).reserved,3);
 const cost=await f.read('inventoryLotCosts',f.transferId+'-0');assert.equal(cost.costSourceLotId,f.prefix+'-L');assert.equal('unitCost' in cost,false);
});
test('unauthenticated role revocation v2 and conflicting original identity reject without partial writes',async()=>{
 const guest=await fixture('guest',{login:false});let before=await guest.snapshot();await assert.rejects(guest.dispatch(guest.send),e=>e.code==='functions/unauthenticated');assert.deepEqual(await guest.snapshot(),before);
 const f=await fixture('revoked');await f.dispatch(f.send);await db.collection('users').doc(f.uid).update({role:'sales'});before=await f.snapshot();await assert.rejects(f.receipt(f.receive),e=>e.code==='functions/permission-denied');assert.deepEqual(await f.snapshot(),before);
 await db.collection('users').doc(f.uid).update({role:'warehouse'});before=await f.snapshot();await assert.rejects(f.dispatch({...f.send,qty:2}));assert.deepEqual(await f.snapshot(),before);
 const v=await fixture('v2');await db.collection('inventoryReservations').doc(v.orderId+'__I').update({locationSchemaVersion:2,locations:[{warehouseId:v.from,reservedQty:3}]});before=await v.snapshot();await assert.rejects(v.dispatch(v.send));assert.deepEqual(await v.snapshot(),before);
});
test('receipt destination collision is atomic and succeeds with original operation after repair',async()=>{
 const f=await fixture('receipt-collision');await f.dispatch(f.send);const ref=db.collection('inventoryLots').doc(f.transferId+'-0');await ref.set({sentinel:true});const before=await f.snapshot();await assert.rejects(f.receipt(f.receive));assert.deepEqual(await f.snapshot(),before);await ref.delete();assert.equal((await f.receipt(f.receive)).status,'applied');
});
test('real late Firestore create collision rolls back all buffered dispatch writes',async()=>{
 const f=await fixture('late-collision'),collision=db.collection('reservationOperationReceipts').doc(f.prefix+'-collision');await collision.set({sentinel:true});const before=await f.snapshot();
 const wrapped={projectId:db.projectId,collection:name=>db.collection(name),runTransaction:fn=>db.runTransaction(tx=>fn({get:ref=>tx.get(ref),set:(...args)=>tx.set(...args),update:(...args)=>tx.update(...args),create:(ref,data)=>{if(ref.path==='inventoryMovements/'+f.transferId+'-out')tx.create(collision,{sentinel:false});return tx.create(ref,data);}}))};
 await assert.rejects(commitOrderTransferPhysical(wrapped,f.uid,f.send,'DISPATCH',env));assert.deepEqual(await f.snapshot(),before);assert.equal((await collision.get()).data().sentinel,true);
});
test('competing dispatch identities cannot move the same order twice and reassignment blocks original receipt',async()=>{
 const f=await fixture('compete'),alternative={...f.send,id:f.send.id+'-other'};
 const results=await Promise.allSettled([f.dispatch(f.send),f.dispatch(alternative)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.equal((await f.read('warehouseStocks',f.from+'__'+f.productKey)).onHand,0);
 const actual=(await f.read('orders',f.orderId)).items[1].transferPendingId;
 await db.collection('orders').doc(f.orderId).update({ownerUid:'REASSIGNED'});const before=await f.snapshot();
 await assert.rejects(f.receipt({id:actual,operationId:f.receive.operationId}));assert.deepEqual(await f.snapshot(),before);
});
test('v2 whole-source Callable transfer preserves locations schema and original warehouse candidates',async()=>{
 const f=await fixture('v2-whole'),ledgerRef=db.collection('inventoryReservations').doc(f.orderId+'__I');
 await ledgerRef.update({warehouseId:require('firebase-admin/firestore').FieldValue.delete(),locationSchemaVersion:2,ownerUid:'OWNER',salesCode:'01',lifecycleWarehouseIds:[f.from,f.to],locations:[{warehouseId:f.from,reservedQty:3}]});
 await f.dispatch(f.send);const inTransit=(await ledgerRef.get()).data();assert.deepEqual(inTransit.locations,[{warehouseId:f.from,reservedQty:3}]);assert.equal('warehouseId' in inTransit,false);
 await f.receipt(f.receive);const ledger=(await ledgerRef.get()).data();assert.deepEqual(ledger.locations,[{warehouseId:f.to,reservedQty:3}]);assert.equal('warehouseId' in ledger,false);assert.equal(ledger.quantity,3);assert.deepEqual(ledger.lifecycleWarehouseIds,[f.from,f.to]);
 const before=await f.snapshot();await f.receipt(f.receive);assert.deepEqual(await f.snapshot(),before);
 assert.equal((await f.read('inventory',f.productKey)).reserved,3);assert.equal((await f.read('warehouseStocks',f.to+'__'+f.productKey)).reserved,3);
});
test('legacy assigned-owner handoff Callable keeps company and customer facts unchanged and replays one custody movement',async()=>{
 const f=await fixture('handoff');const order=await f.read('orders',f.orderId);order.items[1].deliveryPlan={mode:'SALES_SHIP',contact:'Owner',phone:'123',address:'Taipei'};await db.collection('orders').doc(f.orderId).update({items:order.items});
 const client=clients.at(-1),functions=getFunctions(client,'asia-east1'),input={...f.send,toWarehouseId:'custody-OWNER'};
 const handoff=data=>httpsCallable(functions,'handoffOrderTransfer',{timeout:30000})(data).then(r=>r.data);
 assert.equal((await handoff(input)).status,'applied');assert.equal((await handoff(input)).status,'already-applied');
 const company=await f.read('inventory',f.productKey),custody=await f.read('warehouseStocks','custody-OWNER__'+f.productKey),saved=await f.read('orders',f.orderId);
 assert.equal(company.onHand,3);assert.equal(company.reserved,3);assert.equal(company.transferInTransit,0);assert.equal(custody.onHand,3);assert.equal(custody.reserved,3);
 assert.equal(saved.items[1].custodyTransferId,input.id);assert.deepEqual(saved.items[0],f.sibling);assert.equal(saved.deliveryRecords,undefined);assert.equal(saved.logisticsTransfersPending,0);
 assert.equal((await f.read('stockTransfers',input.id)).kind,'HANDOFF');await assert.rejects(f.receipt({id:input.id,operationId:f.receive.operationId}));
});
