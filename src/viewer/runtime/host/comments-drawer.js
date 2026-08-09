
(function(){
  var toggle=document.querySelector('.oa-cm-toggle');
  var drawer=document.getElementById('oa-cm-drawer');
  if(!toggle||!drawer)return;
  var closeBtn=drawer.querySelector('.oa-cm-close');
  var transitioning=false;
  function open(){
    if(transitioning)return;
    transitioning=true;
    drawer.setAttribute('data-open','');
    drawer.setAttribute('aria-hidden','false');
    toggle.setAttribute('aria-expanded','true');
    setTimeout(function(){transitioning=false},180);
  }
  function shut(){
    if(transitioning)return;
    transitioning=true;
    drawer.removeAttribute('data-open');
    drawer.setAttribute('aria-hidden','true');
    toggle.setAttribute('aria-expanded','false');
    setTimeout(function(){transitioning=false},180);
  }
  toggle.addEventListener('click',function(){drawer.hasAttribute('data-open')?shut():open()});
  if(closeBtn)closeBtn.addEventListener('click',shut);
  document.addEventListener('keydown',function(e){if(e.key==='Escape'&&drawer.hasAttribute('data-open'))shut()});
})();
