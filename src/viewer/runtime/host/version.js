
(function(){
  var sel=document.getElementById('oa-version-select');
  if(!sel)return;
  sel.addEventListener('change',function(){
    if(!sel.value)return;
    try{
      var url=new URL(sel.value,location.origin);
      location.search=url.search;
    }catch(e){
      location.href=sel.value;
    }
  });
})();
