
(function(){
  if(!window.__oaSend)return;
  var armed=false, t0=0, raf=0, lastX=0, lastY=0, dirty=false, lastSend=0;
  var THROTTLE_MS=33;
  function now(){ return performance.now()-t0; }
  function curScroll(){ return { sx: window.scrollX||0, sy: window.scrollY||0 }; }
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
  function eventData(kind,x,y,sx,sy){
    var v=viewport(), px=finite(x), py=finite(y), psx=finite(sx), psy=finite(sy);
    var msg={type:'oa:handoff:event',t:Math.round(now()),kind:kind,x:px,y:py,sx:psx,sy:psy,
      vw:v.vw,vh:v.vh,sxMax:v.sxMax,syMax:v.syMax,
      nx:clamp01(px/v.vw),ny:clamp01(py/v.vh),
      nsx:v.sxMax?clamp01(psx/v.sxMax):0,nsy:v.syMax?clamp01(psy/v.syMax):0};
    if(kind==='resize'){msg.w=v.vw;msg.h=v.vh;}
    return msg;
  }
  function onMove(e){ if(!armed)return; lastX=e.clientX; lastY=e.clientY; dirty=true; }
  function onClick(e){ if(!armed)return; var s=curScroll(); window.__oaSend(eventData('click',e.clientX,e.clientY,s.sx,s.sy)); }
  function onScroll(){ if(!armed)return; var s=curScroll(); window.__oaSend(eventData('scroll',lastX,lastY,s.sx,s.sy)); }
  function onResize(){ if(!armed){return;} var s=curScroll(); window.__oaSend(eventData('resize',0,0,s.sx,s.sy)); }
  function tick(){
    if(!armed)return;
    var t=performance.now();
    if(dirty && t-lastSend>=THROTTLE_MS){ var s=curScroll(); window.__oaSend(eventData('move',lastX,lastY,s.sx,s.sy)); dirty=false; lastSend=t; }
    raf=requestAnimationFrame(tick);
  }
  function arm(){ if(armed)return; armed=true; t0=performance.now(); dirty=false; lastSend=0;
    document.addEventListener('mousemove',onMove,true);
    document.addEventListener('click',onClick,true);
    window.addEventListener('scroll',onScroll,true);
    window.addEventListener('resize',onResize);
    document.documentElement.classList.add('oa-handoff-recording');
    raf=requestAnimationFrame(tick);
    var s=curScroll(); window.__oaSend(eventData('scroll',lastX,lastY,s.sx,s.sy));
    window.__oaSend({type:'oa:handoff:record:ready'});
  }
  function disarm(){ if(!armed)return; armed=false;
    document.removeEventListener('mousemove',onMove,true);
    document.removeEventListener('click',onClick,true);
    window.removeEventListener('scroll',onScroll,true);
    window.removeEventListener('resize',onResize);
    document.documentElement.classList.remove('oa-handoff-recording');
    if(raf)cancelAnimationFrame(raf); raf=0;
  }
  window.addEventListener('message',function(e){
    if(e.source!==window.parent)return;
    var m=e.data; if(!m||typeof m!=='object')return;
    if(m.type==='oa:handoff:record:arm')arm();
    else if(m.type==='oa:handoff:record:disarm')disarm();
  });
})();
