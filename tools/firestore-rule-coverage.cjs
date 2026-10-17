#!/usr/bin/env node
'use strict';
// Firestore Emulator's public, local-only rules report. Used solely in CI
// to locate rules-evaluation hot spots, never for production access.
const endpoint='http://127.0.0.1:8080/emulator/v1/projects/demo-yushin:ruleCoverage';
(async()=>{
  const response=await fetch(endpoint,{signal:AbortSignal.timeout(12000)});
  if(!response.ok)throw Error('Emulator coverage HTTP '+response.status);
  const json=await response.json(), rows=[], seen=new Set();
  function walk(node,depth=0){
    if(!node || typeof node!=='object' || depth>70 || seen.has(node))return;
    seen.add(node);
    if(Array.isArray(node)){for(const value of node)walk(value,depth+1);return;}
    if(node.sourcePosition && Array.isArray(node.values)){
      const p=node.sourcePosition;
      const line=p.line ?? p.lineNumber ?? p.start?.line ?? p.startLine ?? '?';
      const column=p.column ?? p.columnNumber ?? p.start?.column ?? '?';
      const count=node.values.reduce((sum,v)=>sum+(typeof v?.count==='number'?v.count:0),0);
      if(count>0)rows.push({line,column,count});
    }
    for(const value of Object.values(node))walk(value,depth+1);
  }
  walk(json);
  rows.sort((a,b)=>b.count-a.count);
  console.log('RuleCoverage hot-spots (isolated five-reservation test):');
  console.log('evaluated expression nodes='+rows.length);
  if(!rows.length)console.log('No sourcePosition/values nodes; top-level keys: '+Object.keys(json).join(','));
  for(const row of rows.slice(0,35))
    console.log('  firestore.rules:'+row.line+':'+row.column+' evaluations='+row.count);
})().catch(err=>{
  // Diagnostics should not turn a passing full regression into a failure.
  console.log('Emulator ruleCoverage unavailable: '+err.message);
});
