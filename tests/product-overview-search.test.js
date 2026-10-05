const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const src=fs.readFileSync(require('node:path').join(__dirname,'../app.js'),'utf8');
const code=src.slice(src.indexOf('let productOverviewCursor=null'),src.indexOf('window.renderProductManagementOverview ='));
test('keyword search reaches later pages and retains only matches, while ordinary browsing reads one page',async()=>{
 for(const keyword of ['target','']){
  let reads=0;const scope={value:'',options:[],innerHTML:''},status={textContent:''};
  const pages=[Array.from({length:200},(_,i)=>({id:'p'+i,data:()=>({productName:'Other'})})),[{id:'later',data:()=>({productName:'Target kit'})}]];
  const query={orderBy(){return this},limit(){return this},startAfter(){return this},get:async()=>{const docs=pages[reads++];return {docs,size:docs.length}}};
  const c=vm.createContext({window:{},currentUserRole:'admin',currentUser:{uid:'u'},productOverviewLoading:false,productManagementOverviewRows:[],productOverviewLimit:200,
   document:{getElementById:id=>id==='productOverviewScope'?scope:id==='productOverviewSearch'?{value:keyword}:status},db:{collection:()=>query},firebase:{firestore:{FieldPath:{documentId:()=>''}}},firestoreReadWithTimeout:async p=>p,getUnifiedBrandEntries:()=>[],escapeAttr:x=>x,escapeHtml:x=>x,renderProductManagementOverview:()=>{}});
  vm.runInContext(code,c);await c.window.loadProductManagementOverview(true);
  assert.equal(reads,keyword?2:1);assert.equal(c.productManagementOverviewRows.length,keyword?1:200);if(keyword)assert.equal(c.productManagementOverviewRows[0].id,'later');
 }
});
