import {useId} from 'react';
import {ChevronDown} from 'lucide-react';
import {COMMUNICATION_PRIORITIES,type CardOrganization} from '../shared/types';
import {priorityTone} from '../shared/card-organization';
import './organization.css';

export function PriorityBadge({value, title, onAdjust, disabled}:{
 value:CardOrganization['priority'];title?:string;onAdjust?:()=>void;disabled?:boolean;
}){
 const className=`organization-badge ${priorityTone(value)}`;
 const label=<><i aria-hidden="true"/>{value}</>;
 if(!onAdjust)return <span className={className} title={title}>{label}</span>;
 return <button type="button" className={`${className} co-organization-trigger`}
  aria-label={`${value}，调整沟通安排`} aria-haspopup="dialog" title={title||'调整沟通安排'}
  disabled={disabled} onClick={onAdjust}>
  {label}<ChevronDown size={11} aria-hidden="true"/>
 </button>;
}
export function OrganizationFields({value,onChange,modules,disabled=false}:{value:CardOrganization;onChange:(value:CardOrganization)=>void;modules:string[];disabled?:boolean}){
 const list=useId();
 const descriptions={'优先沟通':'先解决影响其他需求或本期范围的关键问题。','正常沟通':'按模块推进，明确这项需求自身的规则。','后续沟通':'稍后处理的细节；正式评审前仍需明确。'};
 return <div className="organization-fields">
  <label className="organization-module">模块归属<input aria-label="模块归属" list={list} maxLength={30} disabled={disabled} value={value.module} onChange={e=>onChange({...value,module:e.target.value})}/><datalist id={list}>{[...new Set(modules)].map(name=><option value={name} key={name}/>)}</datalist></label>
  <div className="organization-priority"><span>沟通优先级</span><div role="group" aria-label="沟通优先级">{COMMUNICATION_PRIORITIES.map(priority=><button type="button" key={priority} aria-pressed={value.priority===priority} className={`${priorityTone(priority)} ${value.priority===priority?'selected':''}`} disabled={disabled} onClick={()=>onChange({...value,priority})}>{priority}</button>)}</div><small>{descriptions[value.priority]}</small></div>
  <label className="organization-reason">为什么这样安排<textarea aria-label="优先级理由" value={value.reason} maxLength={240} rows={2} disabled={disabled} onChange={e=>onChange({...value,reason:e.target.value})} placeholder="说明影响了哪些需求，或为什么可以稍后沟通"/></label>
 </div>;
}
