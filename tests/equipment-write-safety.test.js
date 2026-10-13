const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const app=fs.readFileSync('app.js','utf8');
const source=app.slice(app.indexOf('window.saveEquipmentFromModal = async function'),app.indexOf('function loadEquipmentFromCloudThenReopen'));
function database(){
  const docs=new Map(),writes=[];let seq=0,tail=Promise.resolve(),fail=false,hold=null;
  const ref=id=>({id:id||'EQ'+(++seq),path:'equipment/'+id,update:async patch=>{if(fail)throw Error('network');docs.set(id,{...docs.get(id),...patch});writes.push(patch);}});
  const db={collection:()=>({doc:ref}),runTransaction:fn=>{
    const p=tail.then(async()=>{if(hold)await hold;if(fail)throw Error('network');const pending=[];
      await fn({get:async r=>({exists:docs.has(r.id),data:()=>structuredClone(docs.get(r.id))}),
        set:(r,d)=>pending.push([r.id,d]),update:(r,d)=>pending.push([r.id,{...docs.get(r.id),...d}])});
      pending.forEach(([id,data])=>{docs.set(id,data);writes.push(data);});});tail=p.catch(()=>{});return p;
  }};
  return {db,docs,writes,setFail:v=>fail=v,setHold:v=>hold=v};
}
function context(storage,{id=null,logs=[]}={}){
  let seq=0;const nodes={},alerts=[];
  const values={eqCustomer:'客戶',eqModel:'M1',eqBrand:'Roche',eqSales:'工程師',eqCycle:'12',eqLogDate:'2026-10-13',eqLogType:'維修',eqLogTech:'工程師',eqLogDesc:'紀錄'};
  for(const name of [...Object.keys(values),'eqModalOverlay','eqSaveHint','eqSaveBtn','eqAddLogBtn','eqSerial','eqLocation','eqInstallDate','eqLastService','eqNoMaintenance','eqNotes'])nodes[name]={value:values[name]||'',dataset:{},checked:false,textContent:'儲存'};
  nodes.eqModalOverlay.dataset.editId=id||'';
  const local=id?[{id,model:'M1',logs:structuredClone(logs)}]:[];
  const c=vm.createContext({window:{},document:{getElementById:id=>nodes[id]},equipmentList:local,currentEquipmentId:id,
    db:storage.db,alert:s=>alerts.push(s),confirm:()=>true,currentUser:{uid:'E1',email:'e1'},currentUserName:'工程師',
    getBrandFieldValue:()=> 'Roche',customerIdForName:()=> 'C1',salesCodeForName:()=> 'E1',syncCustomerMaster:()=> 'C1',
    buildFullHistorySearchTokens:()=>[],getNextAssetId:()=> 'EQ-E1-00001',rememberRecentCustomerName:()=>{},
    loadEquipmentFromCloudThenReopen:()=>{},showActionFeedback:()=>{},writeAppDataCache:()=>{},renderEquipmentList:()=>{},
    openEquipmentModal:()=>{},closeEquipmentModal:()=>{},actionButtonFromEventOrSelector:()=>null,
    localDateString:()=> '2026-10-13',lifecycleRecordId:()=> 'log-'+(++seq),console:{error:()=>{}},
    beginActionButton:b=>{if(b){b.disabled=true;return {}; }return null;},endActionButton:b=>{if(b)b.disabled=false;}
  });c.window=c;vm.runInContext(source,c);return {c,nodes,alerts,local};
}
test('equipment double save submits once and retry reuses the same document',async()=>{
  const d=database();let release;d.setHold(new Promise(r=>release=r));const f=context(d);
  const first=f.c.saveEquipmentFromModal();const second=f.c.saveEquipmentFromModal();
  assert.equal(f.nodes.eqSaveBtn.disabled,true);await second;release();await first;
  assert.equal(d.docs.size,1);assert.equal(d.writes.length,1);assert.equal(f.nodes.eqSaveBtn.disabled,false);
  const g=context(d);d.setFail(true);await g.c.saveEquipmentFromModal();const retryId=g.nodes.eqModalOverlay.dataset.pendingCreateId;
  assert.ok(retryId);d.setFail(false);await g.c.saveEquipmentFromModal();assert.equal(g.nodes.eqModalOverlay.dataset.editId,retryId);
  assert.equal(d.docs.size,2);
});
test('two equipment editors preserve both logs using the latest transaction snapshot',async()=>{
  const d=database();d.docs.set('A',{logs:[],lastServiceDate:'2026-10-14'});
  const a=context(d,{id:'A'}),b=context(d,{id:'A'});a.nodes.eqLogDesc.value='A';b.nodes.eqLogDesc.value='B';
  b.nodes.eqLogType.value='保養';await Promise.all([a.c.addEquipmentLogFromModal(),b.c.addEquipmentLogFromModal()]);
  assert.deepEqual([...d.docs.get('A').logs].map(x=>x.desc),['A','B']);assert.equal(d.docs.get('A').lastServiceDate,'2026-10-14');
});
test('deleting a log finds its identity after another editor inserts a record',async()=>{
  const target={id:'B',date:'2026-10-13',type:'維修',desc:'B'},old={id:'A',desc:'A'};
  const d=database();d.docs.set('EQ',{logs:[{id:'NEW'},old,target]});const f=context(d,{id:'EQ',logs:[old,target]});
  await f.c.deleteEquipmentLog('EQ',1);assert.deepEqual([...d.docs.get('EQ').logs].map(x=>x.id),['NEW','A']);
});
test('failed equipment writes keep the visible data and restore controls',async()=>{
  const d=database();d.docs.set('EQ',{logs:[]});d.setFail(true);const f=context(d,{id:'EQ'});
  await f.c.addEquipmentLogFromModal();assert.equal(f.local[0].logs.length,0);assert.equal(f.nodes.eqAddLogBtn.disabled,false);
  await f.c.deleteEquipment('EQ');assert.equal(f.local.length,1);assert.equal(d.docs.get('EQ').active,undefined);
  assert.match(f.alerts[0],/EQ/);assert.match(f.alerts[0],/重試/);
});
