// Numeric edits are explicit. Wheel/trackpad gestures scroll without stepping or blur.
;(function installNumberWheelGuard() {
    if (typeof document==='undefined') return;
    document.addEventListener('wheel', event => {
        const input=event.target;
        if (!(input instanceof HTMLInputElement) || input.type!=='number'
            || document.activeElement!==input || input.disabled || input.readOnly
            || event.ctrlKey || event.defaultPrevented || !event.cancelable) return;
        event.preventDefault();
        const style=getComputedStyle(input);
        const scale=event.deltaMode===1 ? (parseFloat(style.lineHeight)||parseFloat(style.fontSize)*1.2||16)
            : event.deltaMode===2 ? window.innerHeight : 1;
        let dx=event.deltaX*(event.deltaMode===2?window.innerWidth:scale),dy=event.deltaY*scale;
        const root=document.scrollingElement;
        const boundary=input.closest('dialog[open],.eq-modal-overlay,.modal-overlay,.password-modal-overlay,[aria-modal="true"]');
        for(let node=input.parentElement;node&&node!==root;node=node.parentElement){
            const css=getComputedStyle(node);
            const scrollX=/auto|scroll|overlay/.test(css.overflowX),scrollY=/auto|scroll|overlay/.test(css.overflowY);
            const beforeX=node.scrollLeft,beforeY=node.scrollTop;
            if(scrollX||scrollY)node.scrollBy({left:scrollX?dx:0,top:scrollY?dy:0,behavior:'instant'});
            dx-=node.scrollLeft-beforeX;dy-=node.scrollTop-beforeY;
            if(scrollX&&/contain|none/.test(css.overscrollBehaviorX))dx=0;
            if(scrollY&&/contain|none/.test(css.overscrollBehaviorY))dy=0;
            if(node===boundary)return;
            if(Math.abs(dx)<0.01&&Math.abs(dy)<0.01)return;
        }
        // Let modal scroll boundaries contain the gesture, as native scrolling does.
        if(!boundary&&root)root.scrollBy({left:dx,top:dy,behavior:'instant'});
    },{capture:true,passive:false});
})();
