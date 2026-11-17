import {FIELDS,type Card,type FieldKey,type Project} from './types.ts';
import {demoKind,liveSuggestion} from './crm-demo.ts';
import {conferencePage} from './conference-demo.ts';

export function demoUpdate(card:Card){
 const suggestion=liveSuggestion(card);
 const previous=card.history.filter(h=>h.revision<card.revision).at(-1);
 const changes=suggestion?suggestion.changes.filter(c=>c.before!==c.after):previous?FIELDS.flatMap(([field])=>previous.fields[field]===card.fields[field]?[]:[{field,before:previous.fields[field],after:card.fields[field],reason:card.history.at(-1)?.reason||''}]):[];
 return {id:suggestion?.id||`revision-${card.revision}`,draft:!!suggestion,revision:card.revision,changes};
}
export function tracePayload(project:Project,current:Card){
 return {projectId:project.id,currentCardId:current.id,conference:project.demo?.kind==='conference',
  cards:project.cards.filter(c=>c.granularity!=='概要'&&c.included).map(c=>({id:c.id,title:c.title,page:conferencePage(c),kind:demoKind(c),changed:demoUpdate(c).changes.map(x=>x.field)}))};
}
export function readDemoTrace(data:unknown,project:Project){
 if(!data||typeof data!=='object')return null;
 const d=data as {channel?:unknown;type?:unknown;projectId?:unknown;cardIds?:unknown;field?:unknown};
 if(d.channel!=='requirements-demo'||d.type!=='trace'||d.projectId!==project.id||!Array.isArray(d.cardIds))return null;
 const cardIds=[...new Set(d.cardIds)].filter((id):id is string=>typeof id==='string'&&project.cards.some(c=>c.id===id&&c.granularity!=='概要'&&c.included));
 if(!cardIds.length||cardIds.length!==new Set(d.cardIds).size)return null;
 return {cardIds,field:FIELDS.some(([k])=>k===d.field)?d.field as FieldKey:undefined};
}

/** A small, deterministic bridge; the iframe cannot mutate workbench requirements. */
function bridgeClient(payload:ReturnType<typeof tracePayload>){
 if(typeof document.createElement!=='function')return;
 const cards=payload.cards;
 const style=document.createElement('style');
 style.textContent='.wb-demo-changed{outline:1px dashed #83ade6;outline-offset:3px}.wb-demo-focus{outline:2px solid #3479ca!important;outline-offset:4px!important;box-shadow:0 0 0 5px #e4effc!important;scroll-margin:24px}';
 document.head.append(style);
 const mark=(selector:string,ids:string[],field:string)=>{if(!ids.length)return;document.querySelectorAll<HTMLElement>(selector).forEach(el=>{el.dataset.reqCards=JSON.stringify(ids);el.dataset.reqField=field;});};
 const idsFor=(page:string)=>cards.filter(c=>c.page===page).map(c=>c.id);
 function annotate(){
  if(payload.conference){
   const page=document.getElementById('content')?.dataset.demoPage;
   if(page){
    mark('#content, #trace-label',idsFor(page),'flow');
    mark('#registration',idsFor('register'),'data');
    mark('#authorize, #membership',idsFor('register'),'permission');
    document.querySelectorAll<HTMLElement>('[data-action]').forEach(el=>{
     const action=el.dataset.action||'';
     const target=action.startsWith('go:')?action.slice(3):action.startsWith('agenda-')?'agenda':/^(invite:|submit-invite:|accept:|exchange:|record:)/.test(action)?'appointments':/^(payment|paid|approve|reject)$/.test(action)?'register':page;
     const ids=idsFor(target);if(ids.length){el.dataset.reqCards=JSON.stringify(ids);el.dataset.reqField=/^agenda-(clear|retry|restore|fail-again)$/.test(action)?'exception':/exchange|approve|reject/.test(action)?'permission':'flow';}
    });
    if(page==='agenda'){mark('#search',idsFor('agenda'),'flow');mark('#agenda-feedback',idsFor('agenda'),'exception');}
   }
  }else{
   const transfer=cards.find(c=>c.kind==='transfer'),notification=cards.find(c=>c.kind==='notification');
   if(transfer){
    mark('#transfer-panel, #transfer',[transfer.id],'flow');
    mark('#persona, #policy, #denied, #access-label',[transfer.id],'permission');
    mark('#fail',[transfer.id],'exception');mark('#recipient',[transfer.id],'constraint');
    mark('#history, #logs, [data-tab="history"]',[transfer.id],'data');
   }
   if(notification)mark('#notifications, #notifications-list, [data-tab="notifications"]',[notification.id],'flow');
  }
  document.querySelectorAll<HTMLElement>('[data-req-cards]').forEach(el=>{
   let ids:string[]=[];try{ids=JSON.parse(el.dataset.reqCards||'[]');}catch{return;}
   el.classList.toggle('wb-demo-changed',cards.some(c=>ids.includes(c.id)&&c.changed.includes(el.dataset.reqField as FieldKey)));
  });
 }
 const send=(cardIds:string[],field?:string)=>{if(window.parent!==window)window.parent.postMessage({channel:'requirements-demo',type:'trace',projectId:payload.projectId,cardIds,field},'*');};
 document.addEventListener('click',event=>{
  if(!event.isTrusted)return;
  const el=(event.target as Element).closest<HTMLElement>('[data-req-cards]');if(!el)return;
  try{const ids=JSON.parse(el.dataset.reqCards||'[]');if(ids.length)send(ids,el.dataset.reqField);}catch{/* Ignore malformed trace metadata. */}
 });
 window.addEventListener('message',event=>{
  if(event.source!==window.parent||event.data?.channel!=='requirements-workbench'||event.data?.type!=='locate'||event.data?.projectId!==payload.projectId)return;
  const card=cards.find(c=>c.id===event.data.cardId);if(!card)return;
  const field=event.data.field as string|undefined;
  document.dispatchEvent(new CustomEvent('workbench-locate',{detail:{cardId:card.id,field}}));
  if(!payload.conference){
   const tab=card.kind==='notification'?'notifications':field==='data'?'history':'detail';
   document.querySelector<HTMLButtonElement>(`[data-tab="${tab}"]`)?.click();
  }
  window.requestAnimationFrame(()=>{
   annotate();document.querySelectorAll('.wb-demo-focus').forEach(el=>el.classList.remove('wb-demo-focus'));
   const related=Array.from(document.querySelectorAll<HTMLElement>('[data-req-cards]')).filter(el=>{try{return JSON.parse(el.dataset.reqCards||'[]').includes(card.id);}catch{return false;}});
   const candidates=related.filter(el=>!field||el.dataset.reqField===field);
   const visibleRegion=(items:HTMLElement[])=>items.find(el=>el.getClientRects().length&&!el.closest('nav')&&!el.matches('button,input,select,textarea,a'))||items.find(el=>el.getClientRects().length&&!el.closest('nav'))||items.find(el=>el.getClientRects().length);
   const target=visibleRegion(candidates)||candidates[0]||visibleRegion(related);
   if(target){let parent=target.parentElement;while(parent){if(parent instanceof HTMLDetailsElement)parent.open=true;parent=parent.parentElement;}target.classList.add('wb-demo-focus');target.scrollIntoView({block:'center',behavior:'smooth'});}
  });
 });
 annotate();
 new MutationObserver(annotate).observe(document.body,{childList:true,subtree:true});
}

export function withDemoTrace(html:string,project:Project,card:Card){
 const payload=JSON.stringify(tracePayload(project,card)).replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
 // Keep a single script block so exported demos retain the same CSP and offline behavior.
 return html.replace('</script>',`;{const __name=(fn)=>fn;(${bridgeClient.toString()})(${payload});}</script>`);
}
