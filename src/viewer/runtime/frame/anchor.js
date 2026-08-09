
(function(){
  var plane=document.querySelector('.oa-plane');
  if(!plane||getComputedStyle(plane).transform==='none')return;
  // Origin must be the UNtransformed container (.oa-canvas). The plane's own
  // getBoundingClientRect already includes translate(tx,ty), so using it and
  // then subtracting m.e/m.f double-counts pan and drops pins off-click.
  function screenToWorld(cx,cy){
    var origin=plane.parentElement||plane;
    var r=origin.getBoundingClientRect();
    var m=new DOMMatrixReadOnly(getComputedStyle(plane).transform);
    var k=m.a||1;
    return {x:Math.round((cx-r.left-m.e)/k),y:Math.round((cy-r.top-m.f)/k)};
  }
  document.addEventListener('click',function(e){
    if(!window.__oaArmed)return;
    e.stopPropagation();e.preventDefault();
    window.__oaArmed=null;
    var w=screenToWorld(e.clientX,e.clientY);
    if(window.__oaSend)window.__oaSend({type:'oa:anchor:new',anchor:{mode:'point',x:w.x,y:w.y,anchorVersion:window.__oaViewedVersion||1},point:{x:e.clientX,y:e.clientY}});
  },true);
  window.__oaRenderMarkers=function(list){
    var old=plane.querySelectorAll('.oa-cm-pin');
    for(var i=0;i<old.length;i++)old[i].remove();
    var vv=window.__oaViewedVersion||1;
    (list||[]).forEach(function(cm){
      if(cm.done)return;
      if(!cm.anchor||cm.anchor.mode!=='point')return;
      if((cm.anchor.anchorVersion||1)>vv)return;
      var pin=document.createElement('button');
      pin.className='oa-cm-pin';pin.type='button';
      pin.setAttribute('aria-label','Open comment');
      pin.style.setProperty('--x',String(cm.anchor.x));
      pin.style.setProperty('--y',String(cm.anchor.y));
      pin.setAttribute('data-id',cm.id);
      pin.addEventListener('click',function(ev){
        ev.stopPropagation();
        if(window.__oaSend)window.__oaSend({type:'oa:anchor:open',ids:[cm.id],point:{x:ev.clientX,y:ev.clientY}});
      });
      plane.appendChild(pin);
    });
  };
  if(window.__oaComments&&window.__oaComments.length)window.__oaRenderMarkers(window.__oaComments);
})();
