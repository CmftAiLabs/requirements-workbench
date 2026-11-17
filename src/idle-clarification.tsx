import {useEffect,useState} from 'react';
import {Info,X} from 'lucide-react';
import type {Card} from '../shared/types';
import {CLARIFICATION_IDLE_MS,clarificationBasis,clarificationKey,shouldShowClarification,type ClarificationHelp} from '../shared/idle-clarification';
const attempted=new Set<string>(),shown=new Set<string>();
const storageKey=(key:string)=>`req-clarification-seen:${key}`;
function wasShown(key:string){try{return shown.has(key)||sessionStorage.getItem(storageKey(key))==='1';}catch{return shown.has(key);}}
function markShown(key:string){shown.add(key);try{sessionStorage.setItem(storageKey(key),'1');}catch{/* Memory still prevents repeated reminders. */}}

export function IdleClarification({projectId,card,enabled,typing,waiting,running,onDiscuss}:{projectId:string;card:Card;enabled:boolean;typing:boolean;waiting:boolean;running:boolean;onDiscuss:(text:string)=>void}){
 const key=clarificationKey(card),basis=clarificationBasis(card);
 const [value,setValue]=useState<{basis:string;help:ClarificationHelp}>();
 useEffect(()=>{
  setValue(undefined);
  if(!key||!shouldShowClarification({idleMs:CLARIFICATION_IDLE_MS,enabled,typing,waiting,running,seen:wasShown(key)}))return;
  const abort=new AbortController();
  const timer=setTimeout(async()=>{
   if(attempted.has(basis))return;attempted.add(basis);
   try{
    const response=await fetch(`/api/projects/${projectId}/cards/${card.id}/clarification-help`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({basis}),signal:abort.signal});
    if(!response.ok)return;
    const result=await response.json();
    if(abort.signal.aborted||result.basis!==basis||!result.help||!['explanation','suggestion','question'].every(k=>typeof result.help[k]==='string'))return;
    markShown(key);setValue({basis,help:result.help});
   }catch{/* An optional reminder must never interrupt the conversation on failure. */}
  },CLARIFICATION_IDLE_MS);
  return()=>{clearTimeout(timer);abort.abort();};
 },[projectId,card.id,key,basis,enabled,typing,waiting,running]);
 if(!value||value.basis!==basis||!enabled||typing||waiting||running)return null;
 return <div className="co-confirmation"><Info size={18}/><div><strong>这项规则可以顺便定一下</strong><p>{value.help.explanation}</p>{value.help.suggestion&&<p><strong>可讨论的建议：</strong>{value.help.suggestion}</p>}<p>{value.help.question}</p><small>建议尚未确认，不会自动写入需求。</small><div className="co-confirm-actions"><button onClick={()=>{onDiscuss(`关于“${card.blockers.find(b=>!b.resolved)?.reason}”：\n${value.help.suggestion||value.help.question}\n我的意见是：`);setValue(undefined);}}>带入讨论</button><button onClick={()=>setValue(undefined)}><X size={13}/>暂不讨论</button></div></div></div>;
}
