const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync(require('node:path').join(__dirname,'../modules/document-downloads.js'),'utf8');
function setup(){
 const records=new Map(),calls=[],existing=new Set(['quote.pdf']);
 const folder={name:'Reports',queryPermission:async()=> 'granted',requestPermission:async()=> 'granted',getFileHandle:async(name,options)=>{
  if(!options&&!existing.has(name))throw Object.assign(new Error(),{name:'NotFoundError'});
  if(options)calls.push(['create',name]);
  return {createWritable:async()=>({write:async blob=>calls.push(['write',blob]),close:async()=>calls.push(['close']),abort:async()=>calls.push(['abort'])})};
 }};
 const indexedDB={open(){const request={};queueMicrotask(()=>{request.result={close(){},transaction(){const tx={objectStore(){return {get:key=>op(()=>records.get(key)),put:(handle,key)=>op(()=>records.set(key,handle)),delete:key=>op(()=>records.delete(key))}}};function op(fn){const r={result:fn()};queueMicrotask(()=>tx.oncomplete());return r;}return tx;}};request.onsuccess();});return request;}};
 const root={indexedDB,showDirectoryPicker:async()=>folder,document:{querySelectorAll:()=>[]}};
 vm.runInNewContext(source,{window:root});
 const pdf={save:name=>calls.push(['fallback',name]),output:()=> 'BLOB'};
 return {api:root.DocumentDownloads,folder,records,calls,pdf,root};
}
test('quote folder persists per user; purchase remains default',async()=>{const x=setup();await x.api.setUser('A');await x.api.choose('quote');assert.ok(x.records.has('A||quote'));await x.api.savePdf('purchase',x.pdf,'po.pdf');assert.deepEqual(x.calls,[['fallback','po.pdf']]);});
test('configured PDF writes and closes, preserving existing file names',async()=>{const x=setup();await x.api.setUser('A');await x.api.choose('quote');await x.api.prepare('quote');await x.api.savePdf('quote',x.pdf,'quote.pdf');assert.deepEqual(x.calls,[['create','quote (1).pdf'],['write','BLOB'],['close']]);});
test('switching users prevents destination reuse, restoring prior user restores folder',async()=>{const x=setup();await x.api.setUser('A');await x.api.choose('quote');await x.api.setUser('B');await x.api.savePdf('quote',x.pdf,'b.pdf');assert.equal(x.calls[0][0],'fallback');await x.api.setUser('A');await x.api.savePdf('quote',x.pdf,'a.pdf');assert.ok(x.calls.some(c=>c[0]==='create'));});
test('reset removes persisted folder and restores default download',async()=>{const x=setup();await x.api.setUser('A');await x.api.choose('quote');await x.api.reset('quote');assert.equal(x.records.has('A||quote'),false);await x.api.savePdf('quote',x.pdf,'q.pdf');assert.equal(x.calls[0][0],'fallback');});
test('revoked permission blocks writing, and permission denial is actionable',async()=>{const x=setup();await x.api.setUser('A');await x.api.choose('quote');x.folder.queryPermission=async()=> 'prompt';x.folder.requestPermission=async()=> 'denied';await assert.rejects(x.api.prepare('quote'),/權限/);await assert.rejects(x.api.savePdf('quote',x.pdf,'q.pdf'),/權限/);assert.equal(x.calls.length,0);});
test('write failure aborts output and is not reported as success',async()=>{const x=setup();await x.api.setUser('A');await x.api.choose('quote');x.folder.getFileHandle=async(name,options)=>{if(!options)throw Object.assign(new Error(),{name:'NotFoundError'});return {createWritable:async()=>({write:async()=>{throw new Error('disk full');},abort:async()=>x.calls.push(['abort'])})};};await assert.rejects(x.api.savePdf('quote',x.pdf,'q.pdf'),/disk full/);assert.deepEqual(x.calls,[['abort']]);});
test('unsupported browsers retain PDF export',async()=>{const x=setup();delete x.root.showDirectoryPicker;await x.api.setUser('A');await x.api.prepare('quote');await x.api.savePdf('quote',x.pdf,'q.pdf');assert.equal(x.calls[0][0],'fallback');await assert.rejects(x.api.choose('quote'),/不支援/);});
function shareSetup(){
 const x=setup(),nodes=[];
 function element(tag){const el={tag,children:[],appendChild(child){this.children.push(child);},append(...children){this.children.push(...children);},setAttribute(){},addEventListener(type,fn){this[type]=fn;},showModal(){this.open=true;},close(){this.open=false;},remove(){this.removed=true;}};nodes.push(el);return el;}
 x.root.document.createElement=element;x.root.document.body=element('body');
 x.root.File=class {constructor(parts,name,options){this.parts=parts;this.name=name;this.type=options.type;}};
 x.root.navigator={canShare:()=>true,share:async payload=>x.calls.push(['share',payload])};
 x.nodes=nodes;x.find=label=>nodes.find(el=>el.textContent===label);
 return x;
}
test('file sharing waits for a fresh click and sends only a named PDF file',async()=>{
 const x=shareSetup();const saved=x.api.savePdf('quote',x.pdf,'報價.pdf');await new Promise(resolve=>setImmediate(resolve));
 assert.equal(x.calls.length,0);await x.find('分享 PDF 文件').onclick();assert.equal(await saved,true);
 const payload=x.calls[0][1];assert.deepEqual(Object.keys(payload),['files']);assert.equal(payload.files[0].name,'報價.pdf');assert.equal(payload.files[0].type,'application/pdf');
 assert.equal(x.nodes.find(el=>el.tag==='dialog').removed,true);
});
test('cancelled native sharing allows retry and download; prevents repeated submissions',async()=>{
 const x=shareSetup();let rejectShare;x.root.navigator.share=()=>new Promise((_,reject)=>{rejectShare=reject;});
 const saved=x.api.savePdf('quote',x.pdf,'quote.pdf');await new Promise(resolve=>setImmediate(resolve));
 const sharing=x.find('分享 PDF 文件').onclick();assert.equal(x.find('分享 PDF 文件').disabled,true);
 await x.find('分享 PDF 文件').onclick();rejectShare(Object.assign(new Error(),{name:'AbortError'}));await sharing;
 assert.equal(x.find('分享 PDF 文件').disabled,false);assert.equal(x.nodes.find(el=>el.tag==='dialog').open,true);
 x.find('下載 PDF').onclick();assert.equal(await saved,true);assert.deepEqual(x.calls,[['fallback','quote.pdf']]);
});
test('closing the export dialog is not reported as successful export',async()=>{
 const x=shareSetup();const saved=x.api.savePdf('purchase',x.pdf,'po.pdf');await new Promise(resolve=>setImmediate(resolve));
 x.find('關閉').onclick();assert.equal(await saved,false);assert.equal(x.calls.length,0);
});
test('browsers unable to share files keep the default PDF download',async()=>{
 const x=shareSetup();x.root.navigator.canShare=()=>false;assert.equal(await x.api.savePdf('quote',x.pdf,'q.pdf'),true);assert.deepEqual(x.calls,[['fallback','q.pdf']]);
});
