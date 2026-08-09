
(function(){
  var toggle=document.querySelector('.oa-cm-toggle');
  var drawer=document.getElementById('oa-cm-drawer');
  if(!toggle||!drawer)return;
  var closeBtn=drawer.querySelector('.oa-cm-close');
  var transitioning=false;
  var transitionTimer=null;
  function markTransition(){
    transitioning=true;
    if(transitionTimer)clearTimeout(transitionTimer);
    transitionTimer=setTimeout(function(){transitioning=false;transitionTimer=null},180);
  }
  function open(){
    if(drawer.hasAttribute('data-open'))return true;
    if(transitioning)return false;
    // Respect a dock that owns irreplaceable in-flight work. Its manager
    // reports the refusal and leaves comments closed.
    var active=window.__oaDock&&window.__oaDock.getActive();
    if(active&&!window.__oaDock.close(active))return false;
    markTransition();
    drawer.setAttribute('data-open','');
    drawer.setAttribute('aria-hidden','false');
    toggle.setAttribute('aria-expanded','true');
    return true;
  }
  function shut(){
    if(!drawer.hasAttribute('data-open'))return true;
    // Closing must remain available during the opening transition so a dock
    // click can always enforce mutual exclusion immediately.
    markTransition();
    drawer.removeAttribute('data-open');
    drawer.setAttribute('aria-hidden','true');
    toggle.setAttribute('aria-expanded','false');
    return true;
  }
  window.__oaCommentsDrawer={
    open:open,
    close:shut,
    isOpen:function(){return drawer.hasAttribute('data-open');}
  };
  toggle.addEventListener('click',function(){window.__oaCommentsDrawer.isOpen()?shut():open()});
  if(closeBtn)closeBtn.addEventListener('click',shut);
  document.addEventListener('keydown',function(e){if(e.key==='Escape'&&drawer.hasAttribute('data-open'))shut()});
})();
