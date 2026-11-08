/* Browser-only installation guidance. No offline caching or user data storage. */
(function(root){
  if(typeof document==='undefined')return;
  let installPrompt=null;
  const byId=id=>document.getElementById(id);
  const isAppleMobile=()=>/iPad|iPhone|iPod/i.test(navigator.userAgent||'') ||
    (navigator.platform==='MacIntel' && navigator.maxTouchPoints>1);
  const isAndroid=()=>/Android/i.test(navigator.userAgent||'');
  const isStandalone=()=>navigator.standalone===true ||
    !!root.matchMedia?.('(display-mode: standalone)').matches ||
    !!root.matchMedia?.('(display-mode: fullscreen)').matches;

  function render(){
    const button=byId('homeScreenInstallButton'),status=byId('homeScreenInstallStatus');
    if(!button || !status)return;
    const alreadyOpen=isStandalone();
    button.hidden=alreadyOpen;
    button.textContent=installPrompt?'📲 安裝又鑫系統':'📲 加入手機主畫面';
    if(alreadyOpen){
      status.textContent='目前已從主畫面 App 模式開啟。';
      const guide=byId('homeScreenInstallGuide');if(guide)guide.hidden=true;
    }else if(!status.textContent){
      status.textContent='加入後可快速開啟系統；登入及使用權限維持不變。';
    }
  }

  function showGuide(){
    const guide=byId('homeScreenInstallGuide');
    if(!guide)return;
    if(isAppleMobile()){
      guide.innerHTML='<strong>iPhone／iPad 操作方式</strong><ol><li>在 Safari 開啟目前這個系統網址。</li><li>點選「分享」後，選擇「加入主畫面」。</li><li>如有「打開為網頁 App」，請開啟，最後點「加入」。</li></ol><p>若從 LINE 或其他內建瀏覽器開啟，請先改用 Safari。</p>';
    }else if(isAndroid()){
      guide.innerHTML='<strong>Android 操作方式</strong><ol><li>在 Chrome 開啟目前這個系統網址。</li><li>點選瀏覽器右上角的「⋮」選單。</li><li>選擇「安裝應用程式」或「加到主畫面」，依畫面確認。</li></ol>';
    }else{
      guide.innerHTML='<p>請在 iPhone 或 Android 手機瀏覽器開啟本系統，再使用這個功能。</p>';
    }
    guide.hidden=false;
  }

  async function open(){
    if(isStandalone()){render();return;}
    const status=byId('homeScreenInstallStatus');
    if(!installPrompt){showGuide();return;}
    const prompt=installPrompt;
    installPrompt=null; // Chromium only permits this prompt to be used once.
    try{
      await prompt.prompt();
      const result=await prompt.userChoice;
      if(result?.outcome==='accepted'){
        if(status)status.textContent='已確認安裝，請到手機主畫面查看「又鑫系統」。';
      }else{
        if(status)status.textContent='尚未安裝；也可以依下方步驟手動加入。';
        showGuide();
      }
    }catch(_){
      if(status)status.textContent='瀏覽器目前無法直接安裝，請依下方步驟操作。';
      showGuide();
    }
    render();
  }

  root.addEventListener('beforeinstallprompt',event=>{
    event.preventDefault();
    installPrompt=event;
    render();
  });
  root.addEventListener('appinstalled',()=>{
    installPrompt=null;
    const status=byId('homeScreenInstallStatus');
    if(status)status.textContent='安裝完成，現在可以從主畫面開啟又鑫系統。';
    render();
  });
  root.YushinHomeScreenInstall={render,open,isStandalone};
})(typeof globalThis!=='undefined'?globalThis:this);
