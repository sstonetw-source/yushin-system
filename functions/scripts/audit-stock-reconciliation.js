'use strict';
// Run with existing ADC identity. No writes, no deployment, no use of production test data.
const {auditStockReconciliation}=require('../stock-reconciliation-audit');
function readArguments(argv,env=process.env){
 if(argv.length!==1||argv[0]!=='--project=yu-shing-company')throw Error('Explicit production project required');
 if(env.FIRESTORE_EMULATOR_HOST||env.FUNCTIONS_EMULATOR)throw Error('Emulator/production mismatch');
 return {project:'yu-shing-company'};
}
async function main(){
 const {project}=readArguments(process.argv.slice(2));
 const {initializeApp,applicationDefault,deleteApp}=require('firebase-admin/app');
 const {getFirestore}=require('firebase-admin/firestore');
 const app=initializeApp({projectId:project,credential:applicationDefault()});
 try{
  const result=await auditStockReconciliation(getFirestore(app));
  process.stdout.write(JSON.stringify({project,mode:'READ_ONLY',...result},null,2)+'\n');
  if(result.status!=='CONSISTENT')process.exitCode=2;
 }finally{await deleteApp(app);}
}
if(require.main===module)main().catch(()=>{
 process.stderr.write('Read-only stock reconciliation failed. Check ADC, project permissions and connectivity. No writes occurred.\n');
 process.exitCode=1;
});
module.exports={readArguments};
