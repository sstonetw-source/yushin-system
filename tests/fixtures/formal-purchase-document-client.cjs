'use strict';
// SDK adapter only. Use the shipped document Service with real Client Rules;
// creating a PO document never creates supply, incoming or receipt facts.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {getFirestore,connectFirestoreEmulator,doc,runTransaction}=require('firebase/firestore');
function formalPurchaseDocumentClient(app,uid,role){
 if(app.options.projectId!=='demo-yushin'||process.env.FIRESTORE_EMULATOR_HOST!=='127.0.0.1:8080')
  throw Error('PO document fixture only permits demo-yushin Emulator');
 const live=getFirestore(app);connectFirestoreEmulator(live,'127.0.0.1',8080);
 const plain=value=>JSON.parse(JSON.stringify(value));
 const context=vm.createContext({currentUser:{uid},currentUserRole:role,
  canCreatePurchaseOrderCapability:()=>['admin','purchaser'].includes(role),
  canAccessPage:page=>page==='orders.po'&&['admin','purchaser'].includes(role),
  db:{collection:name=>({doc:id=>doc(live,name,id)})},
  runRoleTransaction:callback=>runTransaction(live,async tx=>callback({
   get:async ref=>{const snapshot=await tx.get(ref);return {exists:snapshot.exists(),data:()=>snapshot.data()};},
   set:(ref,value)=>tx.set(ref,plain(value))
  }))});
 const source=fs.readFileSync(path.join(__dirname,'../../src/services/formal-purchase-order.js'),'utf8');
 const end=source.indexOf('// Authoritative PO,');
 if(end<0)throw Error('PO document source boundary changed');
 vm.runInContext(source.slice(0,end),context);
 return {save:record=>context.saveFormalPurchaseDocument(record,{actorUid:uid,actorRole:role})};
}
module.exports={formalPurchaseDocumentClient};
