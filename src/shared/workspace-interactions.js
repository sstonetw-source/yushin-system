// Shared modal ownership. Originals retain their handlers; no transaction data is copied.
(function(root){
 if(typeof document==='undefined')return;
 root.initializeWorkspaceMenus=function(){
  if(root.workspaceMenusInitialized)return;root.workspaceMenusInitialized=true;
  const selector='.order-more-menu,.quote-more-menu,.po-more-menu,.inventory-more-menu';
  let active=null;
  function close(){if(!active)return;const {menu,panel,dialog,trigger}=active;active=null;menu.append(panel);menu.open=false;if(dialog.open)dialog.close();dialog.remove();if(trigger.isConnected)trigger.focus({preventScroll:true});}
  document.addEventListener('toggle',event=>{
   const menu=event.target;if(!menu.matches?.(selector))return;
   if(!menu.open){if(active?.menu===menu)close();return;}if(active?.menu===menu)return;close();
   const panel=menu.querySelector('[class$="-menu-popover"]');if(!panel)return;
   const row=menu.closest('tr'),dialog=document.createElement('dialog');dialog.className='workspace-menu-dialog';dialog.workspaceSourceSection=menu.closest('.content-section');dialog.setAttribute('aria-label','更多操作');
   const header=document.createElement('header'),title=document.createElement('strong'),context=document.createElement('p'),button=document.createElement('button');
   title.textContent=row?.dataset.menuScope||'更多操作';context.textContent=row?.dataset.menuTitle||[...row?.querySelectorAll('td')||[]].slice(0,3).map(cell=>cell.innerText.trim()).join(' · ');
   button.type='button';button.className='btn-secondary';button.textContent='關閉';button.onclick=close;header.append(title,context,button);dialog.append(header,panel);document.body.append(dialog);
   active={menu,panel,dialog,trigger:menu.querySelector('summary')};dialog.showModal();
   dialog.addEventListener('cancel',e=>{e.preventDefault();close();});dialog.addEventListener('close',()=>{if(active?.dialog===dialog)close();});
   dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)close();}else if(e.target.closest('[class$="-menu-popover"] button'))close();});
  },true);
  new MutationObserver(()=>{if(active&&!active.menu.isConnected)close();}).observe(document.body,{childList:true,subtree:true});
  document.addEventListener('click',e=>{if(active&&!active.dialog.contains(e.target)&&!active.menu.contains(e.target))close();});
 };
 // One lock for native dialogs and legacy overlays, including nested modal transitions.
 let saved=null;
 function sync(){
  const modal=document.querySelector('dialog[open],.eq-modal-overlay.active,.password-modal-overlay.active');
  if(modal&&!saved){const b=document.body;saved={x:scrollX,y:scrollY,position:b.style.position,top:b.style.top,left:b.style.left,right:b.style.right,overflow:b.style.overflow};Object.assign(b.style,{position:'fixed',top:`-${saved.y}px`,left:'0',right:'0',overflow:'hidden'});}
  else if(!modal&&saved){const previous=saved;saved=null;for(const key of ['position','top','left','right','overflow'])document.body.style[key]=previous[key];window.scrollTo(previous.x,previous.y);}
 }
 function start(){new MutationObserver(sync).observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['open','class']});sync();}
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
})(globalThis);
