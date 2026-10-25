'use strict';
// SDK adapter only. The actual src Service and Client Rules remain the writers.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {getFirestore,connectFirestoreEmulator,doc,runTransaction}=require('firebase/firestore');
function orderCreationClient(app,uid,role){
 if(app.options.projectId!=='demo-yushin'||!/^127\.0\.0\.1:8080$/.test(process.env.FIRESTORE_EMULATOR_HOST||''))
  throw Error('Client creation fixture only permits demo-yushin Emulator');
 const live=getFirestore(app);connectFirestoreEmulator(live,'127.0.0.1',8080);
 const plain=value=>JSON.parse(JSON.stringify(value));
 const context=vm.createContext({currentUser:{uid},currentUserRole:role,BUSINESS_STATUS:{ACTIVE:'active'},YushinOrderEntry:require('../../modules/order-entry-core'),
  db:{collection:name=>({doc:id=>doc(live,name,id)})},
  runRoleTransaction:callback=>runTransaction(live,async transaction=>callback({
   get:async ref=>{const snapshot=await transaction.get(ref);return {exists:snapshot.exists(),data:()=>snapshot.data()};},
   set:(ref,value,options)=>options?transaction.set(ref,plain(value),options):transaction.set(ref,plain(value)),
   update:(ref,value)=>transaction.update(ref,plain(value))
  }))});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../../src/services/order-creation.js'),'utf8'),context);
 return {create:(id,data)=>context.commitOrderCreation(id,data,{actorUid:uid,actorRole:role})};
}
module.exports={orderCreationClient};
