document.documentElement.classList.add('js');
(function(){
  var links={};document.querySelectorAll('nav.tabs a').forEach(function(a){links[a.getAttribute('href').slice(1)]=a});
  var sections=Object.keys(links).map(function(id){return document.getElementById(id)}).filter(Boolean);
  var strip=document.querySelector('nav.tabs .inner');
  var reduced=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var current=null,navigation=null,navigationTimer=null,ratios={},last=sections[sections.length-1],ticking=false;
  function reveal(a,instant){
    if(!strip||!a)return;
    var sr=strip.getBoundingClientRect(),ar=a.getBoundingClientRect();
    var left=strip.scrollLeft+ar.left-sr.left,right=left+ar.width,start=strip.scrollLeft,end=start+strip.clientWidth,target=null;
    if(left<start)target=left;else if(right>end)target=right-strip.clientWidth;
    if(target!==null){target=Math.max(0,target);strip.scrollTo({left:target,behavior:instant||reduced||target===0?'auto':'smooth'})}
  }
  function mark(id,instant){
    if(!links[id])return;
    if(current!==id){current=id;Object.keys(links).forEach(function(k){links[k].classList.toggle('active',k===current)})}
    reveal(links[id],instant);
  }
  function atEnd(){var maxScroll=document.documentElement.scrollHeight-window.innerHeight;return window.scrollY>=maxScroll-2}
  function markVisible(){
    if(last&&atEnd()){mark(last.id,false);return}
    var best=null,bestR=0;
    sections.forEach(function(s){var r=ratios[s.id]||0;if(r>bestR){bestR=r;best=s.id}});
    if(best)mark(best);
  }
  function endNavigation(){if(!navigation)return;navigation=null;clearTimeout(navigationTimer);navigationTimer=null;markVisible()}
  function beginNavigation(id){navigation=id;clearTimeout(navigationTimer);navigationTimer=setTimeout(endNavigation,1400)}
  function settle(id){requestAnimationFrame(function(){requestAnimationFrame(function(){reveal(links[id],false)})});setTimeout(function(){reveal(links[id],false)},500)}
  Object.keys(links).forEach(function(id){links[id].addEventListener('click',function(){beginNavigation(id);mark(id,false);settle(id)})});
  window.addEventListener('hashchange',function(){var id=location.hash.slice(1);beginNavigation(id);mark(id,false);settle(id)});
  window.addEventListener('scrollend',endNavigation);
  var initial=location.hash.slice(1)||sections[0].id;if(location.hash)beginNavigation(initial);mark(initial,true);settle(initial);
  function markEnd(){ticking=false;if(!navigation&&last&&atEnd())mark(last.id,false)}
  window.addEventListener('scroll',function(){if(!ticking){ticking=true;requestAnimationFrame(markEnd)}},{passive:true});
  markEnd();
  if(!('IntersectionObserver'in window))return;
  var io=new IntersectionObserver(function(entries){
    entries.forEach(function(e){ratios[e.target.id]=e.isIntersecting?e.intersectionRatio:0});
    if(!navigation)markVisible();
  },{rootMargin:'-15% 0px -55% 0px',threshold:[0,.1,.25,.5,.75,1]});
  sections.forEach(function(s){io.observe(s)});
})();
document.querySelectorAll('.codeblock button.copy').forEach(function(btn){btn.addEventListener('click',function(){var pre=btn.closest('.codeblock').querySelector('pre');var text=pre.innerText;function done(){btn.classList.add('copied');setTimeout(function(){btn.classList.remove('copied')},1500)}if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(text).then(done).catch(done)}else{var r=document.createElement('textarea');r.value=text;document.body.appendChild(r);r.select();try{document.execCommand('copy')}catch(e){}r.remove();done()}})});
(function(){if(!('IntersectionObserver'in window)){document.querySelectorAll('[data-reveal]').forEach(function(e){e.classList.add('in')});return}var io=new IntersectionObserver(function(entries){for(var i=0;i<entries.length;i++){if(entries[i].isIntersecting){entries[i].target.classList.add('in');io.unobserve(entries[i].target)}}},{threshold:0.12,rootMargin:'0px 0px -8% 0px'});document.querySelectorAll('[data-reveal]').forEach(function(el){Array.from(el.children).forEach(function(c,ci){c.style.setProperty('--i',ci)});io.observe(el)})})();
(function(){var id='7ujo'+Math.random().toString(36).slice(2,8);var v=1;function emit(){var title=document.getElementById('d-title').value||'Untitled';var ch=document.getElementById('d-channel').value||'';var resp=document.getElementById('d-response');var url='https://coda0.com/a/'+id;var note=v===1?'(first publish)':'(channel update)';var body='{\n  <span class="k">"id"</span>: <span class="s">"'+id+'"</span>,\n  <span class="k">"url"</span>: <span class="s">"'+url+'"</span>,\n  <span class="k">"version"</span>: '+v+'\n}';resp.innerHTML='<span class="status">201 '+note+'</span>\n'+body;v++;var toast=document.getElementById('d-toast');toast.textContent=url;toast.classList.add('show');setTimeout(function(){toast.classList.remove('show')},2200)}document.getElementById('d-publish').addEventListener('click',emit)})();
