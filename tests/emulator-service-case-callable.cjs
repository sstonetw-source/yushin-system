'use strict';
// Real Firebase Auth -> Callable -> Admin transaction. Demo-only, isolated.
const test=require('node:test'),assert=require('node:assert/strict');
const admin=require('firebase-admin');
const {getFirestore}=require('firebase-admin/firestore');
const {getAuth:adminAuth}=require('firebase-admin/auth');
const {initializeApp,deleteApp}=require('firebase/app');
const {getAuth,connectAuthEmulator,signInWithEmailAndPassword}=require('firebase/auth');
const {getFunctions,connectFunctionsEmulator,httpsCallable}=require('firebase/functions');
const {getFirestore:clientDb,connectFirestoreEmulator,doc,getDoc,setDoc}=require('firebase/firestore');
const {caseDocId,itemCaseIndexId}=require('../functions/service-case-service');
const project='demo-yushin',clients=[];let server,db,accounts;
test.before(()=>{
 for(const name of ['FIRESTORE_EMULATOR_HOST','FIREBASE_AUTH_EMULATOR_HOST'])
   assert.match(process.env[name]||'',/^(127\.0\.0\.1|localhost):[0-9]+$/);
 assert.equal(process.env.GCLOUD_PROJECT||process.env.GCP_PROJECT,project);
 server=admin.initializeApp({projectId:project},'service-auth-acceptance');
 db=getFirestore(server);accounts=adminAuth(server);
});
test.after(async()=>{
 await Promise.all(clients.map(deleteApp));
 if(server)await server.delete();
});
async function actor(tag,role){
 const uid='service-auth-'+tag+'-'+role,email=uid+'@example.test';
 await accounts.createUser({uid,email,password:'EmulatorOnly!123456'});
 const app=initializeApp({apiKey:'fake-api-key',authDomain:project+'.firebaseapp.com',
   projectId:project,appId:'service-callable-auth-test'},uid);
 clients.push(app);
 const auth=getAuth(app);
 connectAuthEmulator(auth,'http://127.0.0.1:9099',{disableWarnings:true});
 await signInWithEmailAndPassword(auth,email,'EmulatorOnly!123456');
 const functions=getFunctions(app,'asia-east1');
 connectFunctionsEmulator(functions,'127.0.0.1',5001);
 const firestore=clientDb(app);
 connectFirestoreEmulator(firestore,'127.0.0.1',8080);
 return {uid,app,firestore,call:payload=>httpsCallable(functions,'commitServiceCaseEvent',{timeout:30000})(payload).then(r=>r.data)};
}
async function fixture(tag,kind){
 const orderId='service-order-'+tag,itemId='S',productId='service-product-'+tag,caseId='case-'+tag;
 const [sales,warehouse,engineer,other]=await Promise.all([
   actor(tag,'sales'),actor(tag,'warehouse'),actor(tag,'engineer'),actor(tag,'other')
 ]);
 const batch=db.batch();
 for(const [profile,role] of [[sales,'sales'],[warehouse,'warehouse'],[engineer,'engineer'],[other,'sales']])
   batch.set(db.doc('users/'+profile.uid),{role,active:true,salesCode:tag});
 batch.set(db.doc('products/'+productId),{active:true,productType:'Service',serviceKind:kind});
 batch.set(db.doc('orders/'+orderId),{ownerUid:sales.uid,salesCode:tag,status:'active',
   inventoryReservationStatus:'completed',items:[{itemId,productId,productType:'Service',
     serviceKind:kind,qty:1}]});
 await batch.commit();
 const intent=(type,index=0,details={},cid=caseId)=>({orderId,itemId,caseId:cid,serviceQty:1,
   event:{id:'event-'+index,type,occurredAt:new Date(Date.UTC(2026,9,22,9,index)).toISOString(),
     ...details}});
 const record=async()=> (await db.doc('serviceCases/'+caseDocId(orderId,itemId,caseId)).get()).data();
 return {sales,warehouse,engineer,other,db,orderId,itemId,productId,caseId,intent,record};
}
test('Bio-Plex: sales receives specimen, engineer experiments and sends verified report',async()=>{
 const f=await fixture('bio','BIOPLEX_LAB');
 const first=f.intent('SAMPLE_RECEIVED');
 assert.equal((await f.sales.call(first)).custody,'IN_HOUSE');
 assert.equal((await f.sales.call(first)).status,'already-applied');
 await assert.rejects(f.sales.call(f.intent('EXPERIMENT_COMPLETED',1)),
   e=>e.code==='functions/permission-denied');
 assert.equal((await f.engineer.call(f.intent('EXPERIMENT_COMPLETED',1))).nextEvent,'REPORT_SENT');
 await assert.rejects(f.engineer.call(f.intent('REPORT_SENT',2)),
   e=>e.code==='functions/invalid-argument');
 const done=await f.engineer.call(f.intent('REPORT_SENT',2,{reportRef:'report/proof'}));
 assert.equal(done.completed,true);
 assert.equal(done.itemWorkCategory,'billing');
 assert.equal(done.custody,'IN_HOUSE'); // report delivery does not prove sample disposal
 const saved=await f.record();
 assert.equal(saved.events.length,3);
 assert.equal(saved.events[2].actorUid,f.engineer.uid);
 assert.equal(saved.createdByUid,f.sales.uid);
 assert.equal(saved.status,'COMPLETED');
 const order=(await db.doc('orders/'+f.orderId).get()).data();
 assert.equal(order.isDelivered,undefined);assert.equal(order.isBilled,undefined);
 assert.equal(order.items[0].deliveredQty,undefined);
 assert.equal((await db.collection('inventoryMovements').where('sourceId','==',f.orderId).get()).size,0);
});
test('Pipette: real custody handoff, outside vendor return and customer acknowledgment',async()=>{
 const f=await fixture('pipette','PIPETTE_CALIBRATION');
 await f.sales.call(f.intent('DEVICE_RECEIVED'));
 await assert.rejects(f.other.call(f.intent('VENDOR_SENT',1,{partyName:'Lab'})),
   e=>e.code==='functions/permission-denied');
 assert.equal((await f.warehouse.call(f.intent('VENDOR_SENT',1,{partyName:'Lab'}))).custody,'AT_VENDOR');
 assert.equal((await f.warehouse.call(f.intent('VENDOR_RETURNED',2))).custody,'IN_HOUSE');
 assert.equal((await f.sales.call(f.intent('CUSTOMER_RETURNED',3,{receivedBy:'Customer'}))).completed,true);
 assert.equal((await f.record()).events.length,4);
});
test('Tissue: vendor custody must be returned before customer delivery evidence',async()=>{
 const f=await fixture('tissue','TISSUE_SLICING');
 await f.sales.call(f.intent('SAMPLE_RECEIVED'));
 await assert.rejects(f.sales.call(f.intent('VENDOR_SENT',1,{partyName:'Tissue Lab'})),
   e=>e.code==='functions/permission-denied');
 await f.warehouse.call(f.intent('VENDOR_SENT',1,{partyName:'Tissue Lab'}));
 await assert.rejects(f.sales.call(f.intent('CUSTOMER_DELIVERED',3,{deliveryRef:'receipt'})),
   e=>e.code==='functions/failed-precondition');
 await f.warehouse.call(f.intent('VENDOR_RETURNED',2));
 const done=await f.sales.call(f.intent('CUSTOMER_DELIVERED',3,{deliveryRef:'receipt'}));
 assert.equal(done.completed,true);
});
test('Onsite repair: engineer completion, no virtual inventory, retry intent checked',async()=>{
 const f=await fixture('repair','ONSITE_REPAIR');
 await assert.rejects(f.sales.call(f.intent('REPAIR_COMPLETED',0,{workSummary:'adjusted'})),
   e=>e.code==='functions/permission-denied');
 const event=f.intent('REPAIR_COMPLETED',0,{workSummary:'Adjusted calibration'}),done=await f.engineer.call(event);
 assert.equal(done.completed,true);
 assert.equal((await f.engineer.call(event)).status,'already-applied');
 await assert.rejects(f.engineer.call({...event,event:{...event.event,workSummary:'different'}}),
   e=>e.code==='functions/failed-precondition');
 assert.equal((await f.record()).events.length,1);
 assert.equal((await db.doc('inventory/'+f.productId).get()).exists,false);
});
test('Server trusts signed Auth identity and current role, not spoofed request fields',async()=>{
 const f=await fixture('auth','BIOPLEX_LAB');
 await assert.rejects(f.other.call(f.intent('SAMPLE_RECEIVED')),
   e=>e.code==='functions/permission-denied');
 await assert.rejects(f.sales.call({...f.intent('SAMPLE_RECEIVED'),
   event:{...f.intent('SAMPLE_RECEIVED').event,actorUid:f.engineer.uid}}),
   e=>e.code==='functions/permission-denied');
 await db.doc('users/'+f.sales.uid).update({active:false});
 await assert.rejects(f.sales.call(f.intent('SAMPLE_RECEIVED')),
   e=>e.code==='functions/permission-denied');
 assert.equal(await f.record(),undefined);
});
test('No Authentication or invalid Service product master cannot create a case',async()=>{
 const f=await fixture('guard','BIOPLEX_LAB');
 const anon=initializeApp({apiKey:'fake-api-key',authDomain:project+'.firebaseapp.com',
   projectId:project,appId:'anonymous-service-case'},'anonymous-service-case');
 clients.push(anon);
 const fun=getFunctions(anon,'asia-east1');connectFunctionsEmulator(fun,'127.0.0.1',5001);
 await assert.rejects(httpsCallable(fun,'commitServiceCaseEvent')(f.intent('SAMPLE_RECEIVED')),
   e=>e.code==='functions/unauthenticated');
 await db.doc('products/'+f.productId).update({serviceKind:'ONSITE_REPAIR'});
 await assert.rejects(f.sales.call(f.intent('SAMPLE_RECEIVED')),
   e=>e.code==='functions/failed-precondition');
 assert.equal(await f.record(),undefined);
});
test('Direct Firestore serviceCases read/write is denied even for valid client Auth',async()=>{
 const f=await fixture('rules','BIOPLEX_LAB');
 const key=caseDocId(f.orderId,f.itemId,f.caseId);
 await assert.rejects(setDoc(doc(f.sales.firestore,'serviceCases',key),{status:'COMPLETED'}),
   e=>e.code==='permission-denied');
 await f.sales.call(f.intent('SAMPLE_RECEIVED'));
 await assert.rejects(getDoc(doc(f.sales.firestore,'serviceCases',key)),
   e=>e.code==='permission-denied');
 assert.equal((await f.record()).events.length,1);
});

test('real Auth read-only case history distinguishes missing ID and existing custody',async()=>{
 const f=await fixture('history','PIPETTE_CALIBRATION');
 const locate={orderId:f.orderId,itemId:f.itemId,caseId:f.caseId};
 const read=who=>httpsCallable(getFunctions(who.app,'asia-east1'),'getServiceCaseStatus',{timeout:30000})(locate).then(r=>r.data);
 await assert.rejects(read(f.other),e=>e.code==='functions/permission-denied');
 const none=await read(f.sales);
 assert.equal(none.exists,false);
 assert.equal(none.workStatus,'NOT_STARTED');
 assert.equal((await db.doc('serviceCases/'+caseDocId(f.orderId,f.itemId,f.caseId)).get()).exists,false);
 await f.sales.call(f.intent('DEVICE_RECEIVED'));
 const pending=await read(f.sales);
 assert.equal(pending.exists,true);
 assert.equal(pending.nextEvent,'VENDOR_SENT');
 assert.equal(pending.custody,'IN_HOUSE');
 assert.equal(pending.events.length,1);
 await f.warehouse.call(f.intent('VENDOR_SENT',1,{partyName:'Calibrator'}));
 const shipped=await read(f.engineer);
 assert.equal(shipped.custody,'AT_VENDOR');
 assert.equal(shipped.events.length,2);
 await db.doc('orders/'+f.orderId).update({orderStatus:'cancelled'});
 assert.equal((await read(f.sales)).events.length,2); // audit remains readable
 await assert.rejects(f.warehouse.call(f.intent('VENDOR_RETURNED',2)),
   e=>e.code==='functions/failed-precondition');
 await db.doc('users/'+f.sales.uid).update({disabled:true});
 await assert.rejects(read(f.sales),e=>e.code==='functions/permission-denied');
});

test('real Callable keeps original product binding across replacement and replay',async()=>{
 const f=await fixture('product-binding','BIOPLEX_LAB');
 const first=f.intent('SAMPLE_RECEIVED');
 await f.sales.call(first);
 const original=await f.record();
 assert.equal(original.productId,f.productId);
 const replacement=f.productId+'-replacement';
 await db.doc('products/'+replacement).set({active:true,productType:'Service',serviceKind:'BIOPLEX_LAB'});
 const orderRef=db.doc('orders/'+f.orderId),order=(await orderRef.get()).data();
 await orderRef.update({items:order.items.map(item=>({...item,productId:replacement}))});
 const locate={orderId:f.orderId,itemId:f.itemId,caseId:f.caseId};
 const read=()=>httpsCallable(getFunctions(f.sales.app,'asia-east1'),'getServiceCaseStatus')(locate);
 await assert.rejects(read(),e=>e.code==='functions/failed-precondition');
 await assert.rejects(f.sales.call(first),e=>e.code==='functions/failed-precondition');
 await assert.rejects(f.engineer.call(f.intent('EXPERIMENT_COMPLETED',1)),
   e=>e.code==='functions/failed-precondition');
 assert.deepEqual(await f.record(),original);
 await orderRef.update({items:order.items,orderStatus:'cancelled'});
 await db.doc('products/'+f.productId).delete();
 assert.equal((await read()).data.custody,'IN_HOUSE');
});

test('real Auth concurrent case creation serializes the last service quantity and replays once',async()=>{
 const sameCase=await fixture('quantity-same','BIOPLEX_LAB');
 const sameIntent=sameCase.intent('SAMPLE_RECEIVED');
 const firstPair=await Promise.all([sameCase.sales.call(sameIntent),sameCase.sales.call(sameIntent)]);
 assert.deepEqual(firstPair.map(r=>r.status).sort(),['already-applied','committed']);
 assert.equal((await sameCase.record()).events.length,1);
 const f=await fixture('quantity-race','BIOPLEX_LAB');
 const a=f.intent('SAMPLE_RECEIVED',0,{},'race-A');
 const b=f.intent('SAMPLE_RECEIVED',0,{},'race-B');
 const race=await Promise.allSettled([f.sales.call(a),f.sales.call(b)]);
 assert.equal(race.filter(r=>r.status==='fulfilled').length,1);
 assert.equal(race.filter(r=>r.status==='rejected'&&r.reason.code==='functions/failed-precondition').length,1);
 const winner=race[0].status==='fulfilled'?a:b;
 const key=db.doc('serviceCases/'+itemCaseIndexId(f.orderId,f.itemId));
 const index=(await key.get()).data();
 assert.deepEqual(index.caseIds,[winner.caseId]);
 const same=await Promise.all([f.sales.call(winner),f.sales.call(winner)]);
 assert.ok(same.every(r=>r.status==='already-applied'));
 await assert.rejects(f.sales.call({...winner,serviceQty:0.5}),e=>e.code==='functions/failed-precondition');
 const row=(await db.doc('serviceCases/'+caseDocId(f.orderId,f.itemId,winner.caseId)).get()).data();
 assert.equal(row.events.length,1);assert.equal(row.serviceQty,1);
 await assert.rejects(getDoc(doc(f.sales.firestore,'serviceCases',key.id)),e=>e.code==='permission-denied');
 await assert.rejects(setDoc(doc(f.sales.firestore,'serviceCases',key.id),{caseIds:[]}),e=>e.code==='permission-denied');
});
test('real Callable returns partial item completion and refuses reduced or corrupt allocations atomically',async()=>{
 const f=await fixture('quantity-partial','BIOPLEX_LAB');
 const orderRef=db.doc('orders/'+f.orderId),order=(await orderRef.get()).data();
 await orderRef.update({items:order.items.map(item=>({...item,qty:3}))});
 const first={...f.intent('SAMPLE_RECEIVED'),serviceQty:2};
 await f.sales.call(first);
 const second=f.intent('SAMPLE_RECEIVED',0,{},'second');
 await f.sales.call(second);
 await f.engineer.call({...f.intent('EXPERIMENT_COMPLETED',1),serviceQty:2});
 const report={...f.intent('REPORT_SENT',2,{reportRef:'report/partial'}),serviceQty:2};
 const done=await f.engineer.call(report);
 assert.equal(done.itemProgress.completedQty,2);assert.equal(done.itemProgress.remainingQty,1);
 assert.equal(done.itemWorkCategory,'delivery');
 const locate={orderId:f.orderId,itemId:f.itemId,caseId:f.caseId};
 const read=()=>httpsCallable(getFunctions(f.sales.app,'asia-east1'),'getServiceCaseStatus')(locate).then(r=>r.data);
 assert.equal((await read()).itemProgress.inProgressQty,1);
 const secondEvent=(type,index,details={})=>f.intent(type,index,details,'second');
 await f.engineer.call(secondEvent('EXPERIMENT_COMPLETED',1));
 const complete=await f.engineer.call(secondEvent('REPORT_SENT',2,{reportRef:'report/last'}));
 assert.equal(complete.itemWorkCategory,'billing');assert.equal(complete.itemProgress.completedQty,3);
 await orderRef.update({isBilled:true}); // Explicit fixture: billing writer integration is a later phase.
 assert.equal((await read()).itemWorkCategory,'complete');
 await orderRef.update({isBilled:false});
 const original=await f.record();
 await orderRef.update({items:order.items.map(item=>({...item,qty:2}))});
 await assert.rejects(f.engineer.call(report),e=>e.code==='functions/failed-precondition');
 assert.deepEqual(await f.record(),original);
 await orderRef.update({items:order.items.map(item=>({...item,qty:3}))});
 const linked=db.doc('serviceCases/'+caseDocId(f.orderId,f.itemId,'second'));
 await linked.delete(); // deliberate isolated fixture corruption
 await assert.rejects(read(),e=>e.code==='functions/failed-precondition');
 await assert.rejects(f.engineer.call(report),e=>e.code==='functions/failed-precondition');
 assert.deepEqual(await f.record(),original);
 assert.equal((await orderRef.get()).data().isDelivered,undefined);
});

test('real item query advertises only writable service actions and preserves history after master changes',async()=>{
 const f=await fixture('read-eligibility','BIOPLEX_LAB');
 const itemQuery={orderId:f.orderId,itemId:f.itemId};
 const read=who=>httpsCallable(getFunctions(who.app,'asia-east1'),'getServiceCaseStatus')(itemQuery).then(r=>r.data);
 assert.equal((await read(f.sales)).canStart,true);
 await f.sales.call(f.intent('SAMPLE_RECEIVED'));
 assert.equal((await read(f.sales)).canStart,false);
 assert.equal((await read(f.engineer)).cases[0].canAdvance,true);
 const productRef=db.doc('products/'+f.productId),original=(await productRef.get()).data();
 const saved=await f.record();
 for(const patch of [{active:false},{serviceKind:'ONSITE_REPAIR'},null]){
   if(patch===null)await productRef.delete();
   else await productRef.set({...original,...patch});
   const history=await read(f.engineer);
   assert.equal(history.kind,'BIOPLEX_LAB');assert.equal(history.canStart,false);
   assert.equal(history.cases[0].canAdvance,false);
   assert.equal(history.cases[0].custody,'IN_HOUSE');
   await assert.rejects(f.engineer.call(f.intent('EXPERIMENT_COMPLETED',1)),
     e=>e.code==='functions/failed-precondition');
 }
 assert.deepEqual(await f.record(),saved);
 await productRef.set(original);
 assert.equal((await read(f.engineer)).cases[0].canAdvance,true);
 assert.equal((await f.engineer.call(f.intent('EXPERIMENT_COMPLETED',1))).nextEvent,'REPORT_SENT');
});
