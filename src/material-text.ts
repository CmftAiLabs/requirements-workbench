import {useEffect,useState} from 'react';
import type {Material} from '../shared/types';

export function useMaterialText(projectId:string,material:Material|undefined){
 const [loaded,setLoaded]=useState<{key:string;text:string;error:string}>();
 const key=material?`${projectId}:${material.id}:${material.textVersion||''}`:'';
 useEffect(()=>{
  if(!material||material.textAvailable===undefined)return;
  const abort=new AbortController();
  fetch(`/api/projects/${projectId}/materials/${material.id}/text`,{signal:abort.signal}).then(async r=>{if(!r.ok)throw Error('材料正文读取失败，请关闭后重试。');return r.json();}).then(v=>setLoaded({key,text:v.text,error:''})).catch(e=>{if(e.name!=='AbortError')setLoaded({key,text:'',error:e.message});});
  return()=>abort.abort();
 },[key]);
 return material?.textAvailable===undefined?{text:material?.text||'',loading:false,error:''}:loaded?.key===key?{...loaded,loading:false}:{text:'',loading:true,error:''};
}
