import { MOON_SVG, SUN_SVG } from "./icons";

export const THEME_SCRIPT = `
(function(){
  var root=document.documentElement,KEY="oa-theme",saved=null;
  try{saved=localStorage.getItem(KEY)}catch(e){}
  if(saved==="light"||saved==="dark"){
    root.setAttribute("data-theme",saved);
  }else{
    var dark=window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches;
    root.setAttribute("data-theme",dark?"dark":"light");
  }
  var btn=document.getElementById("oa-theme-toggle");
  if(!btn)return;
  function paint(){
    var t=root.getAttribute("data-theme");
    btn.innerHTML=(t==="dark"?${JSON.stringify(MOON_SVG)}:${JSON.stringify(SUN_SVG)})+'<span class="oa-header-action-label">Theme</span>';
    btn.title="Theme: "+(t||"auto");
    btn.setAttribute("aria-label",t==="dark"?"Switch to light theme":"Switch to dark theme");
  }
  btn.addEventListener("click",function(){
    var t=root.getAttribute("data-theme");
    var next=t==="dark"?"light":"dark";
    root.setAttribute("data-theme",next);
    try{localStorage.setItem(KEY,next)}catch(e){}
    paint();
    // Keep the sandboxed frame on the same theme (pins/highlights use frame tokens).
    if(typeof window.__oaToFrame==="function")window.__oaToFrame({type:"oa:theme",theme:next});
  });
  paint();
})();
`;
