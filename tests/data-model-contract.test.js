'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root=path.join(__dirname,'..');
const rules=fs.readFileSync(path.join(root,'firestore.rules'),'utf8');
const index=JSON.parse(fs.readFileSync(path.join(root,'firestore.indexes.json'),'utf8'));
const md=fs.readFileSync(path.join(root,'docs/DATA_MODEL.md'),'utf8');
const ruleCollections=new Set([...rules.matchAll(/\bmatch\s+\/([A-Za-z]\w*)\/\{[^}]+\}/g)]
  .map(m=>m[1]).filter(x=>x!=='databases'));
const documented=[...md.matchAll(/^\| `([A-Za-z]\w*)` \|/gm)].map(m=>m[1]);
test('Firestore Rules 的每個集合都有且只有一個責任記錄',()=>{
  assert.equal(documented.length,new Set(documented).size,'文件重複宣告集合');
  assert.deepEqual([...new Set(documented)].sort(),[...ruleCollections].sort());
});
test('所有複合索引都有對應的 Firestore Rules 集合',()=>{
  assert.ok(index.indexes.length>0);
  for(const row of index.indexes)
    assert.ok(ruleCollections.has(row.collectionGroup),'索引缺少集合規則: '+row.collectionGroup);
});
test('網站不再配置 Firebase Hosting，保留 Firebase 後端設定',()=>{
  const firebase=JSON.parse(fs.readFileSync(path.join(root,'firebase.json'),'utf8'));
  assert.equal(Object.hasOwn(firebase,'hosting'),false);
  assert.equal(firebase.firestore.rules,'firestore.rules');
  assert.equal(firebase.firestore.indexes,'firestore.indexes.json');
  assert.equal(firebase.functions.source,'functions');
});
