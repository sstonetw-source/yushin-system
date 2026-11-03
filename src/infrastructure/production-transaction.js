// Default-off production handoff. Server flags remain independently required.
function productionTransactionBackendRequired(kind){
 return typeof APP_ENVIRONMENT!=='undefined'&&APP_ENVIRONMENT==='production'
  &&(globalThis['YUSHIN_PRODUCTION_'+kind+'_BACKEND']===true
   ||globalThis['YUSHIN_PRODUCTION_'+kind+'_LEGACY_BLOCKED']===true);
}
function productionTransactionBackendEnabled(kind){
 if(!['DISPATCH','SHIPMENT','ORDER_LIFECYCLE','DELIVERY_CONFIRMATION','DELIVERY_REVERSAL'].includes(kind)||!productionTransactionBackendRequired(kind)
  ||globalThis['YUSHIN_PRODUCTION_'+kind+'_BACKEND']!==true
  ||globalThis['YUSHIN_PRODUCTION_'+kind+'_LEGACY_BLOCKED']!==true)return false;
 const path=String(globalThis.location?.pathname||'');
 return globalThis.location?.origin==='https://sstonetw-source.github.io'
  &&(path==='/yushin-system'||path.startsWith('/yushin-system/'));
}
