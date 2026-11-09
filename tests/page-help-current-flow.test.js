'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

const source=fs.readFileSync('modules/page-help.js','utf8');

function openHelp(key,{transferReady=false}={}){
 const listeners=new Map();
 const element=tag=>({tag,children:[],textContent:'',hidden:false,
  getClientRects:()=>[{}],append(...children){this.children.push(...children);},
  replaceChildren(){this.children=[];},addEventListener(){},querySelector:()=>element('button'),showModal(){},close(){}});
 const elements=new Map([['pageHelpDialog',element('dialog')],['pageHelpBody',element('body')],
  ['pageHelpTitle',element('title')],['inventory-system',element('page')],['order-system',element('page')]]);
 const document={readyState:'loading',getElementById:id=>elements.get(id),createElement:element,
  addEventListener:(name,fn)=>listeners.set(name,fn)};
 const context={document,APP_ENVIRONMENT:'production',
  productionTransactionBackendEnabled:()=>transferReady};
 vm.runInNewContext(source,context);
 listeners.get('DOMContentLoaded')();
 const button={dataset:{pageHelp:key}};
 listeners.get('click')({target:{closest:()=>button}});
 return elements.get('pageHelpBody').children.flatMap(section=>section.children[1].children.map(item=>item.textContent));
}

test('production help distinguishes paperwork, stock shipment, arrival and returns',()=>{
 const notes=openHelp('order-system');
 assert.ok(notes.some(note=>note.includes('打單只準備單據')&&note.includes('扣庫存')));
 assert.ok(notes.some(note=>note.includes('撤銷送達也不等於退貨入庫')));
 assert.ok(notes.some(note=>note.includes('取消訂單不代表取消供應商採購')));
});

test('warehouse help warns during order-transfer cutover and hides warning after all routes are enabled',()=>{
 const disabled=openHelp('inventory-system',{transferReady:false});
 assert.ok(disabled.some(note=>note.includes('訂單關聯的倉庫調撥')&&note.includes('不得改用舊版瀏覽器')));
 const enabled=openHelp('inventory-system',{transferReady:true});
 assert.ok(!enabled.some(note=>note.includes('訂單關聯的倉庫調撥')));
});
