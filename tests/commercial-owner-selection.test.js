const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('app.js','utf8');
function fn(name){const start=source.indexOf('function '+name+'(');assert.ok(start>=0,name);return source.slice(start,source.indexOf('\n}',start)+2);}
class Option {
 constructor(text='',value=''){this.text=text;this.value=value;this.dataset={};}
}
function fixture(role='admin',uid='boss',code='B1',name='同名主管'){
 const select={options:[],selectedIndex:-1,disabled:false,
  get value(){return this.options[this.selectedIndex]?.value||'';},set value(v){this.selectedIndex=this.options.findIndex(x=>x.value===v);},
  get selectedOptions(){return this.selectedIndex<0?[]:[this.options[this.selectedIndex]];},
  replaceChildren(...rows){this.options=rows;this.selectedIndex=rows.length?0:-1;},add(row){this.options.push(row);},appendChild(row){this.add(row);}};
 const phone={innerText:''},fields={salesName:select,salesPhone:phone,quoteNo:{value:'Q1'},grandTotal:{innerText:'0'}};
 const people=[{uid:'boss',code:'B1',name:'同名主管',role:'admin',phone:'111'},
  {uid:'boss2',code:'B2',name:'同名主管',role:'admin',phone:'222'},
  {uid:'system',code:'',name:'純管理',role:'admin'},
  {uid:'sales1',code:'S01',name:'業務',role:'sales'},
  {uid:'eng1',code:'E01',name:'工程師',role:'engineer'},
  {uid:'off',code:'OFF',name:'已停用',role:'sales',disabled:true},
  {uid:'buyer1',code:'P01',name:'採購',role:'purchaser'}];
 const context=vm.createContext({window:{},Option,currentUserRole:role,currentUser:{uid},currentUserCode:code,currentUserName:name,currentUserPhone:'999',salesList:people,
  editingQuoteNo:'',restoringQuoteDraft:false,currentCompany:'yushin',generateQuoteNo:()=>{},updateQuoteEditingBanner:()=>{},
  document:{getElementById:id=>fields[id]||(fields[id]={value:'',innerText:''}),createElement:()=>new Option(),querySelectorAll:()=>[]},
  stripPhoneSuffix:x=>x||'',productIdsFromItems:()=>[],commercialCreatorFields:()=>({createdByUid:uid,createdByRole:role}),linkedDocumentFields:()=>({})});
 vm.runInContext(fn('isSelectableCommercialOwner')+'\nlet loadedQuoteOwnerIdentity=null;\n'+['quotePersonFromIdentity','quoteOwnerFromSelection','setQuoteOwnerSelection','populateSalesDropdown','updateSalesPhoneDisplay','setQuoteEditingContext','collectCurrentQuoteRecord'].map(fn).join('\n'),context);
 return {context,select,phone,fields,people};
}

test('administrator with business identity is selectable; system-only and inactive accounts are excluded',()=>{
 const f=fixture();f.context.populateSalesDropdown();
 assert.deepEqual(f.select.options.map(x=>x.value),['','boss','boss2','sales1','eng1']);
 assert.equal(f.select.value,'boss');
 assert.equal(f.context.quoteOwnerFromSelection().salesCode,'B1');
});
test('same-name owners are resolved by UID through quote collection and phone display',()=>{
 const f=fixture();f.context.populateSalesDropdown();f.select.value='boss2';f.context.updateSalesPhoneDisplay();
 const record=f.context.collectCurrentQuoteRecord();
 assert.equal(record.ownerUid,'boss2');assert.equal(record.salesCode,'B2');assert.equal(record.salesName,'同名主管');
 assert.equal(record.createdByUid,'boss');assert.equal(record.createdByRole,'admin');assert.equal(f.phone.innerText,'222');
});
test('engineer and sales select only self; blank printed names retain the real owner',()=>{
 for(const [role,uid,code,name]of [['engineer','eng1','E01','工程師'],['sales','sales1','S01','業務']]){
  const f=fixture(role,uid,code,name);f.context.populateSalesDropdown();
  assert.deepEqual(f.select.options.map(x=>x.value),['',uid]);
  assert.equal(f.select.value,uid);f.select.value='';
  const record=f.context.collectCurrentQuoteRecord();assert.equal(record.ownerUid,uid);assert.equal(record.salesCode,code);assert.equal(record.salesName,'');
 }
});
test('historical owner survives profile disablement and cannot be silently replaced during quote editing',()=>{
 const f=fixture();f.context.populateSalesDropdown();
 f.context.setQuoteOwnerSelection({ownerUid:'retired',salesCode:'R1',salesName:'原負責人'},true);
 f.context.setQuoteEditingContext('Q-old');
 f.select.value='boss2';
 const record=f.context.collectCurrentQuoteRecord();
 assert.equal(record.ownerUid,'retired');assert.equal(record.salesCode,'R1');assert.equal(record.salesName,'原負責人');assert.equal(f.select.disabled,true);
 f.context.setQuoteEditingContext('');f.context.populateSalesDropdown();assert.equal(f.select.disabled,false);
});
test('purchaser may assign an administrator while recording the purchaser as creator',()=>{
 const f=fixture('purchaser','buyer1','P01','採購');f.context.populateSalesDropdown();assert.equal(f.select.value,'');
 f.select.value='boss';const record=f.context.collectCurrentQuoteRecord();
 assert.equal(record.ownerUid,'boss');assert.equal(record.salesCode,'B1');assert.equal(record.createdByUid,'buyer1');assert.equal(record.createdByRole,'purchaser');
});
test('a UID-bearing draft cannot be reassigned by duplicate name or missing old profile',()=>{
 const f=fixture();f.context.window._pendingQuoteOwnerIdentity={ownerUid:'missing',salesCode:'X',salesName:'同名主管'};
 f.context.populateSalesDropdown();assert.equal(f.select.value,'');
});

test('editing preserves both existing creator metadata and its legacy absence without changing ownership',async()=>{
 for(const audit of [{createdByUid:'old-creator',createdByName:'原建立人',createdByRole:'sales'},{}]){
  const existing={ownerUid:'retired',salesCode:'R1',salesName:'原負責人',createdAt:'old-date',...audit};let written;
  const candidate={quoteNo:'Q',ownerUid:'replacement',salesCode:'NEW',salesName:'新負責人',createdByUid:'buyer1',createdByName:'新建立人',createdByRole:'purchaser'};
  const context=vm.createContext({editingQuoteNo:'Q',sessionDataGeneration:0,canUseQuote:()=>false,DOCUMENT_TYPES:{FORECAST:'forecast'},buildFullHistorySearchTokens:()=>[],
   db:{collection:()=>({doc:()=>({})})},
   runRoleTransaction:async callback=>callback({get:async()=>({exists:true,data:()=>existing}),set:(_ref,data)=>{written={...data};}})});
  vm.runInContext(fn('persistQuoteOutputRecord'),context);await context.persistQuoteOutputRecord(candidate);
  assert.equal(written.ownerUid,'retired');assert.equal(written.salesCode,'R1');assert.equal(written.salesName,'原負責人');assert.equal(written.createdAt,'old-date');
  for(const key of ['createdByUid','createdByName','createdByRole']){
   assert.equal(Object.hasOwn(written,key),Object.hasOwn(audit,key));assert.equal(written[key],audit[key]);
  }
 }
});

test('legacy quote contact lookup uses a unique code and never falls back from another UID or duplicate code to a name',()=>{
 const f=fixture();assert.equal(f.context.quotePersonFromIdentity({salesCode:'B2'}).uid,'boss2');
 assert.equal(f.context.quotePersonFromIdentity({ownerUid:'gone',salesCode:'B2'}),undefined);
 f.people.push({uid:'duplicate',code:'B2',name:'另一人'});assert.equal(f.context.quotePersonFromIdentity({salesCode:'B2'}),null);
});

test('own quote PDF contact remains available when the restricted role never queries the full staff collection',()=>{
 const f=fixture('engineer','eng1','E01','工程師');f.people.splice(0);
 const person=f.context.quotePersonFromIdentity({ownerUid:'eng1',salesCode:'E01'});
 assert.equal(person.uid,'eng1');assert.equal(person.code,'E01');assert.equal(person.phone,'999');
 assert.equal(f.context.quotePersonFromIdentity({ownerUid:'boss2'}),undefined);
});
