'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('GitHub Pages includes a fresh app cache key for the backend-only password flow', () => {
    const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
    assert.match(html, /app\.js\?v=20261112-1/);
    assert.match(html, /id="changePasswordSaveBtn"/);
});

function fixture({forced, updatePassword = async () => {}, callable = async () => ({data:{completed:true}})} = {}) {
    const nodes = Object.fromEntries([
        'changePasswordOverlay', 'newPassword', 'confirmNewPassword',
        'changePasswordMessage', 'changePasswordCancelBtn', 'changePasswordLogoutBtn',
        'changePasswordSaveBtn', 'loginError'
    ].map(id => [id, { value: '', style: {}, dataset: {} }]));
    const classes = new Set();
    nodes.changePasswordOverlay.classList = {
        add(name) { classes.add(name); },
        remove(name) { classes.delete(name); },
        contains(name) { return classes.has(name); }
    };
    const writes = [];
    const authUser = { uid: 'forced-user', updatePassword };
    const scope = {
        setInterval() {},
        document: { getElementById(id) { return nodes[id] || null; } },
        currentUser: authUser,
        mustChangePassword: !!forced,
        firebase: {
            app() { return { functions() { return { httpsCallable(name) {
                assert.equal(name, 'completeRequiredPasswordChange');
                return callable;
            } }; } }; },
            auth() { return {currentUser:authUser}; }
        },
        db: { collection() { writes.push('firestore'); throw new Error('protected Firestore write attempted'); } },
        setTimeout(callback) { callback(); },
        console: { error() {}, warn() {} }
    };
    // In the browser window properties also resolve as unqualified globals.
    scope.window = scope;
    vm.runInNewContext(fs.readFileSync(require.resolve('../src/app/role-capabilities.js'), 'utf8'), scope);
    scope.window.openChangePasswordModal(!!forced);
    nodes.newPassword.value = 'NewPassword123';
    nodes.confirmNewPassword.value = 'NewPassword123';
    return { scope, nodes, classes, writes };
}

async function flush() {
    await new Promise(resolve => setImmediate(resolve));
}

test('forced password update uses trusted Callable, then signs out only after its success', async () => {
    let localPasswordUpdates=0, signouts=0;
    const { scope, nodes, classes, writes } = fixture({ forced: true,
        updatePassword:async()=>{ localPasswordUpdates++; } });
    scope.window.handleLogout=async()=>{signouts++;};
    scope.window.handleChangePassword();
    await flush();
    assert.equal(scope.mustChangePassword, false);
    assert.equal(nodes.changePasswordOverlay.dataset.forced, '');
    assert.equal(classes.has('active'), false);
    assert.equal(nodes.changePasswordCancelBtn.style.display, '');
    assert.equal(nodes.changePasswordLogoutBtn.style.display, '');
    assert.equal(nodes.newPassword.value, '');
    assert.equal(nodes.confirmNewPassword.value, '');
    assert.match(nodes.loginError.innerText, /使用新密碼重新登入/);
    assert.equal(signouts, 1);
    assert.equal(localPasswordUpdates, 0);
    assert.deepEqual(writes, []);
});

test('voluntary password update closes normally without touching protected user fields', async () => {
    const { scope, nodes, classes, writes } = fixture({ forced: false });
    scope.window.handleChangePassword();
    await flush();
    assert.equal(classes.has('active'), false);
    assert.equal(nodes.changePasswordLogoutBtn.style.display, 'none');
    assert.deepEqual(writes, []);
});

test('forced password flow allows safe logout but stays locked on signout failure', async () => {
    const { scope, nodes, classes } = fixture({ forced: true });
    scope.window.handleLogout = async () => { throw new Error('offline'); };
    scope.window.handleForcedPasswordLogout();
    await flush();
    assert.equal(classes.has('active'), true);
    assert.match(nodes.changePasswordMessage.innerText, /登出失敗/);
    scope.window.handleLogout = async () => {};
    scope.window.handleForcedPasswordLogout();
    await flush();
    assert.equal(classes.has('active'), false);
    assert.equal(nodes.changePasswordOverlay.dataset.forced, '');
});

test('unavailable trusted Callable never falls back to Auth or protected Firestore writes', async () => {
    let localPasswordUpdates=0;
    const { scope, nodes, classes, writes } = fixture({ forced: true,
        updatePassword:async()=>{localPasswordUpdates++;},
        callable:async()=>{throw {code:'functions/not-found'};} });
    scope.window.handleChangePassword();
    await flush();
    assert.equal(scope.mustChangePassword, true);
    assert.equal(classes.has('active'), true);
    assert.match(nodes.changePasswordMessage.innerText, /安全後端尚未部署/);
    assert.equal(nodes.changePasswordSaveBtn.disabled, false);
    assert.equal(localPasswordUpdates, 0);
    assert.deepEqual(writes, []);
});
