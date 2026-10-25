'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {allowServiceCaseEmulator}=require('../functions/service-case-gate');
const enabled={ENABLE_SERVICE_CASE_EMULATOR:'true',GCLOUD_PROJECT:'demo-yushin',
  FIRESTORE_EMULATOR_HOST:'127.0.0.1:8080',
  FIREBASE_AUTH_EMULATOR_HOST:'127.0.0.1:9099'};
test('Service Callable is reachable only with real local Auth and Firestore Emulator',()=>{
  assert.equal(allowServiceCaseEmulator(enabled),true);
  for(const [field,value] of [
    ['ENABLE_SERVICE_CASE_EMULATOR','false'],
    ['GCLOUD_PROJECT','preview-20135'],
    ['GCLOUD_PROJECT','yu-shing-company'],
    ['GCLOUD_PROJECT',''],
    ['FIRESTORE_EMULATOR_HOST',''],
    ['FIRESTORE_EMULATOR_HOST','not-local.example:8080'],
    ['FIREBASE_AUTH_EMULATOR_HOST',''],
    ['FIREBASE_AUTH_EMULATOR_HOST','10.0.0.1:9099']
  ]){
    assert.equal(allowServiceCaseEmulator({...enabled,[field]:value}),false,field+'='+value);
  }
  assert.equal(allowServiceCaseEmulator({
    ...enabled,GCLOUD_PROJECT:undefined,GCP_PROJECT:'demo-yushin',
    FIRESTORE_EMULATOR_HOST:'localhost:8080'
  }),true);
});
test('No production rollout: no uncontrolled environment enables Service writer',()=>{
  assert.equal(allowServiceCaseEmulator({}),false);
  assert.equal(allowServiceCaseEmulator({
    ...enabled,GCLOUD_PROJECT:'preview-20135',ENABLE_SERVICE_CASE_EMULATOR:'true'
  }),false);
  assert.equal(allowServiceCaseEmulator({
    ...enabled,GCLOUD_PROJECT:'yu-shing-company',ENABLE_SERVICE_CASE_EMULATOR:'true'
  }),false);
});
