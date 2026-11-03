'use strict';
// Standalone read-only CLI; not exported or deployed as a Callable.
const {auditQuickPurchase,auditTarget}=require('../quick-purchase-audit');
function readArguments(argv,env=process.env){
 const options={};
 const keys={'--project':'project','--order':'orderId','--item':'itemId','--operation':'operationId'};
 for(const arg of argv){
  const index=arg.indexOf('='),key=keys[arg.slice(0,index)];
  if(index<0||!key||Object.hasOwn(options,key))throw Error('Unknown or duplicate argument');
  options[key]=arg.slice(index+1);
 }
 if(!['yu-shing-company','preview-20135','demo-yushin'].includes(options.project))throw Error('Explicit approved --project required');
 const local=value=>typeof value==='string'&&/^(localhost|127\.0\.0\.1):[0-9]+$/.test(value);
 if(options.project==='demo-yushin'?!local(env.FIRESTORE_EMULATOR_HOST):!!env.FIRESTORE_EMULATOR_HOST)
  throw Error('Emulator/project mismatch');
 auditTarget(options);return options;
}
async function main(){
 const args=readArguments(process.argv.slice(2));
 const {initializeApp,applicationDefault}=require('firebase-admin/app');
 const {getFirestore}=require('firebase-admin/firestore');
 const app=initializeApp({projectId:args.project,...(args.project==='demo-yushin'?{}:{credential:applicationDefault()})});
 try{
  const result=await auditQuickPurchase(getFirestore(app),args);
  process.stdout.write(JSON.stringify({project:args.project,...result},null,2)+'\n');
  if(result.status!=='CONSISTENT')process.exitCode=2;
 }finally{const {deleteApp}=require('firebase-admin/app');await deleteApp(app);}
}
if(require.main===module)main().catch(()=>{
 // SDK errors can contain request details. Keep credentials/business data out of output.
 process.stderr.write('Read-only audit failed. Check credentials, project access and connectivity; no purchase was submitted.\n');
 process.exitCode=1;
});
module.exports={readArguments};
