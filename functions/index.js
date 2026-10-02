const {onCall,HttpsError}=require('firebase-functions/v2/https');
const {defineJsonSecret}=require('firebase-functions/params');
const {logger}=require('firebase-functions');
const {initializeApp}=require('firebase-admin/app');
const {getFirestore}=require('firebase-admin/firestore');
const nodemailer=require('nodemailer');
const mail=require('./purchase-email-core.js');

initializeApp();

const smtpConfig=defineJsonSecret('YUSHIN_SMTP_CONFIG');
const PURCHASE_ROLES=new Set(['admin','purchaser']);

async function purchaseUser(db,uid){
  const snapshot=await db.collection('users').doc(uid).get();
  if(!snapshot.exists)throw new HttpsError('permission-denied','找不到系統使用者。');
  const user=snapshot.data()||{};
  if(user.active===false||user.disabled===true||!PURCHASE_ROLES.has(user.role)){
    throw new HttpsError('permission-denied','只有啟用中的採購／管理員可寄送訂購單。');
  }
  return user;
}

async function resolveSupplier(db,po){
  const supplierId=String(po.supplierId||'').trim();
  if(supplierId){
    const snapshot=await db.collection('suppliers').doc(supplierId).get();
    if(snapshot.exists)return {id:snapshot.id,...snapshot.data()};
  }

  const name=String(po.supplierName||po.vendorName||'').trim();
  if(!name)return null;
  const byName=await db.collection('suppliers').where('supplierName','==',name).limit(1).get();
  if(!byName.empty)return {id:byName.docs[0].id,...byName.docs[0].data()};
  const byHeader=await db.collection('suppliers').where('purchaseHeaderName','==',name).limit(1).get();
  if(!byHeader.empty)return {id:byHeader.docs[0].id,...byHeader.docs[0].data()};
  return null;
}

exports.sendPurchaseOrderEmail=onCall({
  region:'asia-east1',
  timeoutSeconds:60,
  memory:'256MiB',
  maxInstances:5,
  secrets:[smtpConfig]
},async request=>{
  if(!request.auth)throw new HttpsError('unauthenticated','請先登入。');

  const db=getFirestore();
  const actor=await purchaseUser(db,request.auth.uid);
  let purchaseOrderId;
  let pdf;
  try{
    purchaseOrderId=mail.safePurchaseOrderId(request.data?.purchaseOrderId);
    pdf=mail.decodePdfBase64(request.data?.pdfBase64);
  }catch(error){
    const reason=String(error?.message||'');
    if(reason==='PDF_TOO_LARGE'){
      throw new HttpsError('resource-exhausted','訂購單 PDF 過大，請改用下載附件寄送。',{reason});
    }
    throw new HttpsError('invalid-argument','訂購單或 PDF 格式不正確。',{reason});
  }

  const poRef=db.collection('purchaseOrders').doc(purchaseOrderId);
  const poSnapshot=await poRef.get();
  if(!poSnapshot.exists)throw new HttpsError('not-found','找不到這張訂購單。');
  const po={id:poSnapshot.id,...poSnapshot.data()};
  if(String(po.status||'').toUpperCase()==='CANCELLED'){
    throw new HttpsError('failed-precondition','已取消的訂購單不可寄送。',{reason:'PURCHASE_ORDER_CANCELLED'});
  }

  const supplier=await resolveSupplier(db,po);
  if(!supplier||supplier.active===false){
    throw new HttpsError('failed-precondition','請先在 Supplier Master 設定啟用中的供應商。',{reason:'SUPPLIER_NOT_CONFIGURED'});
  }
  if(!mail.normalizeEmail(supplier.email)){
    throw new HttpsError('failed-precondition','供應商尚未設定有效 Email。',{reason:'SUPPLIER_EMAIL_MISSING'});
  }

  let secret;
  try{
    secret=smtpConfig.value();
  }catch(error){
    throw new HttpsError('failed-precondition','後端寄信尚未設定 SMTP。',{reason:'SMTP_NOT_CONFIGURED'});
  }
  if(!secret||!String(secret.url||'').trim()||!String(secret.from||'').trim()){
    throw new HttpsError('failed-precondition','後端寄信尚未設定 SMTP。',{reason:'SMTP_NOT_CONFIGURED'});
  }

  const message=mail.composePurchaseOrderMail({
    po,
    supplier:{...supplier,supplierId:supplier.supplierId||supplier.id},
    smtp:secret,
    fileName:request.data?.fileName
  });
  message.attachments[0].content=pdf;

  const transporter=nodemailer.createTransport({
    url:String(secret.url),
    pool:false,
    connectionTimeout:30000,
    greetingTimeout:15000,
    socketTimeout:60000,
    disableFileAccess:true,
    disableUrlAccess:true
  });

  let info;
  try{
    info=await transporter.sendMail(message);
  }catch(error){
    logger.error('Purchase order email send failed',{
      purchaseOrderId,
      uid:request.auth.uid,
      code:error?.code||'SMTP_ERROR',
      command:error?.command||''
    });
    throw new HttpsError('unavailable','SMTP 寄送失敗，系統沒有標記為已寄出。',{
      reason:'EMAIL_SEND_FAILED'
    });
  }finally{
    try{transporter.close();}catch(_){}
  }

  const now=new Date().toISOString();
  const event=mail.communicationRecord({
    poId:purchaseOrderId,
    po,
    supplier:{...supplier,supplierId:supplier.supplierId||supplier.id},
    actor:{
      uid:request.auth.uid,
      name:actor.name||actor.displayName||request.auth.token?.name||'',
      email:request.auth.token?.email||actor.email||''
    },
    messageInfo:info,
    now
  });
  const communicationRef=db.collection('purchaseOrderCommunications').doc();
  await db.runTransaction(async tx=>{
    tx.set(communicationRef,event);
    tx.set(poRef,{
      lastShareAt:now,
      lastShareType:'SMTP',
      lastShareEmail:event.recipientEmail,
      lastCommunicationState:'SENT',
      lastEmailSentAt:now,
      lastEmailMessageId:event.messageId
    },{merge:true});
  });

  return {
    ok:true,
    purchaseOrderId,
    recipientEmail:event.recipientEmail,
    messageId:event.messageId,
    accepted:event.accepted,
    rejected:event.rejected
  };
});
