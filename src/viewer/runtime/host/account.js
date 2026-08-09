
(function(){
  var slot=document.getElementById('oa-account-slot');
  if(!slot)return;
  function initial(name){var ch=[...String(name||'').trim()][0];return ch?ch.toUpperCase():'?';}
  function initialAvatar(name){var fallback=document.createElement('span');fallback.className='oa-account-av';fallback.setAttribute('aria-hidden','true');fallback.textContent=initial(name);return fallback;}
  function syncOverflow(){if(window.__oaSyncHeaderOverflow)window.__oaSyncHeaderOverflow();}
  function clear(){slot.innerHTML='';syncOverflow();}
  function showLoading(){slot.innerHTML='<div class="oa-account-loading" role="status" aria-label="Loading account"></div>';syncOverflow();}
  function renderSignin(){slot.innerHTML='<a class="oa-account-signin" href="/login">Sign in</a>';syncOverflow();}
  function renderUser(name,picture){
    var btn=document.createElement('button');btn.type='button';btn.id='oa-account-button';btn.className='oa-account-btn';btn.setAttribute('aria-haspopup','menu');btn.setAttribute('aria-expanded','false');btn.setAttribute('aria-controls','oa-account-menu');
    var av=initialAvatar(name);
    if(picture){
      var img=document.createElement('img');img.className='oa-account-av-image';img.src=picture;img.alt='';
      img.addEventListener('error',function(){av.replaceWith(initialAvatar(name));});
      av.textContent='';av.appendChild(img);
    }
    var nm=document.createElement('span');nm.className='oa-account-name';nm.textContent=name||'Account';
    btn.appendChild(av);btn.appendChild(nm);
    var menu=document.createElement('div');menu.id='oa-account-menu';menu.className='oa-account-menu';menu.setAttribute('role','menu');menu.hidden=true;
    var dash=document.createElement('a');dash.href='/dashboard';dash.setAttribute('role','menuitem');dash.textContent='Dashboard';
    var lo=document.createElement('button');lo.type='button';lo.setAttribute('role','menuitem');lo.textContent='Sign out';
    lo.addEventListener('click',function(){fetch('/auth/logout',{method:'POST',credentials:'same-origin'}).then(function(){location.href='/';}).catch(function(){location.href='/';});});
    menu.appendChild(dash);menu.appendChild(lo);
    btn.addEventListener('click',function(e){e.stopPropagation();var open=menu.hidden;menu.hidden=!open;btn.setAttribute('aria-expanded',String(open));});
    var closeMenu=function(e){if(e.key==='Escape'&&!menu.hidden){e.stopPropagation();menu.hidden=true;btn.setAttribute('aria-expanded','false');btn.focus();}};
    btn.addEventListener('keydown',closeMenu);menu.addEventListener('keydown',closeMenu);
    document.addEventListener('click',function(){menu.hidden=true;btn.setAttribute('aria-expanded','false');});
    slot.innerHTML='';slot.appendChild(btn);slot.appendChild(menu);syncOverflow();
  }
  showLoading();
  fetch('/api/me',{credentials:'same-origin'}).then(function(r){if(!r.ok){if(r.status===401)renderSignin();else clear();return null;}return r.json();}).then(function(me){
    if(!me){clear();return;}var user=me.user||{};var name=user.name||user.email||null;var picture=typeof user.picture==='string'?user.picture:null;if(name)renderUser(name,picture);else renderSignin();
  }).catch(clear);
})();
