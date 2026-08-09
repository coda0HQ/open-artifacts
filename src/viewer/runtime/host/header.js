
(function(){
  var root=document.querySelector('.oa-header-overflow');
  var button=document.getElementById('oa-header-more');
  var panel=document.getElementById('oa-header-panel');
  if(!root||!button||!panel)return;
  function hasControls(){
    for(var i=0;i<panel.children.length;i++){
      var child=panel.children[i];
      if(child.id!=='oa-account-slot'||child.children.length>0)return true;
    }
    return false;
  }
  function close(restore){
    root.removeAttribute('data-open');
    button.setAttribute('aria-expanded','false');
    var accountButton=panel.querySelector('.oa-account-btn');
    var accountMenu=panel.querySelector('.oa-account-menu');
    if(accountMenu)accountMenu.hidden=true;
    if(accountButton)accountButton.setAttribute('aria-expanded','false');
    if(restore&&!button.hidden)button.focus();
  }
  function sync(){
    button.hidden=!hasControls();
    if(button.hidden)close(false);
  }
  window.__oaSyncHeaderOverflow=sync;
  window.__oaRestoreHeaderControlFocus=function(control){
    if(control&&control.offsetParent!==null){control.focus();return}
    if(!button.hidden&&button.offsetParent!==null)button.focus();
  };
  button.addEventListener('click',function(){
    var open=!root.hasAttribute('data-open');
    if(open){root.setAttribute('data-open','');button.setAttribute('aria-expanded','true')}
    else close(false);
  });
  panel.addEventListener('click',function(e){
    var action=e.target.closest&&e.target.closest('button,a');
    if(action&&!action.classList.contains('oa-account-btn'))close(false);
  });
  document.addEventListener('click',function(e){if(!root.contains(e.target))close(false)});
  document.addEventListener('keydown',function(e){if(e.key==="Escape"&&root.hasAttribute('data-open'))close(true)});
  if(window.matchMedia){
    var narrow=window.matchMedia('(max-width:52rem)');
    var onChange=function(){if(!narrow.matches)close(false)};
    if(narrow.addEventListener)narrow.addEventListener('change',onChange);
  }
  sync();
})();
