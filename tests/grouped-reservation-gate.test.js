'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {allowGroupedReservation,projectIdFromEnvironment}=require('../functions/grouped-reservation-gate');
test('grouped reservation requires explicit flag and never accepts live production project',()=>{
 const preview={GCLOUD_PROJECT:'preview-20135',ENABLE_GROUPED_RESERVATION:'true'};
 assert.equal(allowGroupedReservation(preview),true);
 assert.equal(allowGroupedReservation({...preview,ENABLE_GROUPED_RESERVATION:'false'}),false);
 assert.equal(allowGroupedReservation({GCLOUD_PROJECT:'yu-shing-company',ENABLE_GROUPED_RESERVATION:'true'}),false);
 assert.equal(allowGroupedReservation({GCLOUD_PROJECT:'some-other-project',ENABLE_GROUPED_RESERVATION:'true'}),false);
});
test('demo project is allowed only when Auth and Firestore emulators are both present',()=>{
 const demo={GCLOUD_PROJECT:'demo-yushin',ENABLE_GROUPED_RESERVATION:'true'};
 assert.equal(allowGroupedReservation(demo),false);
 assert.equal(allowGroupedReservation({...demo,FIRESTORE_EMULATOR_HOST:'127.0.0.1:8080'}),false);
 assert.equal(allowGroupedReservation({...demo,FIREBASE_AUTH_EMULATOR_HOST:'127.0.0.1:9099'}),false);
 assert.equal(allowGroupedReservation({...demo,FIRESTORE_EMULATOR_HOST:'127.0.0.1:8080',
  FIREBASE_AUTH_EMULATOR_HOST:'127.0.0.1:9099'}),true);
});
test('project ID detection uses Cloud Functions environment and rejects malformed Firebase config',()=>{
 assert.equal(projectIdFromEnvironment({FIREBASE_CONFIG:'{"projectId":"preview-20135"}'}),'preview-20135');
 assert.equal(projectIdFromEnvironment({FIREBASE_CONFIG:'bad data'}),'');
 assert.equal(projectIdFromEnvironment({GCP_PROJECT:'yu-shing-company',GCLOUD_PROJECT:'preview-20135'}),'preview-20135');
});
