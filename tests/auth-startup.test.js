const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const app = fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');
const html = fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');

const start = app.indexOf('function showLoginScreen() {');
const end = app.indexOf('\nfunction showApp() {',start);
assert.ok(start >= 0 && end > start);
const transitionSource = app.slice(start,end);

test('startup never paints login form before Firebase resolves the session', () => {
    assert.match(html, /id="authStarting" role="status"/);
    assert.match(html, /id="loginScreen" style="display:none;"/);
    assert.match(app, /firebase\.auth\(\)\.onAuthStateChanged\(function\(user\)/);
});

test('existing authenticated user with a temporary profile read failure sees retry, not login', () => {
    const elements = Object.fromEntries(['authStarting','loginScreen','appContainer','authStartingMessage','authStartingRetry','loginPassword']
        .map(id=>[id,{style:{},hidden:true,value:'old'}]));
    const context=vm.createContext({document:{getElementById:id=>elements[id]}});
    vm.runInContext(transitionSource,context);
    context.showAuthWaiting('無法連線');
    assert.equal(elements.authStarting.style.display,'flex');
    assert.equal(elements.loginScreen.style.display,'none');
    assert.equal(elements.appContainer.style.display,'none');
    assert.equal(elements.authStartingRetry.hidden,false);
    assert.equal(elements.authStartingMessage.textContent,'無法連線');
    context.showLoginScreen();
    assert.equal(elements.authStarting.style.display,'none');
    assert.equal(elements.loginScreen.style.display,'flex');
    assert.equal(elements.loginPassword.value,'');
    assert.match(app,/showAuthWaiting\('已保留登入狀態，但暫時無法讀取帳號資料/);
});

test('manual sign-in selects LOCAL persistence before password sign-in', () => {
    assert.match(app,/setPersistence\(firebase\.auth\.Auth\.Persistence\.LOCAL\)\s*\.then\(\(\) => firebase\.auth\(\)\.signInWithEmailAndPassword\(email, password\)\)/);
    assert.match(app,/window\.handleLogout = function\(\) \{[\s\S]*?firebase\.auth\(\)\.signOut\(\)/);
});
