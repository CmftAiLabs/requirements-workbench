import {randomUUID} from 'node:crypto';
import type {Bootstrap,Project,Card} from '../shared/types';
import {stateDiff,type WorkspaceSync} from '../shared/workspace-sync';
import {digest} from './demo-schema';
import {recordMetric} from './metrics';
import {pendingAttachmentMessages} from '../shared/chat-attachments';

export const messageChangeKey=(card:Card)=>digest(card.messages.filter(m=>m.kind==='change').map(m=>[m.id,m.accepted]));
export function cardView(card:Card,limit=4,changeKey=messageChangeKey(card)):Card{
 const important=new Set(card.suggestion?.changes.flatMap(c=>c.evidence.flatMap(e=>e.messageId?[e.messageId]:[]))||[]);
 for(const b of card.blockers)for(const e of b.resolutionEvidence||[])if(e.messageId)important.add(e.messageId);
 for(const q of card.followUps||[])if(q.status==='waiting')important.add(q.sourceMessageId);
 for(const m of pendingAttachmentMessages(card))important.add(m.id);
 const human=card.messages.findLast(m=>m.role!=='agent');if(human)important.add(human.id);
 const start=Math.max(0,card.messages.length-limit);
 const count=card.messageCount??card.messages.length;
 return {...card,messageCount:count,messageVersion:digest({count,last:card.messages.at(-1)?.id||'',changes:changeKey}),messages:card.messages.filter((m,i)=>i>=start||important.has(m.id)||m.kind==='change'&&!m.accepted),history:card.history.slice(-2),historyCount:card.historyCount??card.history.length};
}
export function compactProject(p:Project):Project{
 const snapshot=(s:Project['snapshots'][number])=>({...s,cards:[],materials:[],markdown:'',cardCount:s.cards.length,deferred:true});
 return {...p,...(p.generatedDemo?{generatedDemo:{...p.generatedDemo,revisions:p.generatedDemo.revisions.slice(-2)}}:{}),cards:p.cards.map(c=>cardView(c)),materials:p.materials.map(m=>({...m,text:'',textAvailable:!!m.text.trim(),textVersion:digest(m.text)})),snapshots:p.snapshots.map(snapshot),deliveries:p.deliveries.map(d=>({...d,snapshot:snapshot(d.snapshot)})),events:p.events.slice(-40)};
}

/** Bounded, process-local cursors: an expired cursor or a restart returns a fresh snapshot. */
export function createWorkspaceSync(maxBytes=24*1024*1024,maxEntries=128){
 type Entry={signature:string;context:string;value:Bootstrap;bytes:number};
 const cache=new Map<string,Entry>(),pending=new Map<string,Promise<[string,Entry]>>();let used=0;
 return async(context:string,signature:string,cursor:string|undefined,load:(previous?:Bootstrap)=>Promise<Bootstrap>):Promise<WorkspaceSync>=>{
  const previous=cursor?cache.get(cursor):undefined;
  if(previous?.context===context&&previous.signature===signature){recordMetric('sync.unchanged',0);return {kind:'unchanged',cursor:cursor!};}
  const known=[...cache].find(([,entry])=>entry.context===context&&entry.signature===signature),key=context+'\0'+signature;
  let state=known;
  if(!state){
   let loading=pending.get(key);
   if(!loading){
    loading=(async():Promise<[string,Entry]>=>{
     const value=await load(previous?.context===context?previous.value:undefined),next=randomUUID(),bytes=Buffer.byteLength(JSON.stringify(value)),entry={signature,context,value,bytes};
     if(bytes<=maxBytes){cache.set(next,entry);used+=bytes;while(used>maxBytes||cache.size>maxEntries){const oldest=cache.keys().next().value!;used-=cache.get(oldest)!.bytes;cache.delete(oldest);}}
     return [next,entry];
    })();pending.set(key,loading);
   }
   try{state=await loading;}finally{if(pending.get(key)===loading)pending.delete(key);}
  }
  const [next,{value,bytes}]=state;
  let response:WorkspaceSync={kind:'snapshot',cursor:next,value};
  if(previous?.context===context){
   const patches=stateDiff(previous.value,value);
   if(patches.length<=3000&&Buffer.byteLength(JSON.stringify(patches))<bytes)response={kind:'delta',cursor:next,base:cursor!,patches};
  }
  recordMetric('sync.'+response.kind,0,{bytes:Buffer.byteLength(JSON.stringify(response))});return response;
 };
}
