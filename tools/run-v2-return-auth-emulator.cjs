#!/usr/bin/env node
'use strict';
// Creates an isolated Emulator configuration; never changes the deployment entry.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),temporary=fs.mkdtempSync(path.join(os.tmpdir(),'yushin-return-auth-'));
const source=path.join(temporary,'functions');
try{
 fs.mkdirSync(source);
 fs.writeFileSync(path.join(source,'checkout.json'),JSON.stringify({root}));
 fs.writeFileSync(path.join(source,'.env.local'),'ENABLE_V2_RETURN_AUTH_EMULATOR=true\n');
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
 const testFile=path.join(root,'tests/emulator-v2-return-callable.cjs');
 const shellQuote=value=>"'"+value.split("'").join("'"+String.fromCharCode(92)+"''")+"'";
 const result=spawnSync('npx',['--yes','firebase-tools@15','emulators:exec','--config',config,
  '--only','firestore,auth,functions','--project','demo-yushin',
  'node --test '+shellQuote(testFile)],{cwd:root,stdio:'inherit',env:{...process.env,
   ENABLE_V2_RETURN_AUTH_EMULATOR:'true'}});
 if(result.error)throw result.error;
 process.exitCode=result.status??1;
}finally{fs.rmSync(temporary,{recursive:true,force:true});}
