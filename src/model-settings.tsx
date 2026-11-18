import {useEffect,useState} from 'react';
import {ChevronDown,LoaderCircle} from 'lucide-react';
import {WorkspaceModal} from './workspace-ui';
type Settings={model:string;options:string[];policies:Record<string,string>;visionModel:string};
type Request=<T>(url:string,data?:unknown)=>Promise<T>;
export function ModelPicker({model,request,save,disabledReason,onSettings}:{model:string;request:Request;save:(model:string)=>Promise<boolean>;disabledReason:string;onSettings:()=>void}){
 const [options,setOptions]=useState<string[]>([]),[saving,setSaving]=useState(false);
 useEffect(()=>{let live=true;request<Settings>('/api/models').then(s=>{if(live)setOptions(s.options);}).catch(()=>{});return()=>{live=false;};},[request]);
 const reason=disabledReason||(saving?'正在切换模型…':'');
 const choices=[...new Set([...options,model])];
 return <span className="co-model-picker" title={reason||`当前模型：${model}。切换应用于整个工作台的后续需求分析与原型生成。`}>
  <span className="co-model-name-width" aria-hidden="true">{model}</span>
  <select aria-label="选择对话模型" value={model} disabled={!!reason} onChange={async e=>{
   const value=e.target.value;if(value==='__settings__'){onSettings();return;}if(value===model||reason)return;
   setSaving(true);try{await save(value);}finally{setSaving(false);}
  }}><optgroup label="需求助手模型">{choices.map(value=><option key={value} value={value}>{value}</option>)}</optgroup><option value="__settings__">模型设置与连接检查…</option></select>
  {saving?<LoaderCircle size={12} className="spin" aria-hidden="true"/>:<ChevronDown size={12} aria-hidden="true"/>}
 </span>;
}
export function ModelSettings({request,save,canEdit,onClose}:{request:<T>(url:string,data?:unknown)=>Promise<T>;save:(model:string)=>Promise<boolean>;canEdit:boolean;onClose:()=>void}){
 const [settings,setSettings]=useState<Settings>(),[selected,setSelected]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
 useEffect(()=>{let live=true;request<Settings>('/api/models').then(s=>{if(live){setSettings(s);setSelected(s.model);}}).catch(()=>{if(live)setMessage('模型设置读取失败，请关闭后重试。');});return()=>{live=false;};},[request]);
 async function probe(){setBusy(true);setMessage('正在检查连接…');try{const result=await request<{ok:boolean;message:string}>('/api/models/probe',{model:selected});setMessage(`${result.ok?'检查通过':'检查未通过'}：${result.message}`);}catch(e){setMessage(e instanceof Error?e.message:'检查失败');}finally{setBusy(false);}}
 return <WorkspaceModal title="模型设置" onClose={onClose}><p>选择整个工作台用于需求讨论、评估和原型生成的模型。正在运行的任务完成后才能切换。</p>
 {settings&&<><label htmlFor="workspace-model">需求助手模型</label><select id="workspace-model" value={selected} disabled={busy||!canEdit} onChange={e=>{setSelected(e.target.value);setMessage('');}}>{settings.options.map(m=><option key={m} value={m}>{m}</option>)}</select><p className="tiny muted">当前使用：{settings.model}<br/>图片识别：{settings.visionModel}（独立配置）</p><p className="tiny muted">思考策略：{settings.policies?.[selected]||'网关默认'}</p><p className="tiny muted">连接检查只验证基本文本响应；可用额度及工具、图片能力取决于网关配置。切换不会自动重跑历史评估。</p></>}
 {!canEdit&&<p>由产品经理切换模型。</p>}{message&&<p role="status">{message}</p>}
 <div className="modal-actions"><button disabled={busy||!settings||!canEdit} onClick={()=>void probe()}>检查连接</button><button className="primary" disabled={busy||!settings||!canEdit||selected===settings.model} onClick={async()=>{setBusy(true);try{if(await save(selected))onClose();}finally{setBusy(false);}}}>{busy?'处理中…':'保存选择'}</button></div>
 </WorkspaceModal>;
}
