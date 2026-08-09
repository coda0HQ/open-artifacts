
(function(){
  var container=document.getElementById('oa-toast-container');
  if(!container)return;
  function show(msg,type){
    var el=document.createElement('div');
    el.className='oa-toast';
    el.textContent=msg;
    if(type)el.setAttribute('data-type',type);
    container.appendChild(el);
    setTimeout(function(){
      el.setAttribute('data-removing','');
      setTimeout(function(){el.remove()},200);
    },5000);
  }
  window.__oaShowError=function(msg){show(msg,'error')};
  window.__oaShowSuccess=function(msg){show(msg,'success')};
  window.__oaShowInfo=function(msg){show(msg,'info')};
})();
