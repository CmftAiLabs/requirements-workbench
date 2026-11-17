import {LoaderCircle,Sparkles} from 'lucide-react';
import type {ReactNode} from 'react';
import {EXPERT_NAMES,type RequirementAssessment} from '../shared/expert-discussion';
import {FIELDS,type Card,type Project} from '../shared/types';
import {ConversationMaterials} from './conversation-materials';
import './requirement-assessment.css';

export function RequirementAssessmentCard({assessment:a,project,card,busy,retry,openDraft,openCard,children}:{assessment:RequirementAssessment;project:Project;card:Card;busy:boolean;retry:()=>void;openDraft:(id?:string)=>void;openCard:(id:string)=>void;children?:ReactNode}){
 const report=a.report,stale=a.baseRevision!==card.revision;
 const status=a.status==='running'?(stale?'收到新补充，将重新核对评估':'正在为您评估需求'):a.status==='completed'?'需求评估':a.status==='failed'?'本次评估未完成':a.status==='cancelled'?'已取消需求评估':'讨论已更新';
 return <article className="co-message agent" id={`assessment-${a.id}`}>
  <span className="co-avatar agent"><Sparkles size={17} aria-hidden="true"/></span>
  <div className="co-message-content"><div className="co-message-meta"><strong>需求助手</strong><span>需求评估</span><time dateTime={a.createdAt}>{new Date(a.createdAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}</time></div>
   <div className="co-assessment" aria-busy={a.status==='running'}>
    <div className="co-assessment-status" role="status">{a.status==='running'&&<LoaderCircle className="spin" size={15} aria-hidden="true"/>}<strong>{status}</strong></div>
    {a.status==='running'&&<><p>{a.reason}</p><small>正在核对相关规则和不同视角，你可以继续发言。</small></>}
    {a.status==='failed'&&<><p role="alert">{a.error||'原消息和材料已保留，请按最新讨论重试。'}</p><button type="button" disabled={busy} onClick={retry}>按最新讨论重试</button></>}
    {a.status==='cancelled'&&<p>已按明确取消的要求停止本次评估，原讨论仍保留。</p>}
    {a.status==='superseded'&&<><p>本次评估依据已变化，旧结果未采用。后续回应以最新讨论为准。</p><button type="button" disabled={busy} onClick={retry}>按最新讨论重新评估此问题</button></>}
    {a.status==='completed'&&report&&<>
     {stale&&<small className="co-assessment-old">这是此前讨论的评估，后续补充尚未包含在内。</small>}
     <details className="co-assessment-details co-assessment-summary">
      <summary>查看评估结论</summary>
      <p className="co-assessment-conclusion">{report.conclusion}</p>
     </details>
     {children}
     <details className="co-assessment-details"><summary>查看分析依据与不同意见</summary>
      <small>结合 PM、业务分析、UX 视角形成的分析概览。</small>
      <section><h3>为什么评估</h3><p>{a.reason}</p></section>
      {report.perspectives.map(p=><section key={p.role}><h3>{EXPERT_NAMES[p.role]}</h3><p>{p.opinion}</p><p className="co-assessment-reason">{p.reason}</p>{p.fields.length>0&&<small>涉及：{p.fields.map(f=>FIELDS.find(([key])=>key===f)?.[1]).join('、')}</small>}</section>)}
      {report.alternatives.length>0&&<section><h3>方案与取舍</h3>{report.alternatives.map((o,i)=><div className="co-assessment-option" key={i}><strong>{o.option}</strong><p>收益：{o.benefit}</p><p>代价：{o.cost}</p></div>)}</section>}
      {report.unresolved.length>0&&<section><h3>仍待明确</h3><ul>{report.unresolved.map((item,i)=><li key={i}>{item}</li>)}</ul></section>}
      <section><h3>本次参考范围</h3><p>{report.coverage}</p>
       <ConversationMaterials project={project} openDraft={openDraft} openCard={openCard} message={{id:a.id,role:'agent',text:'',createdAt:a.createdAt,materialReply:{contextMessageId:a.sourceMessageId,sourceMessageIds:[],materialIds:[],clarifiesCurrent:false,relatedCardIds:[],warnings:[],evidence:report.evidence}}}/>
      </section>
     </details>
     {a.materialReply&&<ConversationMaterials project={project} openDraft={openDraft} openCard={openCard} message={{id:a.id,role:'agent',text:'',createdAt:a.createdAt,materialReply:{...a.materialReply,evidence:[]}}}/>}
     <small>评估建议仍需产品与业务核对，不代表需求已确认。</small>
    </>}
   </div>
  </div>
 </article>;
}
