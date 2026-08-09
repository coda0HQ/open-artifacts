
(function(){
  if(!window.__oaSend)return;
  var events=[], cursor=null, raf=0, offset=0, lastResume=0, playing=false, idx=0;
  var st=document.createElement('style');
  st.textContent='#oa-handoff-cursor{position:fixed;top:0;left:0;width:16px;height:16px;margin:-2px 0 0 -2px;border-radius:50%;background:var(--oa-accent,#6457f0);border:2px solid var(--oa-accent-on,#fff);box-shadow:0 0 0 2px color-mix(in oklab,var(--oa-accent,#6457f0),transparent 65%),0 2px 6px rgba(0,0,0,.3);pointer-events:none;z-index:2147483644;will-change:transform} .oa-handoff-ripple{position:fixed;border-radius:50%;border:2px solid var(--oa-accent,#6457f0);pointer-events:none;z-index:2147483643;animation:oa-handoff-ripple .6s ease-out forwards} @keyframes oa-handoff-ripple{0%{transform:scale(.5);opacity:.85}100%{transform:scale(2.4);opacity:0}} html.oa-handoff-recording{box-shadow:inset 0 3px 0 0 var(--oa-danger,#b42318)}';
  (document.head||document.documentElement).appendChild(st);
  function mkCursor(){ if(cursor)return; cursor=document.createElement('div'); cursor.id='oa-handoff-cursor'; document.body.appendChild(cursor); }
  function ripple(x,y){ var r=document.createElement('div'); r.className='oa-handoff-ripple'; r.style.left=(x-12)+'px'; r.style.top=(y-12)+'px'; r.style.width='24px'; r.style.height='24px'; document.body.appendChild(r); setTimeout(function(){ if(r.parentNode)r.parentNode.removeChild(r); },650); }
  function finite(n){ return typeof n==='number'&&isFinite(n)?n:0; }
  function clamp01(n){ return Math.max(0,Math.min(1,n)); }
  function viewport(){
    var d=document.documentElement||{}, b=document.body||{};
    var vw=finite(window.innerWidth)||finite(d.clientWidth)||1;
    var vh=finite(window.innerHeight)||finite(d.clientHeight)||1;
    var cw=finite(d.clientWidth)||vw, ch=finite(d.clientHeight)||vh;
    var dw=Math.max(cw,finite(d.scrollWidth),finite(b.scrollWidth));
    var dh=Math.max(ch,finite(d.scrollHeight),finite(b.scrollHeight));
    return {vw:vw,vh:vh,sxMax:Math.max(0,dw-cw),syMax:Math.max(0,dh-ch)};
  }
  function point(ev,v){
    var x=finite(ev.x), y=finite(ev.y);
    if(typeof ev.nx==='number'&&isFinite(ev.nx))x=clamp01(ev.nx)*v.vw;
    else if(typeof ev.vw==='number'&&isFinite(ev.vw)&&ev.vw>0)x=clamp01(x/ev.vw)*v.vw;
    if(typeof ev.ny==='number'&&isFinite(ev.ny))y=clamp01(ev.ny)*v.vh;
    else if(typeof ev.vh==='number'&&isFinite(ev.vh)&&ev.vh>0)y=clamp01(y/ev.vh)*v.vh;
    return {x:x,y:y};
  }
  function scrollPoint(ev,v){
    var sx=finite(ev.sx), sy=finite(ev.sy);
    if(typeof ev.nsx==='number'&&isFinite(ev.nsx))sx=clamp01(ev.nsx)*v.sxMax;
    else if(typeof ev.sxMax==='number'&&isFinite(ev.sxMax))sx=ev.sxMax?clamp01(sx/ev.sxMax)*v.sxMax:0;
    if(typeof ev.nsy==='number'&&isFinite(ev.nsy))sy=clamp01(ev.nsy)*v.syMax;
    else if(typeof ev.syMax==='number'&&isFinite(ev.syMax))sy=ev.syMax?clamp01(sy/ev.syMax)*v.syMax:0;
    return {sx:sx,sy:sy};
  }
  function apply(ev){
    var v=viewport();
    if(ev.kind==='scroll'||ev.kind==='resize'){ if(typeof ev.sx==='number'&&typeof ev.sy==='number'){var s=scrollPoint(ev,v);lastScroll=s;window.scrollTo(s.sx,s.sy);} }
    else if(ev.kind==='click'){ var p=point(ev,v); if(cursor)cursor.style.transform='translate('+p.x+'px,'+p.y+'px)'; ripple(p.x,p.y); }
    else if(ev.kind==='move'){ var p=point(ev,v); if(cursor)cursor.style.transform='translate('+p.x+'px,'+p.y+'px)'; }
  }
  function curT(){ return playing ? offset+(performance.now()-lastResume) : offset; }
  function resetToStart(){
    lastScroll=null;
    for(var i=0;i<events.length;i++){
      var ev=events[i];
      if((ev.kind==='scroll'||ev.kind==='resize')&&typeof ev.sx==='number'&&typeof ev.sy==='number'){
        var s=scrollPoint(ev,viewport()); lastScroll=s; window.scrollTo(s.sx,s.sy); return;
      }
    }
  }
  function tick(){
    var t=curT();
    while(idx<events.length && events[idx].t<=t){ apply(events[idx]); idx++; }
    if(idx<events.length) raf=requestAnimationFrame(tick); else { playing=false; raf=0; }
  }
  function play(){ if(playing)return; playing=true; lockScroll(true); lastResume=performance.now(); if(raf)cancelAnimationFrame(raf); raf=requestAnimationFrame(tick); }
  function pause(){ if(!playing)return; offset=curT(); playing=false; if(raf)cancelAnimationFrame(raf); raf=0; lockScroll(false); }
  function seek(t){ offset=t; lastResume=performance.now(); idx=0; resetToStart(); for(var i=0;i<events.length;i++){ if(events[i].t<=t){ apply(events[i]); idx=i+1; } else break; } if(playing){ if(raf)cancelAnimationFrame(raf); raf=requestAnimationFrame(tick); } }
  function stop(){ playing=false; if(raf)cancelAnimationFrame(raf); raf=0; offset=0; idx=0; lockScroll(false); if(cursor&&cursor.parentNode)cursor.parentNode.removeChild(cursor); cursor=null; }
  // While a handoff is playing, the viewer's own scroll is locked so the only
  // scroll is the recorded one - the play shim drives window.scrollTo from the
  // event stream. Capture-phase, passive:false so preventDefault holds; wheel,
  // touchmove, and the scroll-bearing keys (arrows, space, PgUp/PgDn, Home/End)
  // are all blocked. Released on pause/stop so the page scrolls normally then.
  var locked=false, scrollKeys=new Set(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight',' ','PageUp','PageDown','Home','End']);
  function blockWheel(e){ e.preventDefault(); e.stopPropagation(); }
  function blockTouch(e){ if(e.cancelable)e.preventDefault(); }
  function blockKey(e){ if(scrollKeys.has(e.key)){ e.preventDefault(); e.stopPropagation(); } }
  function lockScroll(on){
    if(on===locked)return; locked=on;
    if(on){
      document.addEventListener('wheel',blockWheel,{capture:true,passive:false});
      document.addEventListener('touchmove',blockTouch,{capture:true,passive:false});
      document.addEventListener('keydown',blockKey,{capture:true});
      // Freeze the recorded scroll position so the viewport does not jump.
      var r=lastScroll; if(r)window.scrollTo(r.sx,r.sy);
      // Hide the scrollbar WITHOUT releasing its gutter, so the artifact
      // content does not shift horizontally when scroll locks/unlocks on
      // play/pause. scrollbar-gutter:stable reserves the column on the
      // overflow:hidden state; restoring it on unlock keeps the same
      // column, so no layout shift crosses the two states.
      document.documentElement.style.scrollbarGutter='stable';
      document.documentElement.style.overflow='hidden';
    }else{
      document.removeEventListener('wheel',blockWheel,{capture:true});
      document.removeEventListener('touchmove',blockTouch,{capture:true});
      document.removeEventListener('keydown',blockKey,{capture:true});
      document.documentElement.style.scrollbarGutter='stable';
      document.documentElement.style.overflow='';
    }
  }
  var lastScroll=null;
  window.addEventListener('message',function(e){
    if(e.source!==window.parent)return;
    var m=e.data; if(!m||typeof m!=='object')return;
    if(m.type==='oa:handoff:play'){ stop(); events=Array.isArray(m.events)?m.events:[]; mkCursor(); offset=0; idx=0; resetToStart(); play(); }
    else if(m.type==='oa:handoff:pause')pause();
    else if(m.type==='oa:handoff:resume')play();
    else if(m.type==='oa:handoff:seek')seek(Number(m.t)||0);
    else if(m.type==='oa:handoff:stop')stop();
  });
})();
