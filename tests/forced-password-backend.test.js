'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {completeRequiredPasswordChange} = require('../functions/forced-password-service');

function fixture({active=true,forced=true,authFailure=false,transactionFailure=false,onAuthUpdate}={}) {
    let version=1;
    const record={active,mustChangePassword:forced};
    const updates=[];
    const snapshot=()=>({exists:true,data:()=>({...record}),updateTime:{
        version,isEqual(other){return this.version===other?.version;}
    }});
    const ref={get:async()=>snapshot()};
    const db={collection(name){assert.equal(name,'users');return{doc(uid){assert.equal(uid,'u1');return ref;}}},
        async runTransaction(work){
            if(transactionFailure)throw new Error('Firestore unavailable');
            return work({get:async()=>snapshot(),update(_ref,patch){updates.push(patch);Object.assign(record,patch);version++;}});
        }};
    const auth={async updateUser(uid,patch){
        assert.equal(uid,'u1');
        assert.deepEqual(patch,{password:'NewPassword123'});
        if(authFailure)throw new Error('Auth unavailable');
        await onAuthUpdate?.({record,change:()=>version++});
        return {uid};
    }};
    return {db,auth,record,updates};
}

function run(f,payload={newPassword:'NewPassword123'},authTime=1000){
    return completeRequiredPasswordChange(f.db,f.auth,'u1',authTime,payload,1005);
}

test('recently authenticated employee changes own password then protected forced flag atomically',async()=>{
    const f=fixture();
    assert.deepEqual(await run(f),{completed:true});
    assert.equal(f.record.mustChangePassword,false);
    assert.deepEqual(f.updates,[{mustChangePassword:false}]);
    assert.deepEqual(await run(f),{completed:false,alreadyCompleted:true});
    assert.equal(f.updates.length,1);
});

test('stale session, invalid password, disabled user and missing auth fail without writes',async()=>{
    for(const [setup,authTime,payload] of [
        [{},600,{newPassword:'NewPassword123'}],
        [{},1000,{newPassword:'short'}],
        [{active:false},1000,{newPassword:'NewPassword123'}]
    ]){
        const f=fixture(setup);
        await assert.rejects(run(f,payload,authTime),/重新登入|6 至 128|帳號已停用/);
        assert.deepEqual(f.updates,[]);
    }
    const f=fixture();
    await assert.rejects(completeRequiredPasswordChange(f.db,f.auth,'',1000,{newPassword:'NewPassword123'},1005),/請先登入/);
    assert.deepEqual(f.updates,[]);
});

test('Auth failure retains forced status and does not update Firestore',async()=>{
    const f=fixture({authFailure:true});
    await assert.rejects(run(f),/Auth unavailable/);
    assert.equal(f.record.mustChangePassword,true);
    assert.deepEqual(f.updates,[]);
});

test('Firestore failure after Auth update leaves forced status locked for safe retry',async()=>{
    const f=fixture({transactionFailure:true});
    await assert.rejects(run(f),/Firestore unavailable/);
    assert.equal(f.record.mustChangePassword,true);
    assert.deepEqual(f.updates,[]);
});

test('concurrent admin account change cannot have its forced status silently cleared',async()=>{
    const f=fixture({onAuthUpdate:async({record,change})=>{record.mustChangePassword=true;change();}});
    await assert.rejects(run(f),/帳號設定已變更/);
    assert.equal(f.record.mustChangePassword,true);
    assert.deepEqual(f.updates,[]);
});
