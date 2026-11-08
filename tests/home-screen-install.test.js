const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const root=path.resolve(__dirname,'..');
const source=fs.readFileSync(path.join(root,'modules/home-screen-install.js'),'utf8');

function browser(userAgent,options={}){
  const elements=Object.fromEntries(['homeScreenInstallButton','homeScreenInstallStatus','homeScreenInstallGuide']
    .map(id=>[id,{hidden:false,textContent:'',innerHTML:''}]));
  const listeners={};
  const context={
    document:{getElementById:id=>elements[id]||null},
    navigator:{userAgent,platform:options.platform||'',maxTouchPoints:options.maxTouchPoints||0,standalone:!!options.standalone},
    addEventListener:(name,listener)=>{listeners[name]=listener;},
    matchMedia:()=>({matches:!!options.displayStandalone})
  };
  vm.runInNewContext(source,context);
  context.YushinHomeScreenInstall.render();
  return {api:context.YushinHomeScreenInstall,elements,emit:(name,event)=>listeners[name](event)};
}

test('iPhone offers Safari instructions without claiming one-tap installation',async()=>{
  const {api,elements}=browser('Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X)');
  await api.open();
  assert.equal(elements.homeScreenInstallButton.hidden,false);
  assert.match(elements.homeScreenInstallGuide.innerHTML,/Safari.*加入主畫面/s);
  assert.match(elements.homeScreenInstallGuide.innerHTML,/網頁 App/);
  assert.equal(elements.homeScreenInstallGuide.hidden,false);
});

test('Android uses Chromium install prompt only when offered and falls back after dismissal',async()=>{
  const {api,elements,emit}=browser('Mozilla/5.0 (Linux; Android 16; Pixel)');
  let called=0,prevented=0;
  emit('beforeinstallprompt',{
    preventDefault(){prevented++;},
    async prompt(){called++;},
    userChoice:Promise.resolve({outcome:'dismissed'})
  });
  assert.equal(prevented,1);
  assert.match(elements.homeScreenInstallButton.textContent,/安裝又鑫系統/);
  await api.open();
  assert.equal(called,1);
  assert.match(elements.homeScreenInstallStatus.textContent,/尚未安裝/);
  assert.match(elements.homeScreenInstallGuide.innerHTML,/Chrome.*安裝應用程式/s);
  await api.open();
  assert.equal(called,1,'the consumed browser prompt is never reused');
});

test('install errors retain manual instructions and no installation is claimed',async()=>{
  const {api,elements,emit}=browser('Android');
  emit('beforeinstallprompt',{preventDefault(){},prompt(){throw Error('not available');}});
  await api.open();
  assert.match(elements.homeScreenInstallStatus.textContent,/無法直接安裝/);
  assert.equal(elements.homeScreenInstallGuide.hidden,false);
});

test('standalone iOS launch hides button; macOS-like iPad receives iOS guidance',async()=>{
  const standalone=browser('iPhone',{standalone:true});
  assert.equal(standalone.api.isStandalone(),true);
  assert.equal(standalone.elements.homeScreenInstallButton.hidden,true);
  assert.match(standalone.elements.homeScreenInstallStatus.textContent,/已從主畫面/);
  const ipad=browser('Mozilla/5.0 (Macintosh; Intel Mac OS X)',{platform:'MacIntel',maxTouchPoints:5});
  await ipad.api.open();
  assert.match(ipad.elements.homeScreenInstallGuide.innerHTML,/iPhone／iPad/);
});

test('install confirmation is reflected without writing user data',()=>{
  const {elements,emit}=browser('Android');
  emit('appinstalled');
  assert.match(elements.homeScreenInstallStatus.textContent,/安裝完成/);
});

test('web manifest targets the current GitHub Pages subpath and includes real square icons',()=>{
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.webmanifest'),'utf8'));
  assert.equal(manifest.start_url,'./');
  assert.equal(manifest.scope,'./');
  assert.equal(manifest.display,'standalone');
  for(const icon of manifest.icons){
    const file=fs.readFileSync(path.join(root,icon.src));
    const expected=Number(icon.sizes.split('x')[0]);
    assert.equal(file.toString('hex',0,8),'89504e470d0a1a0a');
    assert.equal(file.readUInt32BE(16),expected);
    assert.equal(file.readUInt32BE(20),expected);
  }
  const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
  assert.match(html,/rel="manifest" href="manifest\.webmanifest"/);
  assert.match(html,/modules\/home-screen-install\.js/);
  assert.match(fs.readFileSync(path.join(root,'modules/delivery-settings.js'),'utf8'),/id="homeScreenInstallButton" type="button"/);
});
