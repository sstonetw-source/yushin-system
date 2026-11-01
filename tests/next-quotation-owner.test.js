'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const next=fs.readFileSync('src/features/quotations/next-quotation.js','utf8');
const {quoteNumberGenerator}=require('./helpers/quote-number-generator.cjs');
function fixture({role='sales',uid='sales1',code='S01',previous='YS-20261101-S01-09',owner={ownerUid:uid,salesCode:code},people=[],records=[]}={}){
 const reads=[],nodes={quoteNo:{value:previous},quoteOutputStatus:{classList:{contains:()=>false},innerText:''}};let selected={...owner};
 const db={collection(){const filters=[];return {where(...f){filters.push(f);return this;},orderBy(){return this;},limit(n){assert.equal(n,1);return this;},async get(){reads.push(filters);return {forEach:fn=>records.filter(r=>filters.every(([f,op,v])=>op==='=='?r[f]===v:op==='>='?r[f]>=v:r[f]<=v)).sort((a,b)=>b.quoteNo.localeCompare(a.quoteNo)).slice(0,1).forEach(r=>fn({data:()=>r}))};}};}};
 const g=quoteNumberGenerator(db,{role,uid,code}),c=g.context;
 Object.assign(c,{currentUserName:'本人',salesList:people,confirm:()=>true,quoteNoGeneration:0,editingQuoteNo:'historical',
  quoteOwnerFromSelection:()=>selected,setQuoteOwnerSelection:o=>{selected={...o};},isSelectableCommercialOwner:p=>['admin','sales','engineer'].includes(p.role)&&p.active!==false&&!!p.code&&!!p.name,
  document:{getElementById:id=>nodes[id]||(nodes[id]={value:'old',innerHTML:'old'})},setQuoteEditingContext:no=>{c.editingQuoteNo=no;},setQuoteOutputStatus:()=>{},
  initDate:()=>{nodes.quoteDate={value:'2026/11/01'};},getFormattedDateCode:()=>'20261101',populateSalesDropdown:()=>{},addQuoteRow:()=>{},calculateTotals:()=>{},saveQuoteDraft:()=>{},updateSalesPhoneDisplay:()=>{}});
 c.generateQuoteNo=()=>c.window.generateQuoteNo();vm.runInContext(next,c);
 return {c,reads,nodes,owner:()=>selected};
}
test('same group increments locally while refreshing the date and retaining its actor ownership',async()=>{
 const f=fixture();await f.c.window.startNextQuote();assert.equal(f.nodes.quoteNo.value,'YS-20261101-S01-10');assert.equal(f.reads.length,0);
 assert.equal(f.nodes.quoteDate.value,'2026/11/01');assert.equal(f.owner().ownerUid,'sales1');assert.equal(f.nodes.clientName.value,'');
});
test('a new day looks up the correct owner group instead of continuing yesterday',async()=>{
 const f=fixture({previous:'YS-20261031-S01-99',records:[{quoteNo:'YS-20261101-S01-03',ownerUid:'sales1',salesCode:'S01'}]});
 await f.c.window.startNextQuote();assert.equal(f.nodes.quoteNo.value,'YS-20261101-S01-04');assert.equal(f.reads.length,2);
});
test('UID-only manager history starts a new quote with its live code without changing the old record',async()=>{
 const historical=Object.freeze({quoteNo:'YS-20260905-N6-01',ownerUid:'boss'});
 const f=fixture({role:'admin',uid:'boss',code:'N6',previous:historical.quoteNo,owner:{ownerUid:'boss',salesCode:''},people:[{uid:'boss',name:'主管',code:'N6',role:'admin'}]});
 await f.c.window.startNextQuote();assert.equal(f.owner().ownerUid,'boss');assert.equal(f.owner().salesCode,'N6');assert.equal(f.nodes.quoteNo.value,'YS-20261101-N6-01');
 assert.equal(Object.hasOwn(historical,'salesCode'),false);
});
test('purchaser next quote retains the selected admin owner rather than its own purchasing code',async()=>{
 const f=fixture({role:'purchaser',uid:'buyer',code:'P5',previous:'YS-20261101-N6-03',owner:{ownerUid:'boss',salesCode:'N6'},people:[{uid:'boss',name:'主管',code:'N6',role:'admin'}]});
 await f.c.window.startNextQuote();assert.equal(f.owner().ownerUid,'boss');assert.equal(f.nodes.quoteNo.value,'YS-20261101-N6-04');assert.equal(f.reads.length,0);
});
test('inactive historical owner is not silently reassigned to the purchaser or issued a fallback number',async()=>{
 const f=fixture({role:'purchaser',uid:'buyer',code:'P5',owner:{ownerUid:'off',salesCode:'OFF'},people:[{uid:'off',name:'停用',code:'OFF',role:'sales',active:false}]});
 await f.c.window.startNextQuote();assert.equal(f.owner().ownerUid,undefined);assert.equal(f.nodes.quoteNo.value,'');assert.equal(f.reads.length,0);
});
