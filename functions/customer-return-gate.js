'use strict';
const {projectIdFromEnvironment}=require('./grouped-reservation-gate');
const local=value=>typeof value==='string'&&/^(localhost|127\.0\.0\.1):[0-9]+$/.test(value);
function customerReturnBackendProject(env=process.env){
 const project=projectIdFromEnvironment(env);
 if(project==='demo-yushin'&&env.ENABLE_V2_RETURN_AUTH_EMULATOR==='true'
  &&env.FUNCTIONS_EMULATOR==='true'&&local(env.FIRESTORE_EMULATOR_HOST)
  &&local(env.FIREBASE_AUTH_EMULATOR_HOST))return project;
 if(project==='preview-20135'&&env.ENABLE_PREVIEW_CUSTOMER_RETURN==='true'
  &&!env.FUNCTIONS_EMULATOR&&!env.FIRESTORE_EMULATOR_HOST&&!env.FIREBASE_AUTH_EMULATOR_HOST)return project;
 return '';
}
function assertCustomerReturnDatabase(db,env=process.env){
 const project=customerReturnBackendProject(env);
 // Preserve the existing direct-Service, local demo Firestore harness only.
 const directDemo=db.projectId==='demo-yushin'&&local(env.FIRESTORE_EMULATOR_HOST);
 if((!project||db.projectId!==project)&&!directDemo){
  const error=new Error('退貨後端僅允許已授權 Preview 或本機 demo-yushin Emulator');
  error.code='failed-precondition';throw error;
 }
}
module.exports={customerReturnBackendProject,assertCustomerReturnDatabase};
