'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const vm=require('node:vm');
const script=fs.readFileSync(path.join(__dirname,'../functions/scripts/one-time-operational-reset.js'),'utf8');
// Unit-test pure argument and journal logic without importing Admin SDK or touching Firestore.
const start=script.indexOf('function readArguments(argv) {');
const end=script.indexOf('async function eachStockPage(',start);
assert.ok(start>=0&&end>start);
const ctx={fs,path};
vm.runInNewContext("const ALLOWED_PROJECTS = new Set(['yu-shing-company','preview-20135']);\n"+script.slice(start,end)+'\nthis.resetHelpers={readArguments,readJournal,saveJournal};',ctx);
const {readArguments,readJournal,saveJournal}=ctx.resetHelpers;

test('operational reset remains dry-run by default and locks the exact default database',()=>{
 const args=readArguments(['--project=yu-shing-company']);
 assert.equal(args.execute,false);
 assert.equal(args.database,'(default)');
 assert.throws(()=>readArguments(['--project=another-project']),/approved/);
 assert.throws(()=>readArguments(['--project=yu-shing-company','--database=alternate']),/default/);
});
test('execution requires explicit project-bound journal, frozen writers, and exact confirmation',()=>{
 const pathName='/operations/yu-shing-company-reset.json';
 const flags=['--project=yu-shing-company','--journal='+pathName,'--execute',
  '--skip-backup','--writes-frozen','--confirm=DELETE-OLD-OPERATIONS:yu-shing-company'];
 assert.equal(readArguments(flags).execute,true);
 for(const omitted of ['--journal='+pathName,'--writes-frozen','--skip-backup']){
  assert.throws(()=>readArguments(flags.filter(x=>x!==omitted)),/Execute requires/);
 }
 assert.throws(()=>readArguments([...flags,'--database=other']),/default/);
 assert.throws(()=>readArguments(flags.map(x=>x==='--journal='+pathName?'--journal=relative.json':x)),/absolute/);
});
test('journal is durable, project-scoped and rejects invalid resume states',()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'yushin-reset-journal-'));
 const filename=path.join(directory,'yu-shing-company-reset.json');
 try{
  const entry={project:'yu-shing-company',database:'(default)',status:'IN_PROGRESS',
   stage:'PREFLIGHT',completedDeletes:['orders'],preserveRootDocumentCounts:{users:2},stockProgress:{}};
  saveJournal(filename,entry);
  const saved=readJournal(filename,'yu-shing-company');
  assert.equal(saved.completedDeletes[0],'orders');
  assert.equal(saved.status,'IN_PROGRESS');
  assert.equal(fs.existsSync(filename+'.pending'),false);
  assert.throws(()=>readJournal(filename,'preview-20135'),/mismatch/);
  saveJournal(filename,{...entry,status:'VERIFIED'});
  assert.equal(readJournal(filename,'yu-shing-company').status,'VERIFIED');
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
test('script never auto-runs a destructive operation when imported',()=>{
 assert.match(script,/if \(require\.main === module\)/);
 assert.match(script,/readJournal\(args\.journal, args\.project\)/);
 assert.match(script,/fs\.openSync\(lockFile, 'wx'/);
 assert.match(script,/await db\.recursiveDelete/);
 assert.match(script,/await verify\(db, journal\.preserveRootDocumentCounts\)/);
});
