import {useConversationDraft} from './conversation-drafts';
import {IdleClarification} from './idle-clarification';
import {conclusionPresentation} from '../shared/conclusion-presentation';
import {ChatComposer} from './chat-composer';
import {attachmentDisabledReason,pendingAttachmentMessages} from '../shared/chat-attachments';
import {hasUnresolvedContent} from '../shared/requirement-clarity';
import {PARTICIPANTS,isQuestionRecipient,personFor,type ParticipantId} from '../shared/participants';
import {ConversationThread} from './conversation-thread';
import {DemoPreview,type DemoLocation} from './demo-preview';
import {waitingQuestion,waitingLabel} from '../shared/discussion';
import type {DiscussionReminder} from '../shared/discussion-reminders';
import {useEffect,useId,useRef,useState,type CSSProperties,type ReactNode} from 'react';
import {ArrowDown,ArrowLeft,ArrowRight,Check,CheckCheck,CheckCircle2,ChevronRight,FileText,FolderOpen,Info,Layers3,ListChecks,LoaderCircle,Maximize2,MessageCircle,PanelLeftClose,PanelLeftOpen,Play,RotateCcw,Search,Send,SlidersHorizontal,Sparkles,Users,X} from 'lucide-react';
import {FIELDS,ROLES,cardStatus,type Action,type Card,type FieldKey,type Job,type Project,type Role} from '../shared/types';
import {getChatDisabledReason,type ChatOperation} from '../shared/chat-policy';
import {resolutionDisabledReason} from '../shared/resolution-policy';
import {getSuggestionReview} from '../shared/suggestion-review';
import {liveSuggestion,previewFields} from '../shared/crm-demo';
import {concreteCards} from '../shared/intake-policy';
import {WorkspaceModal} from './workspace-ui';
import {RequirementPool} from './requirement-pool';
import {RequirementDetails} from './requirement-details';
import {requirementProgress} from './requirement-progress';
import {OrganizationFields,PriorityBadge} from './organization-fields';
import {needsAttention,organizationOf,organizationModules,pinnedChats,poolGroupingMode,isNamedModule} from '../shared/card-organization';

type Props={reminderFocus?:DiscussionReminder;modelPicker?:ReactNode;project:Project;card?:Card;role:Role;participantId:ParticipantId;busy:boolean;jobs:Job[];modelConfigured:boolean;setCard:(id:string)=>void;mutate:(action:Action,stamp?:number,success?:string)=>Promise<boolean>;suggest:(id:string)=>Promise<boolean>;generateDemo:(id:string)=>Promise<boolean>;organize:()=>Promise<boolean>;sendMaterials:(id:string,data:FormData)=>Promise<boolean>;resumeDiscussion:(id:string,assessmentId?:string)=>Promise<boolean>;goMaterials:(id?:string)=>void;onManage:()=>void};
const time=(s:string)=>new Date(s).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'});
const passed=(c:Card,role:'pm'|'business')=>c.approvals[role]?.result==='通过'&&c.approvals[role]?.revision===c.revision&&c.approvals[role]?.round===c.round;
const unknown=hasUnresolvedContent;
const businessOwner=personFor('business');

function ActionMention({role}:{role:'pm'|'business'}){
 const recipient=personFor(role);
 return <span className="co-action-mention" title={recipient.title}>@{recipient.name}</span>;
}

const summaryPreview=(value:string)=>{
 const text=value.replace(/\s+/g,' ').trim();
 if(text.length<=110)return text;
 const start=text.slice(0,110),end=Math.max(start.lastIndexOf('。'),start.lastIndexOf('！'),start.lastIndexOf('？'));
 return end>=35?start.slice(0,end+1):start.trimEnd()+'…';
};

export function CollaborationWorkspace({reminderFocus,modelPicker,project:p,card:c,role,participantId,busy,jobs,modelConfigured,setCard,mutate,suggest,generateDemo,organize,sendMaterials,resumeDiscussion,goMaterials,onManage}:Props){
 const actionRecipientId=useId();
 const {value:conversationDraft,setText,setReplyTo,setFiles,clear:clearDraft}=useConversationDraft(`${p.id}:${c?.id}:${participantId}`);
 const {text,replyTo,files}=conversationDraft;
 const [details,setDetails]=useState(false),[expanded,setExpanded]=useState(false),[collapsed,setCollapsed]=useState(false),[mobilePool,setMobilePool]=useState(false),[mobile,setMobile]=useState<'chat'|'preview'>('chat'),[reload,setReload]=useState(0),[ratio,setRatio]=useState(55),[adjust,setAdjust]=useState(false),[decisions,setDecisions]=useState<Partial<Record<FieldKey,'采纳'|'不采纳'>>>({}),[overrides,setOverrides]=useState<Partial<Record<FieldKey,string>>>({}),[reject,setReject]=useState(false),[reasonText,setReasonText]=useState(''),[hint,setHint]=useState('');
 const [demoLocation,setDemoLocation]=useState<DemoLocation>();
 const pendingNavigation=useRef<{cardId:string;text?:string;details?:boolean}|undefined>(undefined);
 const cardOrganization=organizationOf(c||{});
 const [organizing,setOrganizing]=useState(false),[organization,setOrganization]=useState(cardOrganization),[organizationStamp,setOrganizationStamp]=useState(p.stamp);
 const stream=useRef<HTMLDivElement>(null),input=useRef<HTMLTextAreaElement>(null),composing=useRef(false),sending=useRef(false),workspace=useRef<HTMLDivElement>(null),resizeCleanup=useRef<()=>void>(()=>{}),mobilePoolToggle=useRef<HTMLButtonElement>(null);
 const pendingMessage=useRef<{key:string;id:string}|undefined>(undefined);
 const context=useRef('');context.current=`${p.id}:${c?.id}:${participantId}`;
 const s=c?liveSuggestion(c):undefined;
 useEffect(()=>{const next=pendingNavigation.current?.cardId===c?.id?pendingNavigation.current:undefined;if(next?.text)setText(next.text);setHint('');setDetails(!!next?.details);setDemoLocation(undefined);setAdjust(false);setReject(false);setReload(0);setOrganizing(false);pendingNavigation.current=undefined;if(next?.text)input.current?.focus();},[p.id,c?.id]);
 useEffect(()=>{setDecisions(s?Object.fromEntries(s.changes.map(change=>[change.field,'采纳'])):{});setOverrides({});setAdjust(false);},[c?.id,s?.id]);
 useEffect(()=>{
  const el=stream.current;
  if(el&&!el.contains(document.activeElement?.closest('[data-reminder-anchor]')??null))el.scrollTop=el.scrollHeight;
 },[c?.id,c?.messages.length,c?.followUps?.length,c?.assessments?.length,s?.id,c?.approvals.pm?.id,c?.approvals.business?.id]);
 useEffect(()=>{
  if(reminderFocus?.projectId!==p.id||reminderFocus.cardId!==c?.id)return;
  setMobile('chat');
  setMobilePool(false);
  setExpanded(false);
  return focusDiscussion(reminderFocus.anchorId);
 },[reminderFocus,p.id,c?.id]);
 function focusDiscussion(anchorId:string){
  const frame=requestAnimationFrame(()=>{
   const target=document.getElementById(anchorId);
   if(target&&stream.current?.contains(target)){
    target.focus({preventScroll:true});
    target.scrollIntoView({block:'nearest',behavior:'instant'});
   }else{
    workspace.current?.querySelector<HTMLElement>('.co-chat-header h1')?.focus({preventScroll:true});
   }
  });
  return ()=>cancelAnimationFrame(frame);
 }
 useEffect(()=>()=>resizeCleanup.current(),[]);
 useEffect(()=>{const query=window.matchMedia('(max-width:650px)');const closeWide=()=>{if(!query.matches)setMobilePool(false);};query.addEventListener('change',closeWide);return()=>query.removeEventListener('change',closeWide);},[]);
 useEffect(()=>{
  if(!mobilePool)return;const pool=workspace.current?.querySelector<HTMLElement>('.co-pool');pool?.querySelector<HTMLButtonElement>('button')?.focus();
  const key=(event:KeyboardEvent)=>{
   if(document.querySelector('.modal[role="dialog"]'))return;
   if(event.key==='Escape'){event.preventDefault();setMobilePool(false);}
   if(event.key!=='Tab'||!pool)return;
   const items=Array.from(pool.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),summary')).filter(item=>item.getClientRects().length),first=items[0],last=items.at(-1);
   if(event.shiftKey&&(document.activeElement===first||!pool.contains(document.activeElement))){event.preventDefault();last?.focus();}
   else if(!event.shiftKey&&(document.activeElement===last||!pool.contains(document.activeElement))){event.preventDefault();first?.focus();}
  };
  document.addEventListener('keydown',key);return()=>{document.removeEventListener('keydown',key);mobilePoolToggle.current?.focus();};
 },[mobilePool]);
 const running=!!c&&jobs.some(j=>['suggest','listen'].includes(j.kind)&&j.cardId===c.id&&['running','queued'].includes(j.status));
 const progress=c?requirementProgress(c,running):undefined;
 const latestJob=jobs.find(j=>['suggest','listen'].includes(j.kind)&&j.cardId===c?.id);
 const policy=(op:ChatOperation)=>c?getChatDisabledReason(op,{project:p,card:c,role,participantId,busy,agentRunning:running,modelConfigured}):'请先选择需求';
 const editDisabled=c?.granularity==='概要'?(busy?'正在保存，请稍候':role!=='pm'?'仅产品经理可修改':p.deliveries.some(d=>!d.completedAt)?'当前文档已冻结交付':''):policy('editCard');
 const confirmed=c&&cardStatus(c)==='已确认';
 const activeBlockers=c?.blockers.filter(b=>!b.resolved)||[];
 const selectedOverrides=Object.fromEntries(Object.entries(overrides).filter(([key])=>decisions[key as FieldKey]==='采纳')) as Partial<Record<FieldKey,string>>;
 const cancelAdjust=()=>{setDecisions(s?Object.fromEntries(s.changes.map(change=>[change.field,'采纳'])):{});setOverrides({});setAdjust(false);};
 const resolved=c&&s?(s.problemResolutions||[]).filter(r=>!resolutionDisabledReason(c,r,decisions,selectedOverrides)).map(r=>r.blockerId):[];
 const presentation=s?conclusionPresentation(s):{actionable:false,issues:[]};
 const remainingIssues=presentation.issues;
 const productProposal=s?.reviewRole==='business';
 const clarificationOnly=!!s?.issues.length&&!s.changes.length&&!s.problemResolutions?.length;
 const reviewOperation=productProposal?'confirmProductSuggestion':'applySuggestion';
 const plan=c&&s?getSuggestionReview(c,decisions,selectedOverrides):undefined;
 const ready=!!plan&&!Object.values(plan.fields).some(unknown)&&activeBlockers.every(b=>resolved.includes(b.id))&&!s?.issues.length&&!plan.dependencyProblems.length;
 const keepOriginal=!!s?.changes.length&&!plan?.changedFields.length&&!resolved.length;
 const adoptionLabel=productProposal?'确认本轮变更':clarificationOnly?'标记已读':keepOriginal?'保留原需求':ready?'采纳并发起确认':'采纳本轮结论';
 const pins=new Set(pinnedChats(p,participantId).map(card=>card.id));
 const pending=concreteCards(p).filter(card=>needsAttention(p,card)).sort((a,b)=>Number(pins.has(b.id))-Number(pins.has(a.id)));
 const next=pending.find(card=>card.id!==c?.id);
 const startAgent=async()=>{if(!c||policy('suggest'))return;setHint('');if(pendingAttachmentMessages(c).length)await resumeDiscussion(c.id);else if(s?.changes.length)await generateDemo(c.id);else await suggest(c.id);};
 const send=async()=>{if(!c||!text.trim()||policy('discuss')||sending.current||composing.current)return;const value=text.trim(),at=context.current,id=c.id;sending.current=true;try{const key=JSON.stringify([at,c.revision,c.round,value,replyTo]);if(pendingMessage.current?.key!==key)pendingMessage.current={key,id:crypto.randomUUID()};const okay=await mutate({type:'message',cardId:id,text:value,baseRevision:c.revision,baseRound:c.round,clientMessageId:pendingMessage.current.id,...(replyTo?{replyTo}:{})},p.stamp,'消息已发送');if(okay){pendingMessage.current=undefined;clearDraft();}}finally{sending.current=false;}};
 const draft=(value:string)=>{setText(value);input.current?.focus();};
 const adopt=async()=>{
  if(!c||!s||!presentation.actionable||policy(reviewOperation))return;
  if(productProposal){
   await mutate({type:'confirmProductSuggestion',cardId:c.id,suggestionId:s.id},p.stamp,'业务负责人已确认本轮变更');
   return;
  }
  const action:Action={type:clarificationOnly?'applySuggestion':'adoptConclusion',cardId:c.id,suggestionId:s.id,decisions,overrides:selectedOverrides,resolvedBlockerIds:resolved};
  const success=clarificationOnly?'已读待澄清事项':keepOriginal?'已保留原需求，已有确认与阶段不变':ready?'结论已采纳，请业务负责人确认本轮需求':'结论已采纳，尚未明确的事项继续沟通';
  if(await mutate(action,p.stamp,success))setAdjust(false);
 };
 const startResize=(event:React.PointerEvent<HTMLDivElement>)=>{const rect=workspace.current?.getBoundingClientRect();if(!rect)return;event.preventDefault();const left=workspace.current?.querySelector('.co-pool')?.getBoundingClientRect().width||218;const move=(e:PointerEvent)=>setRatio(Math.max(38,Math.min(68,(e.clientX-rect.left-left)/(rect.width-left)*100)));const end=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',end);};resizeCleanup.current=end;window.addEventListener('pointermove',move);window.addEventListener('pointerup',end);};
 const waiting=c?waitingQuestion(c):undefined;
 useEffect(()=>{if(replyTo&&replyTo!==waiting?.id&&!c?.followUps?.some(q=>q.id===replyTo&&(q.status==='deferred'&&q.baseRevision===c.revision||q.status==='answered')))setReplyTo('');},[waiting?.id,replyTo,c?.followUps,c?.revision]);
 const locateDemo=(field?:FieldKey)=>{if(c){setDemoLocation({cardId:c.id,field,sequence:Date.now()});setMobile('preview');}};
 const preview=<DemoPreview key={p.id} demoJob={jobs.find(j=>j.kind==='demo')} canGenerate={modelConfigured&&!busy&&!!c?.included} onGenerate={()=>{if(c)void generateDemo(c.id);}} project={p} card={c} running={running} expanded={expanded} onExpand={()=>setExpanded(!expanded)} onManage={onManage} location={demoLocation} onCard={id=>{if(id===c?.id)setDetails(true);else{pendingNavigation.current={cardId:id,details:true};setCard(id);}}} onDiscuss={(id,field)=>{const target=p.cards.find(card=>card.id===id);if(!target)return;const message=`关于「${target.title}」${field?'的'+FIELDS.find(([key])=>key===field)?.[1]:''}，我想补充：`;if(id===c?.id)draft(message);else{pendingNavigation.current={cardId:id,text:message};setCard(id);}setExpanded(false);setMobile('chat');}}/>;
 return <div className={`co-workspace ${collapsed?'pool-collapsed':''} ${mobilePool?'mobile-pool-open':''}`} ref={workspace} style={{'--chat-ratio':`${ratio}fr`,'--preview-ratio':`${100-ratio}fr`} as CSSProperties} data-mobile={mobile}>
  {mobilePool&&<button type="button" className="co-pool-backdrop" aria-label="关闭需求列表" tabIndex={-1} onClick={()=>setMobilePool(false)}/>}
  <RequirementPool mobileOpen={mobilePool} key={p.id} project={p} role={role} participantId={participantId} busy={busy} jobs={jobs} modelConfigured={modelConfigured} mutate={mutate} organize={organize} selectedId={c?.id} select={id=>{setCard(id);setMobilePool(false);}} collapsed={collapsed} toggle={()=>{if(window.matchMedia('(max-width:650px)').matches)setMobilePool(false);else setCollapsed(!collapsed);}} goMaterials={()=>goMaterials()}/>
  <section className="co-chat">
   <header className="co-chat-header">
    <div>
     <div className="co-chat-eyebrow">沟通群 {c?.granularity==='概要'?<><ChevronRight size={11}/>整体范围</>:c&&poolGroupingMode(p)==='modules'&&isNamedModule(cardOrganization.module)?<><ChevronRight size={11}/>{cardOrganization.module}</>:null}</div>
     <h1 tabIndex={-1}>{c?.title||'一起把需求说清楚'}</h1>
     {c&&progress&&<div className="co-chat-card-actions">
      <button type="button" className="co-chat-progress" aria-haspopup="dialog" title={progress.step} data-pending={progress.pending} onClick={()=>setDetails(true)}>
       <ListChecks size={13} aria-hidden="true"/>待明确事项
      </button>
      <PriorityBadge value={cardOrganization.priority} title={cardOrganization.reason} disabled={busy}
       onAdjust={role==='pm'?()=>{
        setOrganization({...cardOrganization});
        setOrganizationStamp(p.stamp);
        setOrganizing(true);
       }:undefined}/>
     </div>}
    </div>
    <div className="co-avatars">{PARTICIPANTS.map(person=><i key={person.id} title={`${person.name} · ${person.title}`} aria-label={`${person.name} · ${person.title}`}>{person.initial}</i>)}<i title="需求助手" aria-label="需求助手"><Sparkles size={14} aria-hidden="true"/></i></div>
   </header>
   <div className="co-mobile-switch"><button type="button" className="co-mobile-pool-toggle" ref={mobilePoolToggle} aria-expanded={mobilePool} aria-controls={`requirement-pool-${p.id}`} onClick={()=>{setCollapsed(false);setMobilePool(true);}}><PanelLeftOpen size={16}/>需求</button><button className={mobile==='chat'?'active':''} onClick={()=>setMobile('chat')}>沟通</button><button className={mobile==='preview'?'active':''} onClick={()=>setMobile('preview')}>原型预览</button></div>
  {waiting&&<div className="co-waiting" role="status"><span><strong>{waitingLabel(c!,role,participantId)}</strong> · {waiting.question}</span>{isQuestionRecipient(waiting,role,participantId)&&<button onClick={()=>{setReplyTo(waiting.id);input.current?.focus();}}>我来补充</button>}</div>}
  <div className="co-messages" ref={stream}>{c?<><div className="co-topic-note"><span><MessageCircle size={13}/>围绕这项需求沟通</span><p>{c.fields.goal}</p>{c.granularity==='概要'&&<button onClick={()=>goMaterials(c.intakeDraftId)}>到材料箱继续细化 <ArrowRight size={12}/></button>}{!c.included&&<p>本期不纳入：{c.exclusionReason}</p>}</div><ConversationThread retryAssessment={assessmentId=>void resumeDiscussion(c.id,assessmentId)} assessmentBusy={running||!modelConfigured} scrollRef={stream} project={p} openDraft={goMaterials} openCard={setCard} card={c} role={role} participantId={participantId} busy={busy} onAnswer={(question,value)=>{setReplyTo(question.id);draft(value);}}/>{!c.messages.length&&<div className="co-quiet"><Sparkles size={21}/><h3>从一个具体问题开始</h3><p>说说业务场景、不确定的规则，或直接 @Agent。</p></div>}
  {running&&!c.assessments?.some(a=>a.jobId===latestJob?.id&&a.status==='running')&&<article className="co-message agent"><span className="co-avatar agent"><Sparkles size={17} aria-hidden="true"/></span><div className="co-message-content"><div className="co-message-meta"><strong>需求助手</strong><span>Agent</span></div><div className="co-agent-working"><LoaderCircle className="spin" size={15}/><span>{latestJob?.label||'正在分析本轮讨论'}<small>新卡和修改建议都由人核对，你可以继续发言。</small></span></div></div></article>}
  {latestJob?.status==='failed'&&!c.assessments?.some(a=>a.jobId===latestJob.id&&a.status==='failed')&&!running&&(!c.suggestion||latestJob.createdAt>c.suggestion.createdAt)&&<div className="co-inline-error"><p>{latestJob.error||'本轮分析未完成，请重试。'}</p><button disabled={!!policy('suggest')} title={policy('suggest')} onClick={()=>void (latestJob?.kind==='listen'?resumeDiscussion(c.id):startAgent())}>重新分析</button></div>}
  {s&&!running&&<article className="co-message agent"><span className="co-avatar agent"><Sparkles size={17} aria-hidden="true"/></span><div className="co-message-content"><div className="co-message-meta"><strong>需求助手</strong><span>Agent</span><time>{time(s.createdAt)}</time></div><div className="co-conclusion" id={`suggestion-${s.id}`} tabIndex={-1} data-reminder-anchor>
  <div className="co-conclusion-heading">
   <Sparkles size={14} aria-hidden="true"/>
   <strong>{s.origin==='example'?'参考结论':clarificationOnly?'待澄清事项':productProposal?'产品变更提案':presentation.actionable?'本轮建议':'本轮回应'}</strong>
   {presentation.actionable&&<span id={actionRecipientId} className="co-action-owner"><ActionMention role={productProposal?'business':'pm'}/> {productProposal?'待确认':clarificationOnly?'待跟进':'待采纳'}</span>}
  </div>
  <p className="co-conclusion-summary">{presentation.actionable||remainingIssues.length?summaryPreview(s.summary):s.summary}</p>
  {(presentation.actionable||remainingIssues.length>0)&&<details className="co-conclusion-details" key={`${c.id}:${s.id}`}><summary><ChevronRight size={12}/><span className="co-details-show">查看修改详情</span><span className="co-details-hide">收起修改详情</span><small>{[s.changes.length?`${s.changes.length} 项字段`:'',remainingIssues.length?`${remainingIssues.length} 项待核对`:''].filter(Boolean).join(' · ')}</small></summary><div className="co-conclusion-detail-body"><section className="co-conclusion-full-summary"><h3>完整总结</h3><p>{s.summary}</p></section>{s.changes.length>0&&<div className="co-changes">{s.changes.map(change=><div key={change.field}><span>{FIELDS.find(([key])=>key===change.field)?.[1]}</span><p>{change.after}</p></div>)}</div>}{remainingIssues.length>0&&<section className="co-conclusion-issues"><h3>待核对事项</h3><ul>{remainingIssues.map(issue=><li key={issue}>{issue}</li>)}</ul></section>}</div></details>}
  {(!!plan?.changedFields.length||resolved.length>0)&&(passed(c,'pm')||passed(c,'business')||p.phase!=='可讨论')?<p className="co-impact">采纳后，本卡已有确认失效，需要重新确认{p.phase!=='可讨论'?`；项目由“${p.phase}”回到“可讨论”`:''}。其他卡片的确认保留。</p>:null}
  {presentation.actionable&&<div className="co-conclusion-actions">
   <button className="primary" aria-describedby={actionRecipientId} disabled={!!policy(reviewOperation)} title={policy(reviewOperation)} onClick={()=>void adopt()}><Check size={14}/>{adoptionLabel}</button>
   {!productProposal&&!clarificationOnly&&<button aria-describedby={actionRecipientId} disabled={busy||role!=='pm'} title={role!=='pm'?'由产品经理调整；其他成员可直接在群里补充意见':''} onClick={()=>setAdjust(true)}><SlidersHorizontal size={13}/>调整</button>}
  </div>}</div></div></article>}
  {!s&&c.suggestion?.status==='已失效'&&!running&&<div className="co-inline-note">讨论已有补充，上一轮建议已失效。<button disabled={!!policy('suggest')} onClick={()=>void startAgent()}>按最新讨论更新原型</button></div>}
  {!s&&!running&&!waiting&&c.included&&c.granularity!=='概要'&&(confirmed||passed(c,'pm')||cardStatus(c)==='可确认')&&
   <div className={`co-confirmation ${confirmed?'complete':''}`} id={`confirmation-${c.id}`} tabIndex={-1} data-reminder-anchor>
    {confirmed?<><CheckCircle2 size={20}/><div><strong>这项需求已确认</strong><p>产品与业务已确认同一版结论，可以继续下一项需求。</p></div></>:passed(c,'pm')?<>
     <span className="co-avatar business" aria-hidden="true">{businessOwner.initial}</span>
     <div>
      <strong>产品已确认，等待业务核对</strong>
      <p id={actionRecipientId}><ActionMention role="business"/> 请结合右侧原型确认本轮业务规则。</p>
      <div className="co-confirm-actions">
       <button className="primary" aria-describedby={actionRecipientId} disabled={!!policy('businessConfirm')} title={policy('businessConfirm')} onClick={()=>void mutate({type:'businessConfirm',cardId:c.id,result:'通过',comment:'结合本轮结论与原型确认业务需求。'},p.stamp,'业务已确认本轮需求')}><CheckCheck size={14}/>确认本轮需求</button>
       <button aria-describedby={actionRecipientId} disabled={!!policy('businessReject')} title={policy('businessReject')} onClick={()=>{setReject(true);setReasonText('');}}>需要调整</button>
      </div>
     </div>
    </>:<>
     <CheckCircle2 size={19}/>
     <div>
      <strong>当前需求已具备确认条件</strong>
      <p id={actionRecipientId}><ActionMention role="pm"/> 请核对需求并发起业务确认。</p>
      <button className="primary" aria-describedby={actionRecipientId} disabled={!!policy('pmConfirm')} title={policy('pmConfirm')} onClick={()=>void mutate({type:'pmConfirm',cardId:c.id},p.stamp,'产品已确认，请业务负责人核对')}>发起业务确认 <ArrowRight size={13}/></button>
     </div>
    </>}
   </div>}
  {c&&<IdleClarification projectId={p.id} card={c} enabled={modelConfigured&&c.included&&c.granularity!=='概要'&&!confirmed&&!presentation.actionable&&!busy&&!details&&!adjust} typing={!!text.trim()||!!replyTo} waiting={!!waiting} running={running} onDiscuss={draft}/>}
  {confirmed&&next&&<button className="co-next" onClick={()=>setCard(next.id)}>下一项：{next.title}<ArrowRight size={14}/></button>}{!pending.length&&concreteCards(p).some(c=>c.included)&&<button className="co-next" onClick={onManage}>本期需求均已确认，查看 PRD 与整体评审<ArrowRight size={14}/></button>}
  </>:<div className="co-empty-state"><div className="co-empty-symbol"><MessageCircle size={26}/><Sparkles size={17}/></div><h2>从一项需求，开始共创</h2><p>上传资料，整理出需要沟通的需求。<br/>在群里讨论，核对原型，一起确认。</p><button className="primary" onClick={()=>goMaterials()}>前往材料箱<ArrowRight size={14}/></button></div>}</div>
  {c&&<ChatComposer files={files} setFiles={setFiles} clearDraft={clearDraft} modelPicker={modelPicker} assistantAvailable={modelConfigured} key={`${p.id}:${c.id}:${participantId}`} text={text} setText={setText} inputRef={input} hint={hint} disabledReason={policy('discuss')} attachmentReason={attachmentDisabledReason(p,c)} reply={replyTo?c.followUps?.find(q=>q.id===replyTo)?.question:undefined} clearReply={()=>setReplyTo('')} sendText={send} sendMaterials={async data=>{if(replyTo)data.set('replyTo',replyTo);return sendMaterials(c.id,data);}} quickActions={<><button type="button" disabled={!!policy('suggest')} title={policy('suggest')} onClick={()=>void startAgent()}><Sparkles size={13}/>{running?'正在分析':s?.changes.length?'更新原型':'整理讨论'}</button>{!s&&!passed(c,'pm')&&role==='pm'&&<button type="button" onClick={()=>draft('@Agent 请按大家已经明确的业务和产品意见更新需求与原型，联动检查权限、流程和验收，并整理可以解决的问题。')}>按讨论形成结论<ArrowRight size={11}/></button>}</>}/>}
  </section><div className="co-resizer" role="separator" aria-label="调整聊天与原型宽度" aria-orientation="vertical" aria-valuenow={ratio} tabIndex={0} onPointerDown={startResize} onKeyDown={e=>{if(e.key==='ArrowLeft'){e.preventDefault();setRatio(n=>Math.max(38,n-3));}if(e.key==='ArrowRight'){e.preventDefault();setRatio(n=>Math.min(68,n+3));}}}/><section className={`co-preview${expanded?' is-expanded':''}`}><WorkspaceModal title="效果预览" wide modal={expanded} onClose={()=>setExpanded(false)}><div className="co-preview-expanded">{preview}</div></WorkspaceModal></section>
  {organizing&&c&&<WorkspaceModal title="调整沟通安排" onClose={()=>setOrganizing(false)}><p className="co-dialog-lead">{c.title}</p><OrganizationFields value={organization} modules={organizationModules(p)} disabled={role!=='pm'||busy} onChange={setOrganization}/><p className="organization-footnote">只调整模块和沟通顺序，正文、已有确认和项目阶段保持。</p>{p.stamp!==organizationStamp&&<p className="error-text">项目已有更新，请关闭后重新打开。</p>}<div className="modal-actions"><button onClick={()=>setOrganizing(false)}>取消</button><button className="primary" disabled={role!=='pm'||busy||!organization.module.trim()||!organization.reason.trim()||p.stamp!==organizationStamp} onClick={async()=>{if(await mutate({type:'organizeCard',cardId:c.id,organization},organizationStamp,'沟通安排已更新，原有需求确认保留'))setOrganizing(false);}}>保存安排</button></div></WorkspaceModal>}
  {details&&c&&progress&&<RequirementDetails key={`${p.id}:${c.id}`} card={c} project={p} role={role} busy={busy}
   progress={progress} editDisabled={editDisabled} changeDisabled={policy('acceptChange')} mutate={mutate}
   onClose={()=>setDetails(false)} onLocate={field=>{setDetails(false);locateDemo(field);}}
   onDiscuss={anchor=>{setDetails(false);setExpanded(false);setMobile('chat');focusDiscussion(anchor);}}/>}
  {adjust&&c&&s&&presentation.actionable&&<WorkspaceModal title="调整本轮结论" wide onClose={cancelAdjust}><p className="co-dialog-lead">建议默认选中，只需调整不同意的部分。这里的修改将在采纳后生效。</p>{s.changes.map(change=><div className="co-adjust-row" key={change.field}><label><input type="checkbox" checked={decisions[change.field]==='采纳'} onChange={e=>setDecisions({...decisions,[change.field]:e.target.checked?'采纳':'不采纳'})}/>{FIELDS.find(([key])=>key===change.field)?.[1]}</label><textarea aria-label={`调整${FIELDS.find(([key])=>key===change.field)?.[1]}`} disabled={decisions[change.field]!=='采纳'} value={overrides[change.field]??change.after} maxLength={6000} onChange={e=>setOverrides({...overrides,[change.field]:e.target.value})}/><details><summary>原文与依据</summary><p>{change.before}</p>{change.evidence.map((ref,i)=><blockquote key={i}>{ref.quote}</blockquote>)}</details></div>)}<p className="co-impact">{keepOriginal?'本轮修改不采用，正式需求、已有确认和阶段保持。原型会按保留的需求重新同步。':'采纳后保存需求与 PRD；原型按最终采纳内容更新，生成期间保留上一版并标明状态。涉及本卡正文变更时，已有确认失效；依赖未采纳内容的问题会保留。'}</p><div className="modal-actions"><button onClick={cancelAdjust}>取消调整</button><button className="primary" disabled={!!policy('applySuggestion')||s.changes.some(change=>decisions[change.field]==='采纳'&&overrides[change.field]!==undefined&&!overrides[change.field]!.trim())} onClick={()=>void adopt()}>{adoptionLabel}</button></div></WorkspaceModal>}
  {reject&&c&&<WorkspaceModal title="告诉大家还需要调整什么" onClose={()=>setReject(false)}><textarea autoFocus aria-label="调整意见" value={reasonText} onChange={e=>setReasonText(e.target.value)} placeholder="例如：原负责人撤权后，通知摘要仍要能查看。" rows={5}/><p className="co-impact">提交后，本卡的当前确认失效，回到待沟通；项目回到可讨论，其他卡片的确认保留。</p><div className="modal-actions"><button onClick={()=>setReject(false)}>取消</button><button className="primary" disabled={!!policy('businessReject')||!reasonText.trim()} onClick={async()=>{if(await mutate({type:'businessConfirm',cardId:c.id,result:'要求修改',comment:reasonText},p.stamp,'意见已记录，本卡需要重新沟通'))setReject(false);}}>提交调整意见</button></div></WorkspaceModal>}
 </div>;
}
