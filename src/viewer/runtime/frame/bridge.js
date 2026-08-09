
(function(){
  var root=document.documentElement;
  function send(msg){if(window.parent&&window.parent!==window)window.parent.postMessage(msg,"*")}
  window.__oaSend=send;
  window.__oaComments=[];
  window.addEventListener("message",function(e){
    if(e.source!==window.parent)return;
    var msg=e.data;
    if(!msg||typeof msg!=="object")return;
    if(msg.type==="oa:theme"){
      if(msg.theme==="light"||msg.theme==="dark")root.setAttribute("data-theme",msg.theme);
    }else if(msg.type==="oa:config"){
      // Encrypted artifacts reject text anchors server-side (REQ-017); the
      // frame must not offer the selection→Comment chip for them.
      window.__oaEncrypted=!!msg.encrypted;
    }else if(msg.type==="oa:arm"){
      window.__oaArmed=msg.mode||null;
      if(typeof window.__oaOnArm==="function")window.__oaOnArm(window.__oaArmed);
    }else if(msg.type==="oa:comments"){
      window.__oaComments=Array.isArray(msg.list)?msg.list:[];
      window.__oaViewedVersion=typeof msg.viewedVersion==="number"?msg.viewedVersion:1;
      if(typeof window.__oaRenderMarkers==="function")window.__oaRenderMarkers(window.__oaComments);
    }
  });
  // Mode is a runtime property of the artifact content (a canvas has a
  // transformed .oa-plane), so the frame detects it and reports it: the host
  // hides the drawer toggle on a canvas (comments live as pins at their point,
  // Figma-style) and keeps it on a document (comments list in the drawer,
  // Notion-style). The armed comment cursor is canvas-only — on a document the
  // native text caret must stay so a selection can be made.
  var pl=document.querySelector('.oa-plane');
  window.__oaMode=(pl&&getComputedStyle(pl).transform!=='none')?'canvas':'text';
  window.__oaOnArm=function(armed){root.classList.toggle('oa-cm-arming',!!armed&&window.__oaMode==='canvas')};
  send({type:"oa:ready",mode:window.__oaMode});
})();
