import { CLOSE_SVG } from "../../handoff/svgs";

export const LIVE_SCRIPT = `
(function(){
  var cfgEl=document.getElementById('oa-live-config');
  if(!cfgEl) return;
  var cfg=JSON.parse(cfgEl.textContent||'{}');
  var root=document.getElementById('oa-live-root');
  var dock=document.getElementById('oa-live-dock');
  var statusEl=document.getElementById('oa-live-status');
  var chipsEl=document.getElementById('oa-live-chips');
  var submitEl=document.getElementById('oa-live-submit-wrap');
  var applyBtn=document.getElementById('oa-live-apply');
  var discardBtn=document.getElementById('oa-live-discard');
  var abar=document.getElementById('oa-live-action-bar');
  var exitBtn=document.getElementById('oa-live-exit');
  var frame=document.getElementById('oa-frame');
  var liveToggle=document.querySelector('.oa-live-toggle');
  var connection=document.querySelector('[data-live-connection]');
  var liveGuide=document.getElementById('oa-live-guide');
  var guideText=document.getElementById('oa-live-guide-text');
  var guideCopy=document.getElementById('oa-live-guide-copy');
  var guideToggle=document.getElementById('oa-live-guide-toggle');
  var guideDetails=document.getElementById('oa-live-guide-details');
  var publicationEl=document.getElementById('oa-live-publication');
  var publicationLabel=document.getElementById('oa-live-publication-label');
  var publicationDetail=document.getElementById('oa-live-publication-detail');
  var checkpointBtn=document.getElementById('oa-live-checkpoint');
  if(!root||!dock||!statusEl||!chipsEl||!submitEl||!abar||!exitBtn||!frame) return;

  var agentOnline=null;
  var publicationState={phase:'published',publishedVersion:Number(cfg.publishedVersion)||1};
  var draftPollBusy=false, draftPollTimer=null;
  function publicationView(s){
    if(s.phase==='published')return {label:'Published v'+s.publishedVersion,detail:'Published history is immutable',busy:false,checkpoint:false,tone:'published'};
    if(s.phase==='saving')return {label:'Saving Draft…',detail:'Published v'+s.publishedVersion+' is unchanged',busy:true,checkpoint:false,tone:'saving'};
    if(s.phase==='unsaved')return {label:'Unsaved Draft r'+s.revision,detail:'Based on published v'+s.baseVersion,busy:false,checkpoint:true,tone:'draft'};
    if(s.phase==='checkpointing')return {label:'Checkpointing Draft r'+s.revision+'…',detail:'Published v'+s.publishedVersion+' remains readable',busy:true,checkpoint:false,tone:'saving'};
    return {label:s.reason==='expired'?'Draft r'+s.revision+' expired':'Conflict — Draft r'+s.revision+' preserved',detail:s.reason==='revision'?'A newer Draft revision exists; published v'+s.publishedVersion+' is unchanged':'Draft base v'+s.baseVersion+'; published v'+s.publishedVersion,busy:false,checkpoint:false,tone:'conflict'};
  }
  function paintPublication(moveFocus){
    if(!publicationEl||!publicationLabel||!publicationDetail)return;
    var view=publicationView(publicationState);
    publicationEl.setAttribute('data-phase',publicationState.phase);
    publicationEl.setAttribute('data-tone',view.tone);
    if(view.busy)publicationEl.setAttribute('aria-busy','true');else publicationEl.removeAttribute('aria-busy');
    publicationLabel.textContent=view.label;
    publicationDetail.textContent=view.detail;
    if(checkpointBtn){checkpointBtn.hidden=!view.checkpoint;checkpointBtn.disabled=view.busy;}
    if(moveFocus)publicationEl.focus();
  }
  function ownerWriteToken(){try{return localStorage.getItem('oa-cm-wt-'+cfg.artifactId)}catch(e){return null}}
  function draftHeaders(json){
    var headers=json?{'content-type':'application/json','X-OA-CSRF':'1'}:{};
    var token=ownerWriteToken();if(token)headers.authorization='Bearer '+token;
    return headers;
  }
  function applyDraftState(d){
    if(!d||!Number.isInteger(d.revision)||!Number.isInteger(d.baseVersion))return;
    if(publicationState.phase==='checkpointing'&&d.state==='active')return;
    if(d.state==='checkpointed'){
      publicationState={phase:'published',publishedVersion:Number(d.checkpointVersion)||publicationState.publishedVersion};
    }else if(d.state==='conflict'||d.state==='expired'||d.baseVersion!==publicationState.publishedVersion){
      publicationState={phase:'conflict',publishedVersion:publicationState.publishedVersion,revision:d.revision,baseVersion:d.baseVersion,reason:d.state==='expired'?'expired':'stale-base'};
    }else{
      publicationState={phase:'unsaved',publishedVersion:publicationState.publishedVersion,revision:d.revision,baseVersion:d.baseVersion};
    }
    paintPublication(false);
  }
  function pollDraft(){
    if(draftPollBusy)return;
    draftPollBusy=true;
    fetch('/api/artifacts/'+encodeURIComponent(cfg.artifactId)+'/live/draft',{credentials:'same-origin',headers:draftHeaders(false)})
      .then(function(r){if(r.status===404)return null;if(!r.ok)throw 0;return r.json()})
      .then(function(body){if(body&&body.draft)applyDraftState(body.draft);else if(publicationState.phase==='saving'){publicationState={phase:'published',publishedVersion:publicationState.publishedVersion};paintPublication(false)}})
      .catch(function(){})
      .finally(function(){draftPollBusy=false});
  }
  function checkpointDraft(){
    if(publicationState.phase!=='unsaved')return;
    var pending=publicationState;
    publicationState={phase:'checkpointing',publishedVersion:pending.publishedVersion,revision:pending.revision,baseVersion:pending.baseVersion};
    paintPublication(false);
    var key='viewer-live-checkpoint:'+cfg.artifactId+':r'+pending.revision+':b'+pending.baseVersion;
    var headers=draftHeaders(true);headers['idempotency-key']=key;
    fetch('/api/artifacts/'+encodeURIComponent(cfg.artifactId)+'/live/checkpoint',{method:'POST',credentials:'same-origin',headers:headers,body:JSON.stringify({protocolVersion:1,expectedRevision:pending.revision})})
      .then(function(r){return r.json().catch(function(){return {}}).then(function(body){return {ok:r.ok,status:r.status,body:body}})})
      .then(function(result){
        if(result.ok&&Number.isInteger(result.body.version)){
          publicationState={phase:'published',publishedVersion:result.body.version};
          window.__oaViewedVersion=result.body.version;
          versionSeenAt=0;
          paintPublication(true);
          reloadFrame();
          if(!root.hidden)pendingRearm=true;
          if(window.__oaShowSuccess)window.__oaShowSuccess('Published immutable version '+result.body.version);
          return;
        }
        if(result.status===409){
          publicationState={phase:'conflict',publishedVersion:Number(result.body.currentVersion)||pending.publishedVersion,revision:pending.revision,baseVersion:pending.baseVersion,reason:result.body.code==='REVISION_CONFLICT'?'revision':'stale-base'};
          paintPublication(true);
          if(window.__oaShowError)window.__oaShowError('Checkpoint conflict — your Draft was preserved');
          return;
        }
        publicationState=pending;paintPublication(true);
        if(window.__oaShowError)window.__oaShowError(result.body.error||'Checkpoint failed; your Draft was preserved');
      })
      .catch(function(){publicationState=pending;paintPublication(true);if(window.__oaShowError)window.__oaShowError('Checkpoint failed; your Draft was preserved')})
      .finally(pollDraft);
  }
  if(checkpointBtn)checkpointBtn.addEventListener('click',checkpointDraft);
  paintPublication(false);
  function startDraftPoll(){if(draftPollTimer)clearInterval(draftPollTimer);pollDraft();draftPollTimer=setInterval(pollDraft,10000)}
  function stopDraftPoll(){if(draftPollTimer){clearInterval(draftPollTimer);draftPollTimer=null}}
  startDraftPoll();
  // The guide banner auto-shows once per session; later offline opens keep
  // the slim status row instead of re-occluding the pick surface.
  var guideAutoShown=false;
  if(guideText){
    var guideOrigin=window.location.origin||'';
    guideText.value=[
      'Start the Live watcher for this artifact:',
      'Artifact URL: '+guideOrigin+'/a/'+encodeURIComponent(cfg.artifactId),
      'Run this from the project root:',
      'node artifact.mjs live '+cfg.artifactId+' --watch',
      'Keep the watcher running while I make Live edits.'
    ].join(String.fromCharCode(10));
  }
  function hideGuide(){
    if(liveGuide)liveGuide.hidden=true;
    // Collapse the disclosure so the next banner opens slim.
    if(guideDetails&&!guideDetails.hidden){
      guideDetails.hidden=true;
      if(guideToggle)guideToggle.setAttribute('aria-expanded','false');
    }
  }
  function showGuide(){
    if(!liveGuide)return;
    liveGuide.hidden=false;
    // The banner itself never steals focus — the artifact stays the focus of
    // the session; expanding the prompt moves focus to the copy button.
  }
  function toggleGuideDetails(){
    if(!guideDetails)return;
    var open=guideDetails.hidden;
    guideDetails.hidden=!open;
    if(guideToggle)guideToggle.setAttribute('aria-expanded', open?'true':'false');
    if(open&&guideCopy)guideCopy.focus();
  }
  function markGuideCopied(ok){
    if(!guideCopy)return;
    var original=ok?'Copy start prompt':'Copy failed';
    guideCopy.textContent=ok?'Copied':original;
    setTimeout(function(){guideCopy.textContent='Copy start prompt';},1600);
  }
  function fallbackGuideCopy(){
    if(!guideText){markGuideCopied(false);return;}
    guideText.focus();
    guideText.select();
    var copied=false;
    try{copied=document.execCommand('copy');}catch(e){copied=false;}
    markGuideCopied(copied);
  }
  function copyGuide(){
    if(!guideText)return;
    if(navigator.clipboard&&navigator.clipboard.writeText){
      try{
        navigator.clipboard.writeText(guideText.value).then(function(){markGuideCopied(true);}).catch(function(){fallbackGuideCopy();});
      }catch(e){fallbackGuideCopy();}
      return;
    }
    fallbackGuideCopy();
  }
  if(guideToggle)guideToggle.addEventListener('click',toggleGuideDetails);
  if(guideCopy)guideCopy.addEventListener('click',copyGuide);
  document.addEventListener('click',function(e){
    var target=e.target;
    if(liveGuide&&!liveGuide.hidden&&target!==liveToggle&&!liveGuide.contains(target))hideGuide();
  });
  document.addEventListener('keydown',function(e){
    if(e.key==='Escape'&&liveGuide&&!liveGuide.hidden)hideGuide();
  });

  function openLive(){
    // Reconnect if the ws died (a prior Exit, or Handoff tore Live down).
    // onclose only auto-reconnects while non-IDLE, so an IDLE-time close
    // leaves it dead - reopen has to re-establish it explicitly.
    if(!ws || ws.readyState>=2) connect();
    root.removeAttribute('hidden');
    if(liveToggle) liveToggle.setAttribute('aria-expanded','true');
    // Clicking Live = enter pick mode immediately. The dock's Pick control is
    // a display-only indicator, so arming happens here on open. The picker
    // locks while a picked element's prompt is open and is re-armed after the
    // prompt is committed. Arm unconditionally (not gated on state==='IDLE')
    // so a stale non-IDLE state left by an in-flight ws message after Exit
    // can't strand the user with pick disarmed and no way to re-arm.
    setState('PICKING');
    toFrame({type:'oa:live:pick:arm'});
    // Annotate on top of the picked element: comment pins + strokes ride the
    // next generate event so the agent sees the user's marks with the change.
    toFrame({type:'oa:live:annot:enable'});
    // Restore the Apply pill: staged edits from before a reload must survive.
    refreshStash();
    pollDraft();
  }
  function closeLive(){
    // Live has no irreplaceable in-flight work, so it always yields.
    if(root.hidden) return true;
    // Give the exit its OWN id: send() otherwise stamps the last generate's
    // sessionId, and the watcher's grow-only exclude set would then hide the
    // exit row forever (the watcher would never learn the session ended).
    send({type:'exit', id:genId()}); reset(); ws&&ws.close(); root.hidden=true;
    if(liveToggle) liveToggle.setAttribute('aria-expanded','false');
    return true;
  }
  if(window.__oaDock){
    window.__oaDock.register('live', {
      open: openLive,
      close: closeLive,
      restoreFocus: function(){ if(window.__oaRestoreHeaderControlFocus)window.__oaRestoreHeaderControlFocus(liveToggle);else if(liveToggle)liveToggle.focus(); }
    });
  }
  if(liveToggle){
    liveToggle.addEventListener('click', function(){
      if(root.hidden&&agentOnline===false&&!guideAutoShown){ guideAutoShown=true; showGuide(); }else hideGuide();
      // Toggle (open/close) through the dock manager, like the comments toggle
      // (.oa-cm-toggle) opens/closes its drawer. The manager enforces mutual
      // exclusion with Handoff and toasts when Handoff refuses to yield
      // (mid-recording/playback). Fallback toggles directly if the manager is
      // absent.
      if(window.__oaDock) window.__oaDock.toggle('live'); else if(root.hidden) openLive(); else closeLive();
    });
  }

  // Agent presence: the CLI watcher heartbeats while connected, and the Live
  // toggle shows Connected when an agent is online — so the user knows a watcher
  // will pick up their changes before they start, instead of only learning
  // it from the STALLED hint 2 minutes after submit. Same-origin fetch works
  // on the host page (connect-src 'self'); the frame can never do this.
  // Three states (impeccable semantics): on = accent pill, no dot; busy (a
  // pending event is leased to the agent) = accent dot pulses, tooltip says
  // the agent is working; off = amber dot pulses with the watcher tooltip.
  var agentTimer=null;
  function paintAgent(on, busy){
    // The PICKING status text mentions presence — refresh it only when the
    // flag actually flips (a full renderBar would rebuild the compose row and
    // drop a prompt the user is typing).
    var changed=on!==agentOnline;
    agentOnline=on;
    if(!liveToggle)return;
    liveToggle.setAttribute('data-agent', on?(busy?'busy':'on'):'off');
    if(connection)connection.hidden=!on;
    liveToggle.setAttribute('aria-label', on?'Open live editor — agent connected':'Open live editor — live agent not connected');
    liveToggle.title=on?(busy?'Agent is working on an edit':'Live — agent connected'):'Live agent not connected - run the watcher to connect';
    if(on)hideGuide();
    if(changed)renderStatus();
  }
  function pollAgent(){
    fetch('/api/artifacts/'+encodeURIComponent(cfg.artifactId)+'/live/status',{credentials:'same-origin'})
      .then(function(r){ if(!r.ok) throw 0; return r.json(); })
      .then(function(s){
        // busy = a pending event is leased to the agent (leased_until in the
        // future): the toggle shows the agent is working, not just online.
        var busy=Array.isArray(s.pendingEvents)&&s.pendingEvents.some(function(e){return e.leased_until>Date.now();});
        paintAgent(s.agentActive===true, busy);
        // An unleased queued edit event (from a reload or a prior session)
        // restores the "Queued — click to cancel" pill.
        if(Array.isArray(s.pendingEvents)&&!queuedEditId){
          for(var i=0;i<s.pendingEvents.length;i++){
            var pe=s.pendingEvents[i];
            if(pe.type==='edit'&&pe.leased_until<=Date.now()){ queuedEditId=pe.id; paintQueued(); break; }
          }
        }
      })
      .catch(function(){ /* keep the last state; a blip must not flick the indicator */ });
  }
  function startAgentPoll(){ stopAgentPoll(); pollAgent(); agentTimer=setInterval(pollAgent,15000); }
  function stopAgentPoll(){ if(agentTimer){ clearInterval(agentTimer); agentTimer=null; } }
  document.addEventListener('visibilitychange',function(){
    if(document.hidden){stopAgentPoll();stopDraftPoll();}else{startAgentPoll();startDraftPoll();}
  });
  if(liveToggle) startAgentPoll();

  var ws=null, wsReady=false, sessionId=null, state='IDLE', pendingRearm=false;
  // Multi-element batch: the user picks N elements, types a prompt for each
  // (Enter commits that pair), then hits Submit to send one generate event
  // with the full list. draft is the element currently awaiting a prompt.
  var items=[]; // [{element, prompt, rect}]
  var draft=null; // {element, rect} — picked, prompt not yet committed
  // (no preset action — each item carries its own freeform prompt)
  var ackTimer=null;
  // How long to wait for an agent ack before showing the stall hint.
  var ACK_TIMEOUT=120000; // 2 min — generous for an agent spinning up
  // One reload per publish, two signals: the version broadcast and the
  // agent's done reply (which lands ~1-3s later, after the republish).
  // 'done' owns the reload — exactly one per interactive edit, like before
  // this feature; the version branch is the fallback for publishes with no
  // live reply (another session, or no live session at all): it defers
  // past the window in which a done would land and reloads only if none
  // did (versionSeenAt reset by the done handler).
  var versionSeenAt=0, VERSION_DONE_WINDOW_MS=5000;

  function toFrame(msg){ try{ if(frame.contentWindow) frame.contentWindow.postMessage(msg,'*'); }catch(e){} }
  function send(msg){ if(!ws||ws.readyState!==1) return; msg.id=msg.id||sessionId; try{ ws.send(JSON.stringify(msg)); }catch(e){} }
  function genId(){ return 'ev_'+Math.random().toString(36).slice(2)+Date.now().toString(36); }
  // Bridge for the comments chrome: a comment posted while the live channel
  // is up is streamed to the agent's watcher immediately (a comment event
  // the watch loop polls), so "I left a comment" reaches the agent without
  // waiting for a pick+submit. The comments script runs before this one, so
  // it calls the hook lazily at post time.
  window.__oaLivePush=function(msg){
    if(!msg||!msg.type)return;
    if(!msg.id)msg.id=genId();
    send(msg);
  };

  // --- inline copy edits (impeccable-style) ---
  // The frame's contenteditable rows are staged server-side (POST
  // /live/edit-stash) instead of delivered immediately; Apply bundles every
  // staged op for this page into ONE 'edit' event (POST /live/edit-commit) —
  // fixing five typos means one agent round trip, not five. lastSubmitType
  // distinguishes an edit-done from a generate-done in the WS handler; the
  // protocol payload decides first (Array.isArray appliedEntryIds) and this
  // flag only backs up older agents that reply without it.
  var lastSubmitType=null;
  var stashCount=0;
  // In-register inline confirm (the native confirm dialog is off-register):
  // the first Apply/Discard/Exit click arms the control ("Confirm apply?" /
  // danger tint), a second click within the window commits, otherwise it
  // reverts.
  var applyArmed=null, discardArmed=null, cancelArmed=null;
  // A committed edit event waits in the DO queue until a watcher applies it.
  // The pill then becomes the cancel affordance ("Queued — click to cancel",
  // DELETE /live/events/:eid) so "it will queue" is a promise the UI can keep.
  var queuedEditId=null;
  function paintQueued(){
    if(!applyBtn)return;
    if(queuedEditId){
      applyBtn.querySelector('.oa-dock-label').textContent='Queued ('+stashCount+') — click to cancel';
      applyBtn.setAttribute('aria-label','Cancel the queued edit');
    }else{
      applyBtn.querySelector('.oa-dock-label').textContent='Apply copy edits ('+stashCount+')';
      applyBtn.removeAttribute('aria-label');
    }
  }
  function resetApplyArm(){
    if(applyArmed){ clearTimeout(applyArmed); applyArmed=null; }
    if(cancelArmed){ clearTimeout(cancelArmed); cancelArmed=null; }
    if(discardArmed){ clearTimeout(discardArmed); discardArmed=null; }
    if(discardBtn)discardBtn.classList.remove('oa-dock-btn--danger');
    paintQueued();
  }
  function refreshStash(){
    if(!applyBtn)return;
    fetch('/api/artifacts/'+encodeURIComponent(cfg.artifactId)+'/live/edit-stash?pageUrl='+encodeURIComponent(window.location.pathname),{credentials:'same-origin'})
      .then(function(r){ if(!r.ok) throw 0; return r.json(); })
      .then(function(s){
        stashCount=Number(s&&s.pendingCount)||0;
        applyBtn.hidden=stashCount===0&&!queuedEditId;
        if(discardBtn)discardBtn.hidden=stashCount===0;
        resetApplyArm();
      })
      .catch(function(){ /* transient; the pill keeps its last state */ });
  }
  function commitEdits(){
    if(!stashCount)return;
    if(!applyArmed){
      applyBtn.querySelector('.oa-dock-label').textContent='Confirm apply?';
      applyArmed=setTimeout(function(){ applyArmed=null; paintQueued(); },4000);
      return;
    }
    clearTimeout(applyArmed); applyArmed=null;
    lastSubmitType='edit';
    setState('APPLYING');
    // A dead watcher still queues the edit server-side (the DO persists
    // pending events) — say so up front, and time out fast instead of a 2-min
    // silent spin before the stall hint.
    if(agentOnline===false){
      statusEl.innerHTML='No agent connected — the edit will queue until a watcher connects';
      statusEl.hidden=false;
    }
    fetch('/api/artifacts/'+encodeURIComponent(cfg.artifactId)+'/live/edit-commit',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({pageUrl:window.location.pathname})})
      .then(function(r){ if(!r.ok) throw {status:r.status}; return r.json(); })
      .then(function(s){
        // Committed: the event sits in the queue until a watcher applies it.
        queuedEditId=String(s&&s.eventId||'');
        paintQueued();
      })
      .catch(function(err){
        // 409 = the stash changed under us (empty/consumed); anything else is
        // a network blip — the stash is still there either way. Surface the
        // difference instead of the old "still here" line, which lied once
        // the event was queued.
        if(window.__oaShowError)window.__oaShowError(err&&err.status===409?'Apply failed — the stash changed; refresh and try again':'Apply failed — the staged edits are still here, try again');
        setState('PICKING');
      });
    clearTimeout(ackTimer);
    ackTimer=setTimeout(function(){ if(state==='APPLYING') setState('STALLED'); }, agentOnline===false?20000:ACK_TIMEOUT);
  }
  function cancelQueued(){
    if(!queuedEditId)return;
    if(!cancelArmed){
      applyBtn.querySelector('.oa-dock-label').textContent='Cancel queued edit?';
      cancelArmed=setTimeout(function(){ cancelArmed=null; paintQueued(); },4000);
      return;
    }
    clearTimeout(cancelArmed); cancelArmed=null;
    fetch('/api/artifacts/'+encodeURIComponent(cfg.artifactId)+'/live/events/'+encodeURIComponent(queuedEditId),{method:'DELETE',credentials:'same-origin'})
      .then(function(r){ if(!r.ok) throw {status:r.status}; return r.json(); })
      .then(function(){
        queuedEditId=null;
        paintQueued();
        refreshStash();
        // Back to picking — the stall/queue warning no longer applies.
        setState('PICKING');
        if(window.__oaShowSuccess)window.__oaShowSuccess('Queued edit cancelled — the stash is still here');
      })
      .catch(function(err){
        // 409 = the watcher already leased it; the row is gone either way.
        if(err&&err.status===409){
          if(window.__oaShowError)window.__oaShowError('The agent already picked up the edit — it is being applied');
        }else{
          if(window.__oaShowError)window.__oaShowError('Cancel failed — try again');
        }
        queuedEditId=null;
        paintQueued();
        setState('PICKING');
      });
  }
  function discardEdits(){
    if(!stashCount)return;
    if(!discardArmed){
      discardBtn.classList.add('oa-dock-btn--danger');
      discardBtn.setAttribute('aria-label','Confirm discard staged edits');
      discardArmed=setTimeout(function(){ discardArmed=null; discardBtn.classList.remove('oa-dock-btn--danger'); discardBtn.setAttribute('aria-label','Discard staged edits'); },4000);
      return;
    }
    clearTimeout(discardArmed); discardArmed=null;
    discardBtn.classList.remove('oa-dock-btn--danger');
    discardBtn.setAttribute('aria-label','Discard staged edits');
    fetch('/api/artifacts/'+encodeURIComponent(cfg.artifactId)+'/live/edit-stash?pageUrl='+encodeURIComponent(window.location.pathname),{method:'DELETE',credentials:'same-origin'})
      .then(function(r){ if(!r.ok) throw 0; refreshStash(); })
      .catch(function(){});
  }
  if(applyBtn)applyBtn.onclick=function(){ if(queuedEditId) cancelQueued(); else commitEdits(); };
  if(discardBtn)discardBtn.onclick=discardEdits;

  function setState(s){ state=s; renderBar(); }

  // Float the action bar near the drafted element. draft.rect is the element's
  // rect inside the frame (CSS px); add the iframe's offset on the host page
  // to get page coordinates. Only called in COMPOSE state (which always has a
  // draft); if no rect, hide the bar — the status row in the dock carries the
  // hint, so nothing overlaps.
  function positionBar(){
    var rc=draft&&draft.rect;
    if(!rc){ abar.hidden=true; abar.style.left=''; abar.style.top=''; abar.style.bottom=''; abar.style.transform=''; return; }
    var fr=frame.getBoundingClientRect();
    var x=fr.left+rc.x+ (rc.width/2);
    var y=fr.top+rc.y+rc.height+8;
    abar.style.left=x+'px';
    abar.style.top=y+'px';
    abar.style.bottom='auto';
    abar.style.transform='translateX(-50%)';
    var vw=document.documentElement.clientWidth, vh=document.documentElement.clientHeight;
    if(y>vh-80){ abar.style.top='auto'; abar.style.bottom=(vh-(fr.top+rc.y)+8)+'px'; }
    if(x<150){ abar.style.left='150px'; }
    if(x>vw-150){ abar.style.left=(vw-150)+'px'; }
  }

  // --- bar rendering (Pick / Compose / Edit / Generating / Applying / Confirmed) ---
  // Live state machine (see the state var below):
  //   COMPOSE --Edit chip--> EDITING        (frame arms contenteditable rows)
  //   EDITING --cancel--> COMPOSE           (frame restores the original texts)
  //   EDITING --save ok--> PICKING          (ops stashed; pick re-armed)
  //   COMPOSE --Apply--> APPLYING           (one edit event committed)
  //   APPLYING --ack--> WORKING
  //   APPLYING --done--> CONFIRMED          (stash cleared, frame reloads)
  //   APPLYING --error--> PICKING           (stash kept for retry or discard)
  //   APPLYING --timeout--> STALLED
  //   Closing the dock mid-EDITING/APPLYING runs reset(), which clears
  //   lastSubmitType and cancels frame edit mode; reopening arms cleanly.
  function el(tag, cls, html){ var d=document.createElement(tag); if(cls)d.className=cls; if(html!=null)d.innerHTML=html; return d; }
  function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  // Status row lives INSIDE the dock — it can never overlap the controls.
  // Presence surfaces here too (PICKING names a missing agent), so the
  // disconnected state is visible without hovering the toggle — its tooltip
  // is the hover-only channel, the aria-label covers assistive tech.
  function renderStatus(){
    var status='';
    if(state==='PICKING') status= items.length? 'Pick another element, or Submit below' : (agentOnline===false?'Pick an element in the page — live agent not connected':'Pick an element in the page');
    else if(state==='COMPOSE') status='';
    else if(state==='EDITING') status='Editing text — edit the text lines, then Save or Cancel';
    else if(state==='GENERATING') status='<span class="oa-live-spin"></span> Sent — waiting for agent…';
    else if(state==='APPLYING') status='<span class="oa-live-spin"></span> Applying copy edits…';
    else if(state==='WORKING') status='<span class="oa-live-spin"></span> Agent is editing…';
    // A stalled edit-commit still has its event queued server-side — the hint
    // must acknowledge the queue instead of implying the work is lost.
    else if(state==='STALLED') status= lastSubmitType==='edit' ? '<span class="oa-live-stall">No agent picked up — the edit is queued and will apply when a watcher connects</span>' : '<span class="oa-live-stall">No agent picked up — is your CLI watcher running?</span>';
    else if(state==='CONFIRMED') status='✓ Applied';
    statusEl.innerHTML=status||'';
    statusEl.hidden=!status;
  }
  function renderBar(){
    renderStatus();
    // Floating action bar: ONLY for COMPOSE (prompt input + Add) and EDITING
    // (Save/Cancel), pinned to the picked element. All other states are text
    // in the dock status row.
    abar.innerHTML='';
    if(state==='COMPOSE'){
      abar.hidden=false;
      abar.appendChild(buildComposeRow());
      positionBar();
    }else if(state==='EDITING'){
      abar.hidden=false;
      abar.appendChild(buildEditRow());
      positionBar();
    }else{
      abar.hidden=true;
      abar.style.left=''; abar.style.top=''; abar.style.bottom=''; abar.style.transform='';
    }
    renderChips();
  }
  function renderChips(){
    chipsEl.innerHTML='';
    submitEl.innerHTML='';
    if(!items.length) return;
    items.forEach(function(it, i){
      var chip=el('div','oa-live-chip'); chip.setAttribute('role','listitem');
      chip.appendChild(el('span','oa-live-chip-tag', esc(it.element.tagName)+(it.element.id?'#'+esc(it.element.id):'')));
      chip.appendChild(el('span','oa-live-chip-txt', esc(it.prompt)));
      var rm=el('button','oa-live-chip-rm','×'); rm.type='button';
      rm.setAttribute('aria-label','Remove '+esc(it.element.tagName)+(it.element.id?'#'+esc(it.element.id):''));
      rm.onclick=function(){ items.splice(i,1); if(!items.length&&!draft){ setState('PICKING'); } else renderBar(); };
      chip.appendChild(rm);
      chipsEl.appendChild(chip);
    });
    var sub=el('button','oa-dock-btn oa-dock-btn--primary'); sub.type='button'; sub.onclick=handleSubmit;
    sub.appendChild(el('span','oa-dock-label','Submit ('+items.length+')'));
    submitEl.appendChild(sub);
  }
  function buildComposeRow(){
    var r=el('div','oa-live-row');
    // Two input modes for a picked element: describe the change as a prompt
    // (default), or edit the element's text directly (impeccable-style).
    var edit=el('button','oa-dock-btn oa-live-edit-chip','Edit text'); edit.type='button'; edit.title='Edit the element text directly';
    edit.onclick=function(){ toFrame({type:'oa:live:edit:arm'}); setState('EDITING'); };
    var ff=el('input','oa-live-freeform'); ff.type='text'; ff.placeholder='describe the change; Enter to commit'; ff.setAttribute('aria-label','prompt for picked element');
    ff.onkeydown=function(e){ if(e.key==='Enter'){ e.preventDefault(); commitDraft(ff.value); } };
    // Add stays disabled until the prompt has text — an empty instruction must
    // never ship to the agent (commitDraft guards it too).
    var done=el('button','oa-live-add','Add'); done.type='button'; done.disabled=true;
    done.onclick=function(){ commitDraft(ff.value); };
    ff.addEventListener('input',function(){ done.disabled=!ff.value.trim(); });
    // Un-pick: cancel the draft and re-arm the picker (disarm clears the
    // frame's picked element, highlight, and annotation overlay).
    var unpick=el('button','oa-dock-btn oa-live-unpick','${CLOSE_SVG}'); unpick.type='button';
    unpick.setAttribute('aria-label','Cancel this pick'); unpick.title='Cancel this pick';
    unpick.onclick=function(){ toFrame({type:'oa:live:pick:disarm'}); draft=null; setState('PICKING'); toFrame({type:'oa:live:pick:arm'}); };
    r.appendChild(edit); r.appendChild(ff); r.appendChild(done); r.appendChild(unpick);
    // Once the batch has items, the bar carries the batch action too — the
    // user does not have to look away from the element to submit everything
    // (the dock Submit stays for the no-draft states).
    if(items.length){
      var sendAll=el('button','oa-dock-btn oa-dock-btn--primary oa-live-send-all','Send all ('+items.length+')'); sendAll.type='button';
      sendAll.onclick=handleSubmit;
      r.appendChild(sendAll);
    }
    // focus the input after the bar lands
    setTimeout(function(){ var f=abar.querySelector('.oa-live-freeform'); if(f) f.focus(); },0);
    return r;
  }
  // EDITING action bar: Save asks the frame to validate + postMessage the
  // ops; Cancel restores the original texts and returns to the prompt row.
  function buildEditRow(){
    var r=el('div','oa-live-row');
    var save=el('button','oa-dock-btn oa-dock-btn--primary','Save'); save.type='button'; save.title='Save the edited text';
    save.onclick=function(){ toFrame({type:'oa:live:edit:save'}); };
    var cancel=el('button','oa-dock-btn','Cancel'); cancel.type='button'; cancel.title='Discard edits and go back';
    cancel.onclick=function(){ toFrame({type:'oa:live:edit:cancel'}); setState('COMPOSE'); };
    r.appendChild(save); r.appendChild(cancel);
    return r;
  }
  function commitDraft(prompt){
    if(!draft) return;
    var text=String(prompt||'').trim();
    if(!text){
      // An empty instruction must not ship to the agent — keep the draft open
      // and tell the user what's missing (the Add button is disabled anyway;
      // this guards Enter).
      if(window.__oaShowError)window.__oaShowError('Type a change first');
      return;
    }
    items.push({element:draft.element, prompt:text, rect:draft.rect});
    draft=null;
    // Back to picking the next element; the prompt lock is over.
    setState('PICKING');
    toFrame({type:'oa:live:pick:arm'});
  }
  // Ask the frame for the annotations (comment pins + strokes + a screenshot
  // with them baked in) drawn over the picked element. The frame replies
  // oa:live:annot:data echoing the request token; if it never does (no overlay
  // ever shown, capture unsupported, taint), fall back after 1.5s so a stalled
  // frame can't block the submit. The token stops a slow capture from a
  // previous submit satisfying a newer one's listener.
  function collectAnnots(cb){
    var done=false, req=genId();
    function onMsg(e){
      if(done) return;
      if(e.source!==frame.contentWindow) return;
      var d=e.data; if(!d||d.type!=='oa:live:annot:data'||d.req!==req) return;
      done=true; window.removeEventListener('message',onMsg);
      cb(d);
    }
    window.addEventListener('message',onMsg);
    toFrame({type:'oa:live:annot:collect', req:req});
    setTimeout(function(){ if(!done){ done=true; window.removeEventListener('message',onMsg); cb(null); } },1500);
  }
  function handleSubmit(){
    // If a draft prompt is typed but not committed, commit it first.
    var ff=abar.querySelector('.oa-live-freeform');
    if(draft && ff && ff.value.trim()){ commitDraft(ff.value); }
    if(!items.length){ return; }
    // One batch per submit: a second click while an edit is in flight would
    // re-send the same items as a duplicate generate event.
    if(state==='GENERATING'||state==='WORKING'){ return; }
    sessionId=genId();
    // A generate-done must not inherit a stale edit-done classification: the
    // lastSubmitType fallback only applies to the event this submit produces.
    lastSubmitType=null;
    setState('GENERATING');
    // The user's comment pins/strokes ride the generate event (live.md):
    // the agent sees them with the change. Omit all three when empty.
    collectAnnots(function(annot){
      var payload={type:'generate', id:sessionId, items:items};
      if(annot){
        var hasAnnot=(annot.comments&&annot.comments.length)||(annot.strokes&&annot.strokes.length)||annot.screenshot;
        if(hasAnnot){
          payload.comments=annot.comments||[];
          payload.strokes=annot.strokes||[];
          if(annot.screenshot) payload.screenshot=annot.screenshot;
        }
      }
      send(payload);
      // If no agent picks up within ACK_TIMEOUT, show a hint instead of
      // spinning forever — the user likely forgot to start the CLI watcher.
      clearTimeout(ackTimer);
      ackTimer=setTimeout(function(){ if(state==='GENERATING') setState('STALLED'); }, ACK_TIMEOUT);
    });
  }

  // --- WebSocket ---
  function connect(){
    // Idempotent against concurrent callers: the toggle's reopen reconnect can
    // race a pending onclose auto-reconnect (1s timer) when the ws dies while
    // non-IDLE. Bail if a socket is already open or connecting so we don't
    // orphan it - connect() reassigns ws without closing the prior one.
    if(ws && ws.readyState<=1) return;
    try{ ws=new WebSocket(cfg.wsUrl); }catch(e){ setTimeout(connect,1000); return; }
    ws.onopen=function(){ wsReady=true; };
    ws.onmessage=function(e){
      var msg; try{ msg=JSON.parse(e.data); }catch(err){ return; }
      // 'ack' = agent picked up the event, is editing. Clear the stall timer.
      if(msg.type==='ack'){
        clearTimeout(ackTimer); setState('WORKING');
        publicationState={phase:'saving',publishedVersion:publicationState.publishedVersion};paintPublication(false);
      }
      // 'done' = the agent finished editing and may have Checkpointed. Refresh
      // Draft metadata instead of assuming that a published version changed.
      else if(msg.type==='done'){
        clearTimeout(ackTimer);
        // This done owns the reload (below) — cancel the version branch's
        // fallback timer if one is pending for the same publish.
        versionSeenAt=0;
        // An edit-done is decided by the protocol payload — the canonical
        // reply JSON always carries appliedEntryIds (possibly an empty array
        // when status:'error' also rides a done broadcast), so Array.isArray
        // is the truth — with lastSubmitType as a fallback for older agents.
        var isEditDone=Array.isArray(msg.appliedEntryIds)||lastSubmitType==='edit';
        setState('CONFIRMED');
        if(isEditDone){
          var applied=Array.isArray(msg.appliedEntryIds)?msg.appliedEntryIds.length:0;
          var failed=Array.isArray(msg.failed)?msg.failed.length:0;
          var summary='✓ Applied '+applied+' edit'+(applied===1?'':'s');
          if(failed)summary+=' — '+failed+' failed, re-edit them';
          statusEl.innerHTML=summary;
          statusEl.hidden=false;
          queuedEditId=null;
          refreshStash();
        }
        pollDraft();
        setTimeout(restartAfterEdit,1200);
      }
      else if(msg.type==='error'){ clearTimeout(ackTimer); setState(draft?'COMPOSE':'PICKING'); }
      // 'version' = a new immutable version was published (ordinary update,
      // Checkpoint, or Rollback). In the interactive flow the agent publishes and
      // then replies done ~1-3s later — done owns that reload (exactly one
      // per edit, as before this feature), so here it only arms a fallback:
      // if no done lands within the window the publish had no live reply
      // (another session, or no live session), and the staying viewer
      // refreshes in place (the frame src has no version param and is
      // no-cache, so a reload picks up the new version). Guarded: a pinned
      // ?v= view never jumps; mid-work (compose prompt open or inline text
      // editing) the user is told instead of losing unsaved work.
      else if(msg.type==='version'){
        if(/[?&]v=/.test(window.location.search)) return;
        if(Number.isInteger(msg.version)){
          publicationState={phase:'published',publishedVersion:msg.version};
          window.__oaViewedVersion=msg.version;
          paintPublication(false);
          setTimeout(pollDraft,0);
        }
        if(draft||state==='EDITING'||state==='COMPOSE'){ if(window.__oaShowInfo)window.__oaShowInfo('New version published — Save or cancel your edit to see it'); return; }
        // A second publish inside the window is covered by the pending
        // fallback timer — don't stack timers.
        if(versionSeenAt&&Date.now()-versionSeenAt<VERSION_DONE_WINDOW_MS) return;
        versionSeenAt=Date.now();
        setTimeout(function(){
          if(!versionSeenAt) return; // a done landed and owned the reload
          versionSeenAt=0;
          reloadFrame();
          if(!root.hidden) pendingRearm=true;
        },VERSION_DONE_WINDOW_MS+1200);
      }
    };
    ws.onclose=function(){ wsReady=false; setTimeout(function(){ if(state!=='IDLE') connect(); },1000); };
  }

  function reloadFrame(){ try{ if(frame.contentWindow) frame.contentWindow.location.reload(); }catch(e){ /* cross-origin: fall back to src resubmit */ frame.src=frame.src; } }

  // --- host<->frame bridge ---
  window.addEventListener('message', function(e){
    if(!e.data||typeof e.data.type!=='string') return;
    if(e.source!==frame.contentWindow) return;
    var d=e.data;
    if(d.type==='oa:element:picked'){ draft={element:d.element, rect:(d.element&&d.element.rect)||d.rect||null}; toFrame({type:'oa:live:pick:lock'}); setState('COMPOSE'); }
    // The frame reports oa:ready on every load. After an edit we reloaded it to
    // show the new version; arm pick now that its listener is back (a fresh
    // frame defaults to disarmed, and arming synchronously would race the
    // reload and be lost).
    else if(d.type==='oa:ready'){
      if(pendingRearm){ pendingRearm=false; if(!root.hidden){ toFrame({type:'oa:live:pick:arm'}); toFrame({type:'oa:live:annot:enable'}); } }
      else if(!root.hidden&&state==='PICKING'&&!draft){ toFrame({type:'oa:live:pick:arm'}); toFrame({type:'oa:live:annot:enable'}); }
    }
    // Inline copy edits: the frame validated + captured the changed rows and
    // replies with the ops; stage them server-side (the pill appears), then
    // re-arm pick for the next element. Empty ops = the user changed nothing.
    else if(d.type==='oa:live:edit:data'){
      var ops=Array.isArray(d.ops)?d.ops:[];
      var elCtx=d.element;
      if(ops.length&&elCtx){
        var eref=elCtx.id||(elCtx.classes&&elCtx.classes.length?elCtx.classes.join('.'):null)||elCtx.tagName||'element';
        fetch('/api/artifacts/'+encodeURIComponent(cfg.artifactId)+'/live/edit-stash',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({pageUrl:window.location.pathname,ref:eref,element:elCtx,ops:ops})})
          .then(function(r){ if(!r.ok) throw 0; return r.json(); })
          .then(function(){ refreshStash(); if(window.__oaShowSuccess)window.__oaShowSuccess('Saved. Click Apply copy edits to write changes.'); })
          .catch(function(){ if(window.__oaShowError)window.__oaShowError('Failed to save the copy edits'); });
      }else if(window.__oaShowInfo){
        window.__oaShowInfo('No changes to save');
      }
      draft=null;
      setState('PICKING');
      toFrame({type:'oa:live:pick:arm'});
    }
    else if(d.type==='oa:live:edit:none'){ if(window.__oaShowInfo)window.__oaShowInfo('No editable text in this element'); setState('COMPOSE'); }
    else if(d.type==='oa:live:edit:rejected'){ if(window.__oaShowError)window.__oaShowError('Edit rejected: '+(d.reason||'plain text only — no markup')); }
  });

  // --- global bar ---
  // The Pick control (#oa-live-pick-toggle) is a display-only indicator, not a
  // button - no click handler. Pick is armed on open, locked while the prompt
  // is open, and re-armed after each committed item; the indicator's static
  // --active tint reflects the Live session.
  var exitArmed=null;
  function exitLive(){
    // A prompt batch is lost on exit — arm a confirm when one exists (same
    // vocabulary as Apply/Discard); with no items, Exit closes immediately.
    if(items.length&&!exitArmed){
      exitBtn.querySelector('.oa-dock-label').textContent='Discard '+items.length+' changes?';
      exitBtn.classList.add('oa-dock-btn--danger');
      exitArmed=setTimeout(function(){ exitArmed=null; exitBtn.querySelector('.oa-dock-label').textContent='Exit'; exitBtn.classList.remove('oa-dock-btn--danger'); },4000);
      return;
    }
    if(exitArmed){ clearTimeout(exitArmed); exitArmed=null; }
    // Route through the dock manager so active-state, focus restore, and
    // mutual-exclusion bookkeeping stay consistent with the header toggle.
    // closeLive is a no-op when already closed.
    if(window.__oaDock) window.__oaDock.close('live'); else closeLive();
  }
  exitBtn.onclick=exitLive;

  function reset(){
    state='IDLE'; items=[]; draft=null; pendingRearm=false; lastSubmitType=null;
    // Restore the Exit control if a batch confirm was armed.
    if(exitArmed){ clearTimeout(exitArmed); exitArmed=null; }
    exitBtn.querySelector('.oa-dock-label').textContent='Exit';
    exitBtn.classList.remove('oa-dock-btn--danger');
    renderBar(); abar.hidden=true;
    toFrame({type:'oa:live:pick:disarm'});
    // A closing session must not leave the frame in edit mode: restore the
    // original texts (the frame's disableEditMode(true) unwraps + restores).
    toFrame({type:'oa:live:edit:cancel'});
  }
  // After a successful edit the frame reloads to show the new version. Clear
  // the batch and return to PICKING - arming the next-item picker once the
  // reloaded frame reports ready (a fresh frame defaults to disarmed; arming
  // synchronously would race the reload and be lost). If the user exited
  // during the CONFIRMED window the dock is hidden: still reload (to show the
  // new version) but skip the re-arm - state stays IDLE from closeLive, so
  // reopening arms cleanly instead of stranding on a stale PICKING state.
  function restartAfterEdit(){ reloadFrame(); if(root.hidden) return; items=[]; draft=null; pendingRearm=true; setState('PICKING'); }

  connect();
})();
`;
