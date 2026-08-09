import type { CommentMeta } from "../../domain";
import { jsonForInlineScript } from "../shared/escape";
import {
  COMMENT_ADD_SVG,
  DONE_CHECK_SVG,
  MORE_DOTS_SVG,
  SEND_ARROW_SVG,
} from "./icons";

export function hostBridgeScript(artifactId: string): string {
  return `
(function(){
  var frame=document.getElementById("oa-frame");
  if(!frame)return;
  var ID=${jsonForInlineScript(artifactId)};
  window.__oaBridgeId=ID;
  function post(msg){if(frame.contentWindow)frame.contentWindow.postMessage(msg,"*")}
  window.__oaToFrame=post;
  function theme(){return document.documentElement.getAttribute("data-theme")||"light"}
  function inlined(){
    var el=document.getElementById("oa-cm-data");
    if(!el)return[];
    try{return JSON.parse(el.textContent||"[]")}catch(e){return[]}
  }
  window.__oaInlinedComments=inlined;
  window.addEventListener("message",function(e){
    if(e.source!==frame.contentWindow)return;
    var msg=e.data;
    if(!msg||typeof msg!=="object")return;
    if(msg.type==="oa:ready"){
      // Canvas: comments are pins, so the pin tool appears — but the drawer
      // stays as the way to read the whole thread (a pin off-screen or on a
      // done comment is otherwise unreachable). Document: comments are
      // text-selection chips, so the pin tool goes away. Encrypted unlock
      // shells keep the tool as the unanchored compose entry (text anchors are
      // rejected server-side).
      window.__oaMode=msg.mode==="canvas"?"canvas":"text";
      var tool=document.querySelector(".oa-cm-tool");
      var unlock=document.querySelector(".oa-unlock");
      if(window.__oaMode==="canvas"){
        if(tool)tool.style.display="";
      }else{
        if(tool&&!unlock)tool.style.display="none";
      }
      // Unlock shells keep .oa-unlock in the DOM; tell the frame so text-anchor
      // capture stays off (REQ-017 — encrypted interactive comments are unanchored).
      post({type:"oa:config",encrypted:!!unlock});
      post({type:"oa:theme",theme:theme()});
      post({type:"oa:comments",list:(window.__oaLiveComments?window.__oaLiveComments():inlined()),viewedVersion:window.__oaViewedVersion||1});
    }else if(msg.type==="oa:anchor:new"){
      if(typeof window.__oaOnAnchorNew==="function")window.__oaOnAnchorNew(msg);
    }else if(msg.type==="oa:anchor:open"){
      if(typeof window.__oaOnAnchorOpen==="function")window.__oaOnAnchorOpen(msg);
    }else if(msg.type==="oa:orphans"){
      if(typeof window.__oaOnOrphans==="function")window.__oaOnOrphans(msg);
    }
  });
})();
`;
}

// The serve-time-inlined public comment list, embedded as JSON for the host
// bridge to forward into the frame (marker rendering happens frame-side). Only
// public fields cross — never the delete-token hash.
export function commentsDataScript(comments: CommentMeta[]): string {
  const publicList = comments.map((cm) => ({
    id: cm.id,
    author: cm.author,
    body: cm.body,
    anchor: cm.anchor,
    done: cm.done,
    createdAt: cm.createdAt,
  }));
  return `<script type="application/json" id="oa-cm-data">${jsonForInlineScript(
    publicList,
  )}</script>`;
}

// Host-side interactive UI (tasks 009+010): the "add comment" tool that arms
// the frame, the compose popover positioned at the frame-reported point, the
// create/delete network calls (the host is the only party that fetches), local
// identity + delete-token storage, and drawer rendering. All comment fields are
// rendered with textContent (never innerHTML) — author/body/quote are untrusted.
export const HOST_UI_SCRIPT = `
(function(){
  // Cache DOM references
  var frame=document.getElementById("oa-frame");
  var header=document.querySelector(".oa-header");
  var drawer=document.getElementById("oa-cm-drawer");
  var list=document.getElementById("oa-cm-list");
  var toggle=document.querySelector(".oa-cm-toggle");
  var filterBar=document.getElementById("oa-cm-filter");
  var ID=window.__oaBridgeId;
  if(!frame||!ID)return;
  var drawerErrEl=document.getElementById("oa-cm-drawer-err");
  var drawerErrTimer=null;

  function headerH(){
    if(!header)return 40;
    return Math.round(header.getBoundingClientRect().height);
  }

  // Unified localStorage access with error handling
  var storage={
    get:function(key){try{return localStorage.getItem(key)}catch(e){return null}},
    set:function(key,val){try{localStorage.setItem(key,val)}catch(e){}},
    remove:function(key){try{localStorage.removeItem(key)}catch(e){}}
  };

  function drawerErr(msg){
    if(!drawerErrEl)return;
    drawerErrEl.textContent=msg;drawerErrEl.removeAttribute("hidden");
    if(drawerErrTimer)clearTimeout(drawerErrTimer);
    drawerErrTimer=setTimeout(function(){drawerErrEl.setAttribute("hidden","")},5000);
  }
  function getName(){return storage.get("oa-cm-name")||""}
  function setName(v){storage.set("oa-cm-name",v)}
  function saveToken(id,t){storage.set("oa-cm-dt-"+id,t)}
  function getToken(id){return storage.get("oa-cm-dt-"+id)}
  function dropToken(id){storage.remove("oa-cm-dt-"+id)}
  // Owner moderation: /a/:id?wt=<artifact write token> grants delete on every
  // comment (the server already accepts the write token on DELETE). The token is
  // moved straight into storage and stripped from the URL so it stays out of
  // history, and it never crosses into the frame.
  function ownerToken(){return storage.get("oa-cm-wt-"+ID)}
  (function(){try{
    var u=new URL(location.href),wt=u.searchParams.get("wt");
    if(!wt)return;
    storage.set("oa-cm-wt-"+ID,wt);
    u.searchParams.delete("wt");
    history.replaceState(null,"",u.pathname+(u.search||"")+u.hash);
  }catch(e){}})();
  function deleteTokenFor(id){return getToken(id)||ownerToken()}

  var state=(window.__oaInlinedComments?window.__oaInlinedComments():[])||[];
  // The bridge answers oa:ready from here rather than re-reading the serve-time
  // seed: on the encrypted path the frame only exists after decrypt, so the
  // thread may already have changed by the time it announces itself.
  window.__oaLiveComments=function(){return state};
  var orphans={};
  // Done comments drop out of the default "Open" view; the filter is how they
  // come back. Markers in the frame follow the same rule (a done thread is
  // resolved, so its pin/highlight goes quiet).
  var filter="open";
  // Unlock shells keep .oa-unlock in the DOM (hidden after decrypt). Encrypted
  // artifacts only allow unanchored interactive comments (text anchors rejected).
  var encrypted=!!document.querySelector(".oa-unlock");

  var arm=document.createElement("button");
  arm.type="button";arm.className="oa-cm-tool";arm.innerHTML=${jsonForInlineScript(COMMENT_ADD_SVG)};
  arm.setAttribute("aria-pressed","false");arm.title="Add a comment";arm.setAttribute("aria-label","Add a comment");
  // Pin tool is canvas-only. Hide until oa:ready reports canvas; encrypted
  // unlock shells keep it visible as the unanchored compose entry.
  if(!encrypted)arm.style.display="none";
  if(toggle&&toggle.parentNode)toggle.parentNode.insertBefore(arm,toggle);else if(header)header.appendChild(arm);
  function setArmed(on){
    arm.setAttribute("aria-pressed",on?"true":"false");
    if(window.__oaToFrame)window.__oaToFrame({type:"oa:arm",mode:on?"on":null});
  }
  arm.addEventListener("click",function(e){
    // Encrypted: unanchored compose only. Canvas: arm for pin drop.
    if(encrypted){openCompose(null,{x:window.innerWidth/2,y:headerH()+48});return}
    setArmed(arm.getAttribute("aria-pressed")!=="true");
  });

  var pop=document.createElement("div");
  pop.className="oa-cm-compose";pop.id="oa-cm-compose";pop.setAttribute("hidden","");
  var nameEl=document.createElement("input");nameEl.type="text";nameEl.className="oa-cm-name";nameEl.placeholder="Your name (optional)";nameEl.setAttribute("aria-label","Your name");nameEl.setAttribute("hidden","");
  var row=document.createElement("div");row.className="oa-cm-row";
  var bodyEl=document.createElement("textarea");bodyEl.className="oa-cm-body";bodyEl.rows=1;bodyEl.placeholder="Add a comment";bodyEl.setAttribute("aria-label","Comment");
  var sendBtn=document.createElement("button");sendBtn.type="button";sendBtn.className="oa-cm-send";sendBtn.setAttribute("aria-label","Post comment");sendBtn.innerHTML=${jsonForInlineScript(SEND_ARROW_SVG)};
  row.appendChild(bodyEl);row.appendChild(sendBtn);
  var errEl=document.createElement("div");errEl.className="oa-cm-err";errEl.setAttribute("role","alert");errEl.setAttribute("hidden","");
  pop.appendChild(nameEl);pop.appendChild(row);pop.appendChild(errEl);
  document.body.appendChild(pop);

  var pending=null,posting=false;
  function autosize(){bodyEl.style.height="auto";bodyEl.style.height=Math.min(bodyEl.scrollHeight,128)+"px"}
  function refreshSend(){if(bodyEl.value.trim())sendBtn.setAttribute("data-ready","");else sendBtn.removeAttribute("data-ready")}
  function clearErr(){errEl.textContent="";errEl.setAttribute("hidden","")}
  function closePop(){pop.setAttribute("hidden","");pending=null;bodyEl.value="";clearErr();autosize();refreshSend()}
  function openCompose(anchor,point){
    pending=anchor||null;setArmed(false);clearErr();
    var saved=getName();
    if(saved){nameEl.value=saved;nameEl.setAttribute("hidden","")}else{nameEl.value="";nameEl.removeAttribute("hidden")}
    bodyEl.value="";refreshSend();
    var px=(point&&point.x)||16,py=((point&&point.y)||16)+headerH();
    pop.style.left=Math.max(8,Math.min(px,window.innerWidth-360))+"px";
    pop.style.top=Math.max(8,Math.min(py,window.innerHeight-120))+"px";
    pop.removeAttribute("hidden");autosize();bodyEl.focus();
  }
  bodyEl.addEventListener("input",function(){autosize();refreshSend();clearErr()});
  bodyEl.addEventListener("keydown",function(e){if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();submit()}});
  document.addEventListener("keydown",function(e){if(e.key==="Escape"&&!pop.hasAttribute("hidden"))closePop()});
  document.addEventListener("mousedown",function(e){if(pop.hasAttribute("hidden"))return;if(pop.contains(e.target)||arm===e.target||arm.contains(e.target))return;closePop()});
  window.__oaOnAnchorNew=function(msg){
    var a=msg&&msg.anchor||null;
    // Defense in depth: never open compose with a text anchor on encrypted.
    if(encrypted&&a&&a.mode==="text")a=null;
    openCompose(a,msg&&msg.point);
  };
  sendBtn.addEventListener("click",submit);
  function submit(){
    var body=bodyEl.value.trim();if(!body||posting)return;
    var author=nameEl.value.trim();if(author)setName(author);
    posting=true;clearErr();
    var postHeaders={"content-type":"application/json"},ot=ownerToken();if(ot)postHeaders.authorization="Bearer "+ot;
    fetch("/api/artifacts/"+ID+"/comments",{method:"POST",headers:postHeaders,
      body:JSON.stringify({body:body,author:author||null,anchor:pending,anchorVersion:(pending&&pending.anchorVersion)||1})})
      .then(function(r){return r.ok?r.json():Promise.reject(r.status)})
      .then(function(cm){if(cm.deleteToken)saveToken(cm.id,cm.deleteToken);
        state.push({id:cm.id,author:cm.author,body:cm.body,anchor:cm.anchor,done:!!cm.done,createdAt:cm.createdAt});
        sync();closePop();
        // Live bridge: if a live session's WebSocket is up, stream the
        // comment to the agent's watcher right away — the agent polls it as
        // a comment event instead of waiting for a pick+submit.
        if(window.__oaLivePush)window.__oaLivePush({type:"comment",id:cm.id,body:cm.body,author:cm.author||null,anchor:cm.anchor||null,createdAt:cm.createdAt});
      }).catch(function(err){
        errEl.textContent=typeof err==="number"?"Could not post ("+err+")":"Could not post";
        errEl.removeAttribute("hidden");
      }).then(function(){posting=false});
  }

  // Counts the default (open) view, not the whole thread: a fully-done thread
  // otherwise shows a badge of "3" over a drawer reading "No open comments."
  function bumpCount(){
    var n=state.filter(function(c){return !c.done}).length;
    if(toggle){
      if(n>0){toggle.setAttribute("data-count",String(n));var c=toggle.querySelector(".oa-cm-count");if(c)c.textContent=String(n)}
      else{toggle.removeAttribute("data-count");var c2=toggle.querySelector(".oa-cm-count");if(c2)c2.textContent="0"}
    }
    var hc=document.getElementById("oa-cm-head-count");
    if(hc){if(n>0){hc.setAttribute("data-count",String(n));hc.textContent=String(n)}else{hc.removeAttribute("data-count");hc.textContent="0"}}
  }
  function relTime(iso){
    var t=Date.parse(iso);if(isNaN(t))return"";
    var s=Math.max(0,(Date.now()-t)/1e3);
    if(s<45)return"just now";
    var m=Math.round(s/60);if(m<60)return m===1?"1 minute ago":m+" minutes ago";
    var h=Math.round(m/60);if(h<24)return h===1?"1 hour ago":h+" hours ago";
    var d=Math.round(h/24);if(d<7)return d===1?"1 day ago":d+" days ago";
    return new Date(t).toLocaleDateString(undefined,{month:"short",day:"numeric"});
  }
  function initialOf(name){
    if(!name)return"?";
    var ch=[...name.trim()][0];
    return ch?ch.toUpperCase():"?";
  }
  // Scoped to the drawer, not the list: the filter dropdown lives in the head
  // and must close alongside the per-comment menus.
  function closeMenus(except){
    if(!drawer)return;
    var menus=drawer.querySelectorAll(".oa-cm-menu");
    for(var i=0;i<menus.length;i++){
      if(menus[i]===except)continue;
      menus[i].setAttribute("hidden","");
      var btn=menus[i].parentElement&&menus[i].parentElement.querySelector('[aria-haspopup="menu"]');
      if(btn)btn.setAttribute("aria-expanded","false");
    }
  }
  function toggleMenu(btn,menu){
    var open=menu.hasAttribute("hidden");
    closeMenus(menu);
    if(open){menu.removeAttribute("hidden");btn.setAttribute("aria-expanded","true")}
    else{menu.setAttribute("hidden","");btn.setAttribute("aria-expanded","false")}
  }
  function itemEl(cm){
    var item=document.createElement("div");item.className="oa-cm-item";item.setAttribute("data-id",cm.id);
    if(cm.done)item.setAttribute("data-done","");
    var avatar=document.createElement("div");avatar.className="oa-cm-avatar";avatar.setAttribute("aria-hidden","true");
    avatar.textContent=initialOf(cm.author);
    var stack=document.createElement("div");stack.className="oa-cm-stack";
    var top=document.createElement("div");top.className="oa-cm-top";
    var title=document.createElement("div");title.className="oa-cm-title";title.textContent=cm.body;
    var trail=document.createElement("span");trail.className="oa-cm-trail";
    var actions=document.createElement("div");actions.className="oa-cm-actions";
    var more=document.createElement("button");more.type="button";more.className="oa-cm-more";
    more.setAttribute("aria-label","More actions");more.setAttribute("aria-expanded","false");more.setAttribute("aria-haspopup","menu");
    more.innerHTML=${jsonForInlineScript(MORE_DOTS_SVG)};
    var menu=document.createElement("div");menu.className="oa-cm-menu";menu.setAttribute("role","menu");menu.setAttribute("hidden","");
    // Always-available action, so the more control is never an empty menu on a
    // comment this viewer cannot delete.
    var copy=document.createElement("button");copy.type="button";copy.setAttribute("role","menuitem");copy.textContent="Copy text";
    copy.addEventListener("click",function(e){
      e.stopPropagation();closeMenus();
      try{navigator.clipboard.writeText(cm.body)}catch(err){}
    });
    menu.appendChild(copy);
    if(deleteTokenFor(cm.id)){
      var del=document.createElement("button");del.type="button";del.className="oa-cm-del";del.setAttribute("role","menuitem");del.textContent="Delete";
      del.addEventListener("click",function(e){e.stopPropagation();closeMenus();remove(cm.id)});
      menu.appendChild(del);
    }
    more.addEventListener("click",function(e){e.stopPropagation();toggleMenu(more,menu)});
    actions.appendChild(more);actions.appendChild(menu);trail.appendChild(actions);
    var doneBtn=document.createElement("button");
    doneBtn.type="button";doneBtn.className="oa-cm-done";
    doneBtn.setAttribute("aria-pressed",cm.done?"true":"false");
    doneBtn.setAttribute("aria-label",cm.done?"Mark not done":"Mark done");
    doneBtn.innerHTML=${jsonForInlineScript(DONE_CHECK_SVG)};
    doneBtn.addEventListener("click",function(e){e.stopPropagation();toggleDone(cm.id)});
    // Always offered: the server is the authority on who may resolve, and a
    // refused toggle rolls back and says why rather than being pre-disabled.
    trail.appendChild(doneBtn);
    top.appendChild(title);top.appendChild(trail);
    var byline=document.createElement("div");byline.className="oa-cm-byline";
    var who=document.createElement("span");
    if(cm.author){who.className="oa-cm-author";who.textContent=cm.author}else{who.className="oa-cm-anon";who.textContent="anonymous"}
    byline.appendChild(who);
    byline.appendChild(document.createTextNode(" \\u00b7 "));
    var time=document.createElement("span");time.className="oa-cm-time";time.textContent=relTime(cm.createdAt);time.title=cm.createdAt||"";
    byline.appendChild(time);
    if(cm.anchor){
      var vv=window.__oaViewedVersion||1,av=cm.anchor.anchorVersion||1;
      if(av!==vv){byline.appendChild(document.createTextNode(" "));var tag=document.createElement("span");tag.className="oa-cm-tag";tag.textContent="v"+av;byline.appendChild(tag)}
      if(orphans[cm.id]){byline.appendChild(document.createTextNode(" "));var det=document.createElement("span");det.className="oa-cm-detached";det.textContent="detached";byline.appendChild(det)}
    }
    stack.appendChild(top);stack.appendChild(byline);
    item.appendChild(avatar);item.appendChild(stack);
    return item;
  }
  function visible(){
    if(filter==="done")return state.filter(function(c){return !!c.done});
    if(filter==="all")return state.slice();
    return state.filter(function(c){return !c.done});
  }
  function renderList(){if(!list)return;list.textContent="";
    var rows=visible();
    if(!rows.length){
      var p=document.createElement("p");p.className="oa-cm-empty";
      p.textContent=!state.length?"No comments yet.":(filter==="done"?"No done comments.":"No open comments.");
      list.appendChild(p);return;
    }
    rows.forEach(function(cm){list.appendChild(itemEl(cm))});
  }
  if(filterBar){
    var filterBtn=filterBar.querySelector(".oa-cm-filter-btn");
    var filterMenu=filterBar.querySelector(".oa-cm-filter-menu");
    filterBtn.addEventListener("click",function(e){e.stopPropagation();toggleMenu(filterBtn,filterMenu)});
    filterMenu.addEventListener("click",function(e){
      var b=e.target&&e.target.closest?e.target.closest("[data-filter]"):null;
      if(!b||!filterMenu.contains(b))return;
      e.stopPropagation();
      filter=b.getAttribute("data-filter")||"open";
      var opts=filterMenu.querySelectorAll("[data-filter]");
      for(var i=0;i<opts.length;i++)opts[i].setAttribute("aria-checked",opts[i]===b?"true":"false");
      closeMenus();renderList();
    });
  }
  function toFrame(){if(window.__oaToFrame)window.__oaToFrame({type:"oa:comments",list:state,viewedVersion:window.__oaViewedVersion||1})}
  function sync(){renderList();bumpCount();toFrame()}
  // Resolving hides a comment from the default view, so the server gates it like
  // delete: the comment's own token, or the owner's write token. The control is
  // always live — we attempt, and roll back with a reason if refused.
  function toggleDone(id){
    var cm=null;for(var i=0;i<state.length;i++){if(state[i].id===id){cm=state[i];break}}
    if(!cm)return;
    var tok=deleteTokenFor(id);
    var next=!cm.done;
    // Optimistic UI — roll back on failure.
    cm.done=next;renderList();bumpCount();toFrame();
    var headers={"content-type":"application/json"};
    if(tok)headers.authorization="Bearer "+tok;
    fetch("/api/artifacts/"+ID+"/comments/"+id,{method:"PATCH",headers:headers,body:JSON.stringify({done:next})})
      .then(function(r){if(!r.ok)return Promise.reject(r.status)})
      .catch(function(s){
        cm.done=!next;renderList();bumpCount();toFrame();
        drawerErr(s===401||s===403
          ?"Only the comment's author or the artifact owner can resolve this."
          :"Could not update that comment.");
      });
  }
  function remove(id){var tok=deleteTokenFor(id);if(!tok)return;
    fetch("/api/artifacts/"+ID+"/comments/"+id,{method:"DELETE",headers:{authorization:"Bearer "+tok}})
      .then(function(r){
        if(!r.ok){drawerErr(r.status===401||r.status===403
          ?"Only the comment's author or the artifact owner can delete this."
          :"Could not delete that comment.");return}
        state=state.filter(function(c){return c.id!==id});dropToken(id);sync();
      });
  }
  // Click-away closes any open menu. Triggers and menu interiors are exempt so
  // mousedown does not race the click handler that opens/acts on them.
  document.addEventListener("mousedown",function(e){
    var t=e.target;
    if(t&&t.closest&&(t.closest(".oa-cm-menu")||t.closest('[aria-haspopup="menu"]')))return;
    closeMenus();
  });
  document.addEventListener("keydown",function(e){if(e.key==="Escape")closeMenus()});
  window.__oaOnOrphans=function(msg){
    orphans={};
    (msg&&msg.ids||[]).forEach(function(id){if(typeof id==="string")orphans[id]=true});
    renderList();
  };
  window.__oaOnAnchorOpen=function(msg){
    if(drawer){drawer.setAttribute("data-open","");drawer.setAttribute("aria-hidden","false");if(toggle)toggle.setAttribute("aria-expanded","true")}
    var id=msg&&msg.ids&&msg.ids[0];if(!id||!list||typeof id!=="string")return;
    // Avoid attribute-selector injection from frame-supplied ids: walk children.
    var el=null,kids=list.children;
    for(var i=0;i<kids.length;i++){if(kids[i].getAttribute("data-id")===id){el=kids[i];break}}
    if(el){el.scrollIntoView({block:"center"});el.setAttribute("data-focus","");setTimeout(function(){el.removeAttribute("data-focus")},1600)}
  };

  // Upgrade the server-rendered list so this browser's own comments gain a
  // Delete control (the server can't know which delete tokens we hold), and
  // sync the badge to the filtered view this render actually produced.
  renderList();bumpCount();
})();
`;
