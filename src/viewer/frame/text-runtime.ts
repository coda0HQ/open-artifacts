import { buildTextAnchor, reAnchor } from "../../anchor";
import { COMMENT_SVG } from "../host/icons";
import { jsonForInlineScript } from "../shared/escape";

export const FRAME_TEXT_SCRIPT = `
(function(){
  if(document.querySelector('.oa-plane'))return;
  // esbuild's keepNames wraps named inner functions in __name(); that helper
  // lives in the worker bundle, not this sandboxed frame, so the injected
  // matcher sources below reference it. A passthrough shim makes them run here.
  var __name=function(f){return f};
  var buildTextAnchor=${buildTextAnchor.toString()};
  var reAnchor=${reAnchor.toString()};
  var SEL_ICON=${jsonForInlineScript(COMMENT_SVG)};
  // Walk only rendered text — skip SCRIPT/STYLE so injected code never counts
  // toward offsets. All three walkers share this filter so offsets are consistent.
  function walker(){
    return document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT,{acceptNode:function(n){
      var p=n.parentNode;
      return p&&(p.nodeName==='SCRIPT'||p.nodeName==='STYLE')?NodeFilter.FILTER_REJECT:NodeFilter.FILTER_ACCEPT;
    }});
  }
  function fullText(){
    var w=walker();var s="",n;while((n=w.nextNode()))s+=n.textContent;return s;
  }
  function offsetOf(node,off){
    // Element containers (e.g. selection starts at a <p>): map to the first/last
    // text offset inside that subtree so multi-element ranges still work.
    if(node.nodeType!==3){
      var w=walker(),total=0,n,inside=false,acc=0;
      while((n=w.nextNode())){
        var p=n;var hit=false;
        while(p){if(p===node){hit=true;break}p=p.parentNode}
        if(hit){
          if(!inside){inside=true;if(off===0)return total}
          acc+=n.textContent.length;
          if(off>0&&acc>=off)return total+n.textContent.length-(acc-off);
        }else if(inside){
          return total;
        }
        total+=n.textContent.length;
      }
      return total;
    }
    var w2=walker();var total2=0,n2;while((n2=w2.nextNode())){if(n2===node)return total2+off;total2+=n2.textContent.length;}
    return total2;
  }
  function rangeOf(start,end){
    var w=walker();
    var pos=0,n,range=document.createRange(),startSet=false;
    while((n=w.nextNode())){
      var len=n.textContent.length;
      if(!startSet&&pos+len>=start){range.setStart(n,start-pos);startSet=true;}
      if(startSet&&pos+len>=end){range.setEnd(n,end-pos);return range;}
      pos+=len;
    }
    return startSet?range:null;
  }
  var bubble=null;
  function hideBubble(){if(bubble){bubble.remove();bubble=null}}
  function postNew(anchor,point){
    hideBubble();
    if(window.__oaSend)window.__oaSend({type:'oa:anchor:new',anchor:anchor,point:point});
  }
  function showBubble(rect,anchor,point){
    hideBubble();
    bubble=document.createElement('button');
    bubble.type='button';bubble.className='oa-cm-sel';
    bubble.setAttribute('aria-label','Comment on selection');
    bubble.innerHTML=SEL_ICON+'<span>Comment</span>';
    var x=rect.left+rect.width/2,y=rect.bottom;
    // Keep the chip inside the frame viewport.
    x=Math.max(48,Math.min(x,window.innerWidth-48));
    y=Math.max(0,Math.min(y,window.innerHeight-40));
    bubble.style.left=x+'px';bubble.style.top=y+'px';
    // mousedown preventDefault keeps the selection from collapsing before click.
    bubble.addEventListener('mousedown',function(e){e.preventDefault();e.stopPropagation()});
    bubble.addEventListener('click',function(e){
      e.preventDefault();e.stopPropagation();
      postNew(anchor,point);
      var s=window.getSelection();if(s)s.removeAllRanges();
    });
    document.documentElement.appendChild(bubble);
  }
  function captureSelection(){
    // Encrypted frames: text anchors are rejected server-side — no chip, no post.
    if(window.__oaEncrypted){hideBubble();return}
    var sel=window.getSelection();
    if(!sel||sel.isCollapsed||sel.rangeCount===0){hideBubble();return}
    var r=sel.getRangeAt(0);
    var start=offsetOf(r.startContainer,r.startOffset);
    var end=offsetOf(r.endContainer,r.endOffset);
    if(end<=start){hideBubble();return}
    // Ignore pure-whitespace selections (accidental double-clicks on gaps).
    if(!fullText().slice(start,end).trim()){hideBubble();return}
    var anchor=buildTextAnchor(fullText(),start,end,window.__oaViewedVersion||1);
    var rect=r.getBoundingClientRect();
    var point={x:rect.left+rect.width/2,y:rect.bottom};
    if(window.__oaArmed){
      window.__oaArmed=null;
      if(typeof window.__oaOnArm==='function')window.__oaOnArm(null);
      postNew(anchor,point);
      return;
    }
    showBubble(rect,anchor,point);
  }
  document.addEventListener('mouseup',function(e){
    // Don't re-open the bubble when the user is clicking it.
    if(bubble&&bubble.contains(e.target))return;
    // Defer so the browser finishes updating the selection after mouseup.
    setTimeout(captureSelection,0);
  });
  document.addEventListener('selectionchange',function(){
    var sel=window.getSelection();
    if(!sel||sel.isCollapsed)hideBubble();
  });
  document.addEventListener('scroll',hideBubble,true);
  document.addEventListener('keydown',function(e){if(e.key==='Escape')hideBubble()});
  window.__oaRenderMarkers=function(list){
    if(!window.CSS||!CSS.highlights||typeof Highlight==='undefined')return;
    var run=function(){
      var text=fullText(),vv=window.__oaViewedVersion||1,hl=new Highlight(),orphans=[];
      (list||[]).forEach(function(cm){
        if(cm.done)return;
        if(!cm.anchor||cm.anchor.mode!=='text')return;
        if((cm.anchor.anchorVersion||1)>vv)return;
        var m=reAnchor(text,cm.anchor);
        if(m==='orphan'){orphans.push(cm.id);return;}
        var range=rangeOf(m.start,m.end);
        if(range)hl.add(range);
      });
      CSS.highlights.set('oa-cm',hl);
      if(window.__oaSend)window.__oaSend({type:'oa:orphans',ids:orphans});
    };
    if(window.requestIdleCallback)requestIdleCallback(run,{timeout:500});else run();
  };
  if(window.__oaComments&&window.__oaComments.length)window.__oaRenderMarkers(window.__oaComments);
})();
`;
