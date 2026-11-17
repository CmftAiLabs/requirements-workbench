import {personLabel} from '../shared/participants';
import {useId} from 'react';
import {FIELDS, ROLES, type Card, type Evidence, type FieldKey, type Material, type ProblemResolution} from '../shared/types';
import {resolutionDisabledReason} from '../shared/resolution-policy';
import './problem-resolution.css';

type Context = {card:Card;materials:Material[]};
const fieldNames = new Map<string,string>(FIELDS);
const roleNames = {business:'业务人员',pm:'产品经理',reviewer:'历史参与者'};

function dateLabel(value:string) {
 const date = new Date(value);
 return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
}

function ResolutionEvidence({card,materials,evidence}:{evidence?:Evidence[]}&Context) {
 if (!evidence?.length) return <p className="resolution-meta">暂无已记录的原文依据。</p>;
 return <details className="resolution-evidence"><summary>查看原文依据 · {evidence.length}</summary>
  <ul>{evidence.map((item,index)=>{
   const message = item.messageId ? card.messages.find(message=>message.id===item.messageId) : undefined;
   const material = item.materialId ? materials.find(material=>material.id===item.materialId) : undefined;
   const source = item.messageId
    ? message ? `${personLabel(message)} · ${dateLabel(message.createdAt)}` : '讨论发言（原文暂不可用）'
    : material?.name || '项目材料（原文暂不可用）';
   return <li key={`${item.messageId||item.materialId||'evidence'}-${index}`}><span>{source}{item.location?` · ${item.location}`:''}</span><blockquote>{item.quote}</blockquote></li>;
  })}</ul>
 </details>;
}

function ResolutionContent({card,materials,candidate}:{candidate:ProblemResolution}&Context) {
 const fields = candidate.requiredFields?.map(field=>fieldNames.get(field)||field).join('、');
 const roles = candidate.requiredRoles?.map(role=>roleNames[role]||role).join('、');
 return <>
  <p className="resolution-conclusion"><span>讨论结论</span>{candidate.resolution||'尚未形成结论'}</p>
  <dl className="resolution-dependencies"><dt>关联字段</dt><dd>{fields||'待补充'}</dd><dt>需有意见</dt><dd>{roles||'待补充'}</dd></dl>
  <ResolutionEvidence card={card} materials={materials} evidence={candidate.evidence}/>
 </>;
}

export function ResolutionSuggestions({card,materials}:Context) {
 const suggestion = card.suggestion;
 if (!suggestion || suggestion.status!=='待决定' || suggestion.baseRevision!==card.revision || suggestion.messageCount!==(card.messageCount??card.messages.length)) return null;
 const candidates = (suggestion.problemResolutions||[]).filter(item=>card.blockers.some(blocker=>blocker.id===item.blockerId&&!blocker.resolved));
 if (!candidates.length) return null;
 return <section className="resolution-section resolution-suggestions" aria-label="建议解决的问题">
  <h3>建议解决的问题 · {candidates.length}</h3>
  <p className="resolution-meta">采纳预览中选择是否一并解决，Agent 不会自行关闭问题。</p>
  <div className="resolution-list">{candidates.map(candidate=><article className="resolution-item" key={candidate.blockerId}>
   <strong className="resolution-title">{card.blockers.find(blocker=>blocker.id===candidate.blockerId)?.reason||'关联问题已不存在'}</strong>
   <ResolutionContent card={card} materials={materials} candidate={candidate}/>
  </article>)}</div>
 </section>;
}

export function ProblemResolutionReview({card,materials,decisions,overrides,selectedIds,onToggle,disabledReason=''}:Context&{
 decisions:Partial<Record<FieldKey,'采纳'|'不采纳'>>;
 overrides?:Partial<Record<FieldKey,string>>;
 selectedIds:string[];
 onToggle:(id:string,checked:boolean)=>void;
 disabledReason?:string;
}) {
 const id = useId();
 const candidates = card.suggestion?.problemResolutions||[];
 if (!candidates.length) return null;
 return <section className="resolution-section resolution-review" aria-label="同时解决的问题">
  <h3>同时解决的问题</h3>
  <p className="resolution-meta">勾选后与字段修改一起保存；未勾选的问题继续保留。整卡确认另行完成。</p>
  <div className="resolution-list">{candidates.map((candidate,index)=>{
   const problem = card.blockers.find(blocker=>blocker.id===candidate.blockerId)?.reason||'关联问题已不存在';
   const reason = disabledReason||resolutionDisabledReason(card,candidate,decisions,overrides);
   const reasonId = `${id}-reason-${index}`;
   return <article className={`resolution-item${reason?' resolution-unavailable':''}`} key={candidate.blockerId}>
    <label className="resolution-select"><input type="checkbox" aria-label={`同时解决：${problem}`} checked={selectedIds.includes(candidate.blockerId)} disabled={!!reason} aria-describedby={reason?reasonId:undefined} onChange={event=>onToggle(candidate.blockerId,event.target.checked)}/><strong>{problem}</strong></label>
    <ResolutionContent card={card} materials={materials} candidate={candidate}/>
    {reason&&<p className="resolution-disabled-reason" id={reasonId}>{reason}</p>}
   </article>;
  })}</div>
 </section>;
}

export function ResolvedProblemRecords({card,materials}:Context) {
 const resolved = card.blockers.filter(blocker=>blocker.resolved);
 if (!resolved.length) return null;
 return <details className="resolution-section resolved-problem-records"><summary>已解决的问题 · {resolved.length}</summary>
  <div className="resolution-list">{resolved.map(blocker=><article className="resolution-item" key={blocker.id}>
   <strong className="resolution-title">{blocker.reason}</strong>
   <p className="resolution-conclusion"><span>处理结论</span>{blocker.resolution||'已记录为解决，暂无结论详情。'}</p>
   {(blocker.resolvedAt||blocker.resolvedBy)&&<p className="resolution-meta">{[blocker.resolvedBy?ROLES[blocker.resolvedBy]:undefined,blocker.resolvedAt?dateLabel(blocker.resolvedAt):undefined].filter(Boolean).join(' · ')}</p>}
   <ResolutionEvidence card={card} materials={materials} evidence={blocker.resolutionEvidence}/>
  </article>)}</div>
 </details>;
}
