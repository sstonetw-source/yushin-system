'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {allowGroupedReservation,allowGroupedReservationAmend,
 allowGroupedReservationSameWarehouse,projectIdFromEnvironment}=require('../functions/grouped-reservation-gate');
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
test('post-sync amendments remain disabled under the original grouped Preview flag',()=>{
 const preview={GCLOUD_PROJECT:'preview-20135',ENABLE_GROUPED_RESERVATION:'true'};
 assert.equal(allowGroupedReservation(preview),true);
 assert.equal(allowGroupedReservationAmend(preview),false);
 assert.equal(allowGroupedReservationAmend({...preview,ENABLE_GROUPED_RESERVATION_AMEND:'true'}),true);
 assert.equal(allowGroupedReservationAmend({...preview,ENABLE_GROUPED_RESERVATION:'false',ENABLE_GROUPED_RESERVATION_AMEND:'true'}),false);
 assert.equal(allowGroupedReservationAmend({...preview,GCLOUD_PROJECT:'yu-shing-company',ENABLE_GROUPED_RESERVATION_AMEND:'true'}),false);
 const demo={GCLOUD_PROJECT:'demo-yushin',ENABLE_GROUPED_RESERVATION:'true',ENABLE_GROUPED_RESERVATION_AMEND:'true'};
 assert.equal(allowGroupedReservationAmend(demo),false);
 assert.equal(allowGroupedReservationAmend({...demo,FIRESTORE_EMULATOR_HOST:'127.0.0.1:8080',FIREBASE_AUTH_EMULATOR_HOST:'127.0.0.1:9099'}),true);
});
test('same-warehouse multi-line writes require a separate Preview-only flag',()=>{
 const preview={GCLOUD_PROJECT:'preview-20135',ENABLE_GROUPED_RESERVATION:'true'};
 assert.equal(allowGroupedReservationSameWarehouse(preview),false);
 assert.equal(allowGroupedReservationSameWarehouse({...preview,ENABLE_GROUPED_RESERVATION_SAME_WAREHOUSE:'true'}),true);
 assert.equal(allowGroupedReservationSameWarehouse({...preview,ENABLE_GROUPED_RESERVATION:'false',ENABLE_GROUPED_RESERVATION_SAME_WAREHOUSE:'true'}),false);
 assert.equal(allowGroupedReservationSameWarehouse({...preview,GCLOUD_PROJECT:'yu-shing-company',ENABLE_GROUPED_RESERVATION_SAME_WAREHOUSE:'true'}),false);
 const demo={GCLOUD_PROJECT:'demo-yushin',ENABLE_GROUPED_RESERVATION:'true',ENABLE_GROUPED_RESERVATION_SAME_WAREHOUSE:'true'};
 assert.equal(allowGroupedReservationSameWarehouse(demo),false);
 assert.equal(allowGroupedReservationSameWarehouse({...demo,FIRESTORE_EMULATOR_HOST:'127.0.0.1:8080',FIREBASE_AUTH_EMULATOR_HOST:'127.0.0.1:9099'}),true);
});
