'use strict';
// Only an explicit Preview rollout may turn on this staged callable.
// The production project must never be enabled by a copied environment flag.
function projectIdFromEnvironment(env=process.env){
  if(env.GCLOUD_PROJECT)return env.GCLOUD_PROJECT;
  if(env.GCP_PROJECT)return env.GCP_PROJECT;
  try{return JSON.parse(env.FIREBASE_CONFIG||'{}').projectId||'';}
  catch{return '';}
}
function allowGroupedReservation(env=process.env){
  if(env.ENABLE_GROUPED_RESERVATION!=='true')return false;
  const id=projectIdFromEnvironment(env);
  return id==='preview-20135' ||
    (id==='demo-yushin' && !!env.FIRESTORE_EMULATOR_HOST && !!env.FIREBASE_AUTH_EMULATOR_HOST);
}
// The initial-sync Preview rollout must not implicitly authorize new
// post-sync amendments. Each mode has an independent, default-closed flag.
function allowGroupedReservationAmend(env=process.env){
  return env.ENABLE_GROUPED_RESERVATION_AMEND==='true' && allowGroupedReservation(env);
}
// Same-warehouse multi-line writes close a distinct #311 Rules gap. They may
// not be silently switched on by the existing two-warehouse Preview flag.
function allowGroupedReservationSameWarehouse(env=process.env){
  return env.ENABLE_GROUPED_RESERVATION_SAME_WAREHOUSE==='true' && allowGroupedReservation(env);
}
module.exports={allowGroupedReservation,allowGroupedReservationAmend,
  allowGroupedReservationSameWarehouse,projectIdFromEnvironment};
