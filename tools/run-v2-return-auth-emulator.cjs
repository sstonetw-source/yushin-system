#!/usr/bin/env node
'use strict';
// Creates an isolated Emulator configuration; never changes the deployment entry.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
// Local iteration may select a layer. CI deliberately calls with no arguments.
const suites={
 all:['tests/emulator-order-transfer-callable.cjs','tests/emulator-custody-lifecycle.cjs','tests/emulator-custody-shipment.cjs','tests/emulator-v2-return-callable.cjs','tests/emulator-receiving-fifteen.cjs','tests/emulator-v2-lifecycle-browser.cjs'],
 callable:['tests/emulator-order-transfer-callable.cjs','tests/emulator-custody-lifecycle.cjs','tests/emulator-custody-shipment.cjs','tests/emulator-v2-return-callable.cjs','tests/emulator-receiving-fifteen.cjs'],
 receiving:['tests/emulator-receiving-fifteen.cjs'],
 browser:['tests/emulator-v2-lifecycle-browser.cjs']
};
const args=process.argv.slice(2),selection=args.filter(arg=>arg.startsWith('--suite='));
const patterns=args.filter(arg=>arg.startsWith('--test-name-pattern='));
const pattern=patterns[0]?.slice('--test-name-pattern='.length);
const suite=selection[0]?.slice('--suite='.length)||'all';
if(selection.length>1||patterns.length>1||patterns.some(arg=>arg==='--test-name-pattern=')||!Object.hasOwn(suites,suite)
 ||args.some(arg=>arg!=='--list'&&!arg.startsWith('--suite=')&&!arg.startsWith('--test-name-pattern='))
 ||selection.some(arg=>arg==='--suite=')){
 console.error('Usage: node tools/run-v2-return-auth-emulator.cjs [--suite=all|callable|receiving|browser] [--test-name-pattern=regex] [--list]');
 process.exit(2);
}
const testFiles=suites[suite].map(file=>path.join(root,file));
if(args.includes('--list')){console.log(testFiles.join('\n'));process.exit(0);}
if(suite!=='all'||pattern)console.log('Development subset only: '+suite+'; full CI is still required before merge.');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'yushin-return-auth-'));
const source=path.join(temporary,'functions');
try{
 fs.mkdirSync(source);
 fs.writeFileSync(path.join(source,'checkout.json'),JSON.stringify({root}));
 fs.writeFileSync(path.join(source,'.env.local'),
  'ENABLE_ORDER_TRANSFER_HANDOFF_EMULATOR=true\nENABLE_ORDER_TRANSFER_V2_EMULATOR=true\nENABLE_ORDER_TRANSFER_DISPATCH_EMULATOR=true\nENABLE_ORDER_TRANSFER_RECEIVE_EMULATOR=true\nENABLE_V3_CUSTODY_LIFECYCLE_EMULATOR=true\nENABLE_V3_CUSTODY_SHIPMENT_EMULATOR=true\nENABLE_V3_CUSTODY_DELIVERY_EMULATOR=true\nENABLE_V2_RETURN_AUTH_EMULATOR=true\nENABLE_V2_RETURN_REQUEST_AUTH_EMULATOR=true\nENABLE_V2_SHIPMENT_AUTH_EMULATOR=true\nENABLE_V2_LIFECYCLE_AUTH_EMULATOR=true\nENABLE_SERVICE_CASE_EMULATOR=true\nENABLE_PREVIEW_FORMAL_PURCHASE=true\nENABLE_QUICK_PURCHASE_EMULATOR=true\n');
 const runtime=path.join(root,'functions/node_modules');
 if(!fs.existsSync(path.join(runtime,'firebase-functions')))throw Error('Install functions dependencies before running the Emulator');
 fs.symlinkSync(runtime,path.join(source,'node_modules'),'dir');
 fs.copyFileSync(path.join(root,'tests/fixtures/v2-return-auth-functions.cjs'),path.join(source,'index.js'));
 const manifest=JSON.parse(fs.readFileSync(path.join(root,'functions/package.json'),'utf8'));
 fs.writeFileSync(path.join(source,'package.json'),JSON.stringify({...manifest,main:'index.js'}));
 const config=path.join(temporary,'firebase.json');
 fs.writeFileSync(config,JSON.stringify({functions:{source:'functions',runtime:'nodejs22'},
  firestore:{rules:path.join(root,'firestore.rules'),indexes:path.join(root,'firestore.indexes.json')},
  emulators:{firestore:{port:8080},auth:{port:9099},functions:{port:5001},ui:{enabled:false}}}));
 const shellQuote=value=>"'"+value.split("'").join("'"+String.fromCharCode(92)+"''")+"'";
 const result=spawnSync('npx',['--yes','firebase-tools@15','emulators:exec','--config',config,
  '--only','firestore,auth,functions','--project','demo-yushin',
  'node --test --test-concurrency=1 '+(pattern?'--test-name-pattern='+shellQuote(pattern)+' ':'')+testFiles.map(shellQuote).join(' ')],{cwd:root,stdio:'inherit',env:{...process.env,
   ENABLE_ORDER_TRANSFER_HANDOFF_EMULATOR:'true',ENABLE_ORDER_TRANSFER_V2_EMULATOR:'true',ENABLE_ORDER_TRANSFER_DISPATCH_EMULATOR:'true',ENABLE_ORDER_TRANSFER_RECEIVE_EMULATOR:'true',ENABLE_V3_CUSTODY_LIFECYCLE_EMULATOR:'true',ENABLE_V3_CUSTODY_SHIPMENT_EMULATOR:'true',ENABLE_V3_CUSTODY_DELIVERY_EMULATOR:'true',ENABLE_V2_RETURN_AUTH_EMULATOR:'true',ENABLE_V2_RETURN_REQUEST_AUTH_EMULATOR:'true',ENABLE_V2_SHIPMENT_AUTH_EMULATOR:'true',ENABLE_V2_LIFECYCLE_AUTH_EMULATOR:'true',ENABLE_SERVICE_CASE_EMULATOR:'true',
   ENABLE_PREVIEW_FORMAL_PURCHASE:'true',ENABLE_QUICK_PURCHASE_EMULATOR:'true'}});
 if(result.error)throw result.error;
 process.exitCode=result.status??1;
}finally{fs.rmSync(temporary,{recursive:true,force:true});}
