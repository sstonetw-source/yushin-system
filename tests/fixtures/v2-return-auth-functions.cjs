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
module.exports=require(path.join(root,'functions/v2-return-callable-adapter')).createV2ReturnCallables({
 onCall,HttpsError,getDatabase:getFirestore});
