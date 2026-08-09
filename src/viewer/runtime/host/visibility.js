
(function(){
  var sel=document.getElementById('oa-visibility-select');
  if(!sel)return;
  var id=window.__oaBridgeId;
  if(!id)return;
  var prev=sel.value;
  sel.addEventListener('change',function(){
    var next=sel.value;
    sel.disabled=true;
    sel.setAttribute('aria-busy','true');
    fetch('/api/artifacts/'+id,{method:'PATCH',headers:{'content-type':'application/json','X-OA-CSRF':'1'},body:JSON.stringify({visibility:next})})
      .then(function(r){if(!r.ok)throw new Error('Failed to update visibility');return r.json()})
      .then(function(){prev=next})
      .catch(function(e){
        sel.value=prev;
        var msg=e.message||'Failed to update visibility. Please try again.';
        if(window.__oaShowError)window.__oaShowError(msg);
        else if(console&&console.error)console.error(msg);
      })
      .finally(function(){
        sel.disabled=false;
        sel.removeAttribute('aria-busy');
      });
  });
})();
