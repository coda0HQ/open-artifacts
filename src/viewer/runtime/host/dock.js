
(function(){
  var docks={}, active=null;
  function refuse(d){ if(d&&d.refuseMessage&&window.__oaShowError){ var m=d.refuseMessage(); if(m)window.__oaShowError(m); } }
  function open(name){
    var d=docks[name]; if(!d)return false;
    if(active===name)return true;
    if(active){ var o=docks[active]; if(o&&!o.close()){ refuse(o); return false; } }
    d.open(); active=name; return true;
  }
  function close(name){
    var d=docks[name]; if(!d||active!==name)return false;
    if(!d.close()){ refuse(d); return false; }
    active=null; if(d.restoreFocus)d.restoreFocus(); return true;
  }
  window.__oaDock={
    register:function(name,api){docks[name]=api;},
    open:open,
    close:close,
    toggle:function(name){ var d=docks[name]; if(!d)return false; return active===name?close(name):open(name); },
    isActive:function(name){return active===name;}
  };
  // One Escape closes the active dock, but only after any open comments surface
  // (drawer/compose/menu) has had its turn. The surfaces' own Escape handlers
  // close them synchronously in the bubble phase, so this listener is captured
  // to run FIRST and bail when one is still open - the surface closes on this
  // keypress, the dock on the next. A refused close (Handoff recording/playing)
  // surfaces the dock's refuseMessage instead.
  document.addEventListener('keydown',function(e){
    if(e.key!=='Escape'||!active)return;
    // A visible live guide takes the first Escape — close the banner (and its
    // disclosure) instead of the whole dock. This capture handler runs before
    // the guide's own bubble handler, which is why the check lives here.
    var guide=document.getElementById('oa-live-guide');
    if(guide&&!guide.hidden){
      guide.hidden=true;
      var details=document.getElementById('oa-live-guide-details');
      if(details&&!details.hidden){
        details.hidden=true;
        var t=document.getElementById('oa-live-guide-toggle');
        if(t)t.setAttribute('aria-expanded','false');
      }
      return;
    }
    if(document.querySelector('.oa-cm-drawer[data-open], #oa-cm-compose:not([hidden]), .oa-cm-menu:not([hidden])'))return;
    close(active);
  }, true);
})();
