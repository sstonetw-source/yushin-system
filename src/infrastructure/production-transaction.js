// Every production transaction must use its authorized backend or fail closed.
// Client flags select whether the backend is enabled; they must never grant
// permission to fall back to an old Firestore transaction when both are off.
function productionTransactionBackendRequired(kind){
 return typeof APP_ENVIRONMENT!=='undefined'&&APP_ENVIRONMENT==='production';
}
function productionTransactionBackendEnabled(kind){
 if(!['DISPATCH','SHIPMENT','ORDER_LIFECYCLE','DELIVERY_CONFIRMATION','DELIVERY_REVERSAL','CUSTOMER_RETURN','CUSTOMER_RETURN_REQUEST',
  'ORDER_TRANSFER_DISPATCH','ORDER_TRANSFER_HANDOFF','ORDER_TRANSFER_RECEIVE','CANCELLED_PURCHASE',
  'MAIN_TRANSFER_REQUEST','MAIN_TRANSFER_DISPATCH','MAIN_TRANSFER_RECEIPT','MAIN_TRANSFER_ALLOCATION',
  'MANUAL_INVENTORY','INVENTORY_COUNT','SUPPLY_CANCELLATION'].includes(kind)||!productionTransactionBackendRequired(kind)
  ||globalThis['YUSHIN_PRODUCTION_'+kind+'_BACKEND']!==true
  ||globalThis['YUSHIN_PRODUCTION_'+kind+'_LEGACY_BLOCKED']!==true)return false;
 const path=String(globalThis.location?.pathname||'');
 return globalThis.location?.origin==='https://sstonetw-source.github.io'
  &&(path==='/yushin-system'||path.startsWith('/yushin-system/'));
}
