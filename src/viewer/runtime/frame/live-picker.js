
(function(){
  if(!window.__oaSend)return;
  var PREFIX='impeccable-live';
  var armed=false, annotEnabled=false, picked=null, hovered=null;
  var highlight=null, annotSvg=null, annotPins=null;
  var annotState={comments:[],strokes:[]};
  var DRAG_THRESHOLD=5;
  var TAGS_SKIP=new Set(['SCRIPT','STYLE','LINK','META','HEAD','SVG','PATH']);
  function own(el){return el&&(el.id&&el.id.indexOf(PREFIX)===0)|| (el.closest&&el.closest('[id^="'+PREFIX+'"]'));}
  function pickable(el){
    if(!el||el.nodeType!==1)return false;
    if(TAGS_SKIP.has(String(el.tagName||'').toUpperCase()))return false;
    if(own(el))return false;
    var r=el.getBoundingClientRect();
    return r.width>=20&&r.height>=20;
  }
  function showHighlight(el){
    if(!highlight){
      highlight=document.createElement('div');
      highlight.id=PREFIX+'-highlight';
      highlight.style.cssText='position:fixed;pointer-events:none;z-index:100001;border:2px solid var(--oa-accent,#6457f0);background:rgba(100,87,240,0.08);transition:opacity .1s';
      document.body.appendChild(highlight);
    }
    var r=el.getBoundingClientRect();
    highlight.style.left=r.left+'px';highlight.style.top=r.top+'px';
    highlight.style.width=r.width+'px';highlight.style.height=r.height+'px';
    highlight.style.display='block';
  }
  function hideHighlight(){ if(highlight)highlight.style.display='none'; }
  function extractContext(el){
    var cs=getComputedStyle(el), r=el.getBoundingClientRect();
    var p=el.parentElement;
    return {tagName:el.tagName.toLowerCase(), id:el.id||null, classes:[].slice.call(el.classList), textContent:(el.textContent||'').slice(0,500), outerHTML:el.outerHTML.slice(0,10000), computedStyles:{'font-family':cs.fontFamily,'font-size':cs.fontSize,'color':cs.color,'background':cs.backgroundColor,'border-radius':cs.borderRadius,'box-shadow':cs.boxShadow}, parentContext:p?('<'+p.tagName.toLowerCase()+(p.id?' #'+p.id:'')+('')+'>'):'', boundingRect:{width:Math.round(r.width),height:Math.round(r.height)}, rect:{x:Math.round(r.left),y:Math.round(r.top),width:Math.round(r.width),height:Math.round(r.height)}};
  }
  function onMove(e){
    if(!armed)return;
    var t=document.elementFromPoint(e.clientX,e.clientY);
    if(!t||!pickable(t)||t===hovered)return;
    hovered=t; showHighlight(t);
  }
  function pickAt(el){
    picked=el;
    // Lock immediately so a second click cannot replace this draft while the
    // host is opening the prompt. Keep picked/annotation state for submit.
    lock();
    showHighlight(picked);
    // Annotation overlay: create over the first pick, reposition on later
    // picks so pins/strokes stay over the element the user is describing.
    if(annotEnabled){ if(annotSvg) positionAnnot(picked); else showAnnot(picked); }
    window.__oaSend({type:'oa:element:picked', element:extractContext(picked)});
  }
  function onClick(e){
    if(!armed)return;
    if(own(e.target))return;
    if(!hovered||!pickable(hovered))return;
    e.preventDefault();e.stopPropagation();
    pickAt(hovered);
  }
  // Touch taps fire no mousemove before the click, so hovered stays null and
  // the click path bails — select directly on pointerdown for touch pointers.
  function onPointerDown(e){
    if(!armed||e.pointerType!=='touch')return;
    var t=e.target;
    if(own(t)||!pickable(t))return;
    e.preventDefault();e.stopPropagation();
    pickAt(t);
  }
  function onKey(e){
    if(!armed)return;
    var nav=armed?hovered:null;
    if(nav&&(e.key==='ArrowUp'||e.key==='ArrowDown')){
      var next=null;
      if(e.key==='ArrowDown'&&!e.shiftKey){next=nav.nextElementSibling;while(next&&!pickable(next))next=next.nextElementSibling;}
      else if(e.key==='ArrowUp'&&!e.shiftKey){next=nav.previousElementSibling;while(next&&!pickable(next))next=nav.previousElementSibling;}
      else if(e.key==='ArrowUp'&&e.shiftKey){next=nav.parentElement;}
      else if(e.key==='ArrowDown'&&e.shiftKey){next=nav.firstElementChild;}
      if(next){e.preventDefault();hovered=next;showHighlight(next);next.scrollIntoView({block:'nearest',behavior:'smooth'});}
    }
  }
  function lock(){
    armed=false;
    hovered=null;
    document.removeEventListener('mousemove',onMove,true);
    document.removeEventListener('click',onClick,true);
    document.removeEventListener('pointerdown',onPointerDown,true);
    document.removeEventListener('keydown',onKey,true);
  }
  function arm(){
    armed=true;
    document.addEventListener('mousemove',onMove,true);
    document.addEventListener('click',onClick,true);
    document.addEventListener('pointerdown',onPointerDown,true);
    document.addEventListener('keydown',onKey,true);
  }
  function disarm(){
    lock();
    hideHighlight();
    // Tear the annotation overlay down so a closed Live session never leaves
    // pointer-grabbing chrome over the artifact, and clear session state so a
    // reopened Live never resurrects a stale picked element or overlay.
    if(annotSvg){ annotSvg.remove(); annotSvg=null; }
    if(annotPins){ annotPins.remove(); annotPins=null; }
    annotState.comments=[]; annotState.strokes=[]; drawing=false; curStroke=null;
    // A closing session must not leave contenteditable rows in the artifact —
    // restore the original texts and unwrap the mixed-content markers.
    if(editRoot)disableEditMode(true);
    picked=null; hovered=null; annotEnabled=false;
  }
  // Annotation overlay: SVG strokes + comment pins over the picked element.
  function showAnnot(el){
    if(annotSvg)return;
    annotSvg=document.createElementNS('http://www.w3.org/2000/svg','svg');
    annotSvg.style.cssText='position:absolute;z-index:100002;pointer-events:none';
    annotPins=document.createElement('div'); annotPins.style.cssText='position:absolute;z-index:100002';
    document.body.appendChild(annotSvg); document.body.appendChild(annotPins);
    positionAnnot(el);
    annotSvg.style.pointerEvents='auto';
    annotSvg.addEventListener('pointerdown',onAnnotDown);
    annotSvg.addEventListener('pointermove',onAnnotMove);
    annotSvg.addEventListener('pointerup',onAnnotUp);
  }
  function positionAnnot(el){
    var r=el.getBoundingClientRect();
    annotSvg.style.left=r.left+'px';annotSvg.style.top=r.top+'px';annotSvg.setAttribute('width',r.width);annotSvg.setAttribute('height',r.height);
    annotPins.style.left=r.left+'px';annotPins.style.top=r.top+'px';
  }
  function localCoords(e){ var r=annotSvg.getBoundingClientRect(); return [e.clientX-r.left, e.clientY-r.top]; }
  var drawing=false, curStroke=null;
  function onAnnotDown(e){ var p=localCoords(e); if(Math.abs(e.movementX||0)<DRAG_THRESHOLD&&Math.abs(e.movementY||0)<DRAG_THRESHOLD){ dropPin(p); } else { drawing=true; curStroke={points:[p]}; } }
  function onAnnotMove(e){ if(!drawing||!curStroke)return; var p=localCoords(e); curStroke.points.push(p); redrawStrokes(); }
  function onAnnotUp(e){ if(drawing&&curStroke){ annotState.strokes.push(curStroke); drawing=false; curStroke=null; } }
  function dropPin(p){ var id='pin_'+Date.now(); annotState.comments.push({x:p[0],y:p[1],text:''}); redrawPins(); }
  function redrawStrokes(){ if(!annotSvg)return; var ns='http://www.w3.org/2000/svg'; while(annotSvg.firstChild)annotSvg.removeChild(annotSvg.firstChild); annotState.strokes.concat(curStroke?[curStroke]:[]).forEach(function(s){ var p=document.createElementNS(ns,'path'); var d=s.points.map(function(pt,i){return (i?'L':'M')+pt[0]+' '+pt[1];}).join(' '); p.setAttribute('d',d); p.setAttribute('stroke','#6457f0'); p.setAttribute('stroke-width','3'); p.setAttribute('fill','none'); p.setAttribute('stroke-linecap','round'); annotSvg.appendChild(p); }); }
  function redrawPins(){ if(!annotPins)return; annotPins.innerHTML=''; annotState.comments.forEach(function(c){ var d=document.createElement('div'); d.style.cssText='position:absolute;left:'+(c.x-9)+'px;top:'+(c.y-9)+'px;width:18px;height:18px;border-radius:50% 50% 50% 2px;background:#6457f0;'; annotPins.appendChild(d); }); }
  // --- annotation collection (host asks on submit) ---
  function sendAnnots(req){
    // Include the in-progress stroke: redrawStrokes renders it live, so a
    // submit mid-drag must not silently drop what the user sees on screen.
    var strokes=annotState.strokes.concat(drawing&&curStroke?[curStroke]:[]);
    window.__oaSend({type:'oa:live:annot:data', req:req, comments:annotState.comments.slice(), strokes:strokes});
  }

  // --- inline text editing (impeccable-style manual copy edits) ---
  // The host arms edit mode on the picked element: pure-text leaf rows become
  // contenteditable with a data-original-text snapshot; mixed-content nodes
  // get marker spans first so their text can be edited too. input events fill
  // a drafts map; Save validates (plain text only) and postMessages the
  // changed ops; the host stages them server-side for a batch Apply. Escape
  // restores the original texts without leaving edit mode.
  var MIXED_WRAP_SKIP=new Set(['SCRIPT','STYLE','TEMPLATE','NOSCRIPT','SVG','CODE','PRE']);
  var editRoot=null, editRows=null, editDrafts=null, editStyleEl=null;
  // Editable rows get a dashed outline affordance + a solid focus ring, so
  // the user (and a keyboard user's focus) can tell which rows are editable.
  // Injected as a <style> — the frame CSP allows style-src 'unsafe-inline'.
  function ensureEditStyle(){
    if(editStyleEl)return;
    editStyleEl=document.createElement('style');
    editStyleEl.id=PREFIX+'-edit-style';
    editStyleEl.textContent='[data-oa-editable]{outline:1px dashed color-mix(in oklab,var(--oa-accent,#6457f0),transparent 45%);outline-offset:2px;border-radius:2px;cursor:text}[data-oa-editable]:focus-visible{outline:2px solid var(--oa-accent,#6457f0);outline-offset:1px}';
    document.head.appendChild(editStyleEl);
  }
  // Pasted rich content is stripped to plain text so no markup enters a row
  // (Save's plain-text validation would otherwise reject the whole batch).
  function onEditPaste(e){
    var el=e.target;
    if(!el||el.nodeType!==1||el.getAttribute('contenteditable')!=='true')return;
    var cd=e.clipboardData||window.clipboardData, text='';
    if(cd){
      text=cd.getData('text/plain');
      if(!text){
        var html=cd.getData('text/html');
        if(html){ var tmp=document.createElement('div'); tmp.innerHTML=html; text=tmp.textContent||''; }
      }
    }
    if(!text)return;
    e.preventDefault();
    var sel=window.getSelection();
    if(!sel||!sel.rangeCount){ try{el.focus();}catch(err){} sel=window.getSelection(); }
    if(!sel||!sel.rangeCount)return;
    sel.deleteFromDocument();
    var node=document.createTextNode(text);
    var range=sel.getRangeAt(0);
    range.insertNode(node);
    range.setStartAfter(node); range.collapse(true);
    sel.removeAllRanges(); sel.addRange(range);
    // insertNode does not fire 'input' — record the draft directly.
    for(var i=0;i<editRows.length;i++){
      if(editRows[i].el===el){ editDrafts[i]=el.textContent; break; }
    }
  }
  function wrapMixedTextNodes(root){
    var walk=[root];
    while(walk.length){
      var el=walk.pop();
      if(!el||el.nodeType!==1)continue;
      if(MIXED_WRAP_SKIP.has(String(el.tagName||'').toUpperCase()))continue;
      var textNodes=[];
      for(var i=0;i<el.childNodes.length;i++){
        var n=el.childNodes[i];
        if(n.nodeType===3&&n.textContent.trim())textNodes.push(n);
      }
      // Mixed content (text + element children): wrap each text node so the
      // row becomes addressable (a row is an element whose children are ALL
      // text nodes).
      if(textNodes.length&&textNodes.length<el.childNodes.length){
        for(var j=0;j<textNodes.length;j++){
          var s=document.createElement('span');
          s.setAttribute('data-oa-text-wrap','1');
          var t=textNodes[j];
          t.parentNode.insertBefore(s,t);
          s.appendChild(t);
        }
      }
      for(var k=0;k<el.children.length;k++)walk.push(el.children[k]);
    }
  }
  function unwrapMixedTextNodes(root){
    var spans=root.querySelectorAll('[data-oa-text-wrap]');
    for(var i=0;i<spans.length;i++){
      var s=spans[i], p=s.parentNode;
      while(s.firstChild)p.insertBefore(s.firstChild,s);
      p.removeChild(s);
    }
  }
  function collectEditableTextRows(root){
    var rows=[];
    (function walk(el){
      if(!el||el.nodeType!==1)return;
      if(MIXED_WRAP_SKIP.has(String(el.tagName||'').toUpperCase()))return;
      var kids=el.childNodes, hasText=false, allText=kids.length>0;
      for(var i=0;i<kids.length;i++){
        if(kids[i].nodeType===3){ if(kids[i].textContent.trim())hasText=true; }
        else allText=false;
      }
      if(hasText&&allText){
        rows.push({el:el, text:el.textContent});
        return; // leaf row; do not descend
      }
      for(var j=0;j<el.children.length;j++)walk(el.children[j]);
    })(root);
    return rows;
  }
  function rowRef(el){
    return el.id||[].slice.call(el.classList).join('.')||String(el.tagName).toLowerCase();
  }
  function onEditInput(e){
    for(var i=0;i<editRows.length;i++){
      if(editRows[i].el===e.currentTarget){ editDrafts[i]=e.currentTarget.textContent; break; }
    }
  }
  function enableEditMode(root){
    if(editRoot||!root)return;
    editRoot=root;
    wrapMixedTextNodes(root);
    var rows=collectEditableTextRows(root);
    if(!rows.length){
      unwrapMixedTextNodes(root);
      editRoot=null;
      window.__oaSend({type:'oa:live:edit:none'});
      return;
    }
    editRows=rows;
    editDrafts={};
    ensureEditStyle();
    editRoot.addEventListener('paste',onEditPaste,true);
    rows.forEach(function(row,i){
      row.el.setAttribute('contenteditable','true');
      row.el.setAttribute('data-original-text',row.text);
      row.el.setAttribute('data-oa-row',String(i));
      row.el.setAttribute('data-oa-editable','');
      row.el.addEventListener('input',onEditInput);
    });
    // The annotation overlay sits over the picked element with pointer events
    // on — it would swallow the clicks that edit the text rows underneath.
    if(annotSvg)annotSvg.style.pointerEvents='none';
    // Focus the first row with the caret collapsed at the end; a focus throw
    // (rare engine quirk) must not leave edit mode half-armed.
    try{
      if(rows[0].el.focus)rows[0].el.focus();
      var sel=window.getSelection();
      if(sel){ sel.selectAllChildren(rows[0].el); sel.collapseToEnd(); }
    }catch(e){}
  }
  function disableEditMode(restore){
    if(!editRoot)return;
    editRows.forEach(function(row,i){
      if(restore&&editDrafts&&editDrafts[i]!==undefined){
        row.el.textContent=row.el.getAttribute('data-original-text')||'';
      }
      row.el.removeAttribute('contenteditable');
      row.el.removeAttribute('data-original-text');
      row.el.removeAttribute('data-oa-row');
      row.el.removeAttribute('data-oa-editable');
      row.el.removeEventListener('input',onEditInput);
    });
    editRoot.removeEventListener('paste',onEditPaste,true);
    if(editStyleEl){ editStyleEl.remove(); editStyleEl=null; }
    unwrapMixedTextNodes(editRoot);
    if(annotSvg)annotSvg.style.pointerEvents='auto';
    editRoot=null; editRows=null; editDrafts=null;
  }
  function onEditKey(e){
    if(!editRoot||e.key!=='Escape')return;
    // Restore every edited row, stay in edit mode.
    editRows.forEach(function(row,i){
      if(editDrafts[i]!==undefined)row.el.textContent=row.el.getAttribute('data-original-text')||'';
    });
    editDrafts={};
  }
  function saveEdit(){
    if(!editRoot)return;
    // Snapshot the element context BEFORE tearing the edit mode down.
    var element=extractContext(editRoot);
    var ops=[];
    for(var i=0;i<editRows.length;i++){
      if(editDrafts[i]===undefined)continue; // unchanged row
      var row=editRows[i], candidate=row.el.textContent;
      if(!candidate.trim()){ rejectEdit('empty text'); return; }
      if(/[<{}`]/.test(candidate)){ rejectEdit('plain text only — no < { } or backtick'); return; }
      var classes=[].slice.call(row.el.classList);
      var ref=rowRef(row.el);
      var originalText=row.el.getAttribute('data-original-text')||'';
      var op={ref:ref, tag:String(row.el.tagName).toLowerCase(), elementId:row.el.id||null, classes:classes, originalText:originalText, newText:candidate, leaf:{ref:ref, tag:String(row.el.tagName).toLowerCase(), id:row.el.id||null, classes:classes, originalText:originalText, newText:candidate, textContent:candidate, outerHTML:row.el.outerHTML.slice(0,5000)}, nearbyEditableTexts:editRows.map(function(r){return r.text;}).filter(function(t){return t!==originalText;})};
      ops.push(op);
    }
    disableEditMode(false);
    window.__oaSend({type:'oa:live:edit:data', element:element, ops:ops});
  }
  function rejectEdit(reason){
    window.__oaSend({type:'oa:live:edit:rejected', reason:reason});
  }
  document.addEventListener('keydown',onEditKey,true);

  // ONE message listener (the duplicate was merged — the second copy called
  // sendAnnots() without the request token, dropping the req on submits).
  window.addEventListener('message',function(e){
    if(e.source!==window.parent)return;
    var m=e.data; if(!m||typeof m!=='object')return;
    if(m.type==='oa:live:pick:arm')arm();
    else if(m.type==='oa:live:pick:lock')lock();
    else if(m.type==='oa:live:pick:disarm')disarm();
    else if(m.type==='oa:live:annot:enable'){annotEnabled=true;if(picked)showAnnot(picked);}
    else if(m.type==='oa:live:annot:collect')sendAnnots(m.req);
    else if(m.type==='oa:live:edit:arm')enableEditMode(picked);
    else if(m.type==='oa:live:edit:cancel')disableEditMode(true);
    else if(m.type==='oa:live:edit:save')saveEdit();
  });
})();
