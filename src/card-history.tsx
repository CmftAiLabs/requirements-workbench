import {useEffect,useState} from 'react';
import type {Card,Project} from '../shared/types';

export function CardHistory({project,card}:{project:Project;card:Card}){
 const [open,setOpen]=useState(false),[retry,setRetry]=useState(0);
 const [loaded,setLoaded]=useState<{key:string;history:Card['history'];error:string}>();
 const key=`${project.id}:${card.id}:${card.revision}:${card.historyCount??card.history.length}`;
 const deferred=(card.historyCount??card.history.length)>card.history.length;
 useEffect(()=>{
  if(!open||!deferred)return;const abort=new AbortController();
  fetch(`/api/projects/${project.id}/cards/${card.id}/history`,{signal:abort.signal}).then(async r=>{if(!r.ok)throw Error('历史记录读取失败，请重试。');return r.json();}).then(v=>setLoaded({key,history:v.history,error:''})).catch(e=>{if(e.name!=='AbortError')setLoaded({key,history:[],error:e.message});});
  return()=>abort.abort();
 },[open,key,deferred,retry]);
 const history=loaded?.key===key&&!loaded.error?loaded.history:card.history;
 return <details className="co-detail-sources" onToggle={e=>setOpen(e.currentTarget.open)}><summary>材料来源与历史记录</summary>{card.sources.map(id=><p key={id}>{project.materials.find(m=>m.id===id)?.name||id}</p>)}{deferred&&loaded?.key!==key&&<p role="status">正在读取历史记录…</p>}{loaded?.key===key&&loaded.error&&<button className="small" onClick={()=>{setLoaded(undefined);setRetry(n=>n+1);}}>{loaded.error}</button>}{history.slice().reverse().map(h=><p key={h.revision}>修订 {h.revision} · {h.reason}</p>)}</details>;
}
