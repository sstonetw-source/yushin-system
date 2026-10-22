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
const {caseDocId}=require('../functions/service-case-service');
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
 const intent=(type,index=0,details={},cid=caseId)=>({orderId,itemId,caseId:cid,
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
 assert.equal((await db.collection('inventory').get()).empty,true);
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
