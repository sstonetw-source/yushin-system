'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync('src/services/service-cases.js','utf8');
const input={orderId:'O',itemId:'I',action:'EXECUTE'};
function fixture(){
 const options={projectId:'yu-shing-company'};
 const context=vm.createContext({
  currentUser:{uid:'U'},currentUserRole:'purchaser',sessionDataGeneration:1,
  location:{origin:'https://sstonetw-source.github.io',pathname:'/yushin-system/'},
  YUSHIN_PRODUCTION_SERVICE_CASE_BACKEND:true,
  db:{app:{options}},
  firebase:{functions:true,auth:()=>({app:{options},currentUser:{uid:'U'}}),
   app:()=>({functions:()=>({app:{options},httpsCallable:name=>async payload=>({data:{name,...payload}})})})}
 });
 vm.runInContext(source,context);
 return context;
}
test('service order Callable transport requires the authorized site and matching projects',async()=>{
 const c=fixture();
 const call=()=>c.serviceCaseTransport().call('commitOrderServiceAction',input);
 assert.deepEqual(await call(),{name:'commitOrderServiceAction',...input});
 c.db.app.options={projectId:'preview-20135'};
 await assert.rejects(async()=>call(),/專案不一致/);
 c.location.pathname='/another-site/';
 await assert.rejects(async()=>call(),/尚未在目前環境啟用/);
});
test('service order Callable transport refuses a stale session before submitting',async()=>{
 const c=fixture(),transport=c.serviceCaseTransport();
 c.sessionDataGeneration++;
 await assert.rejects(transport.call('commitOrderServiceAction',input),/登入身分/);
});
