import {getProject,getDiscussionView,mutateProject,listJobs,newJob,putJob,ConflictError} from './store.ts';
import {analyzeDiscussion,suggestChanges,SafeAIError} from './ai.ts';
import {attachDiscussion} from './discussion.ts';
import {attachSuggestion} from './domain.ts';
import {discussionBasis,discussionRequest,isRequirementUpdateRequest,latestHumanMessage,waitingQuestion} from '../shared/discussion.ts';
import {attachmentDisabledReason,pendingAttachmentMessages,conversationMaterials,attachmentWarnings} from '../shared/chat-attachments';
import {attachConversationRoute,routeConversation} from './chat-routing';
import {currentAgentTurn} from './discussion-context';
import {assessmentAdditions,classifyAssessmentInterruption,assessmentBasis,beginAssessment,finishAssessment,stopAssessment,evaluateRequirement,validateAssessment} from './requirement-assessment';
import type {Project,Card} from '../shared/types';
import type {Job} from '../shared/types.ts';

class AssessmentCancelled extends Error {}
const retryable=(card:Card,id:string)=>card.assessments?.find(assessment=>assessment.id===id&&['failed','superseded','cancelled'].includes(assessment.status));
const requestFor=(project:Project,card:Card,retry:boolean,sourceMessageId?:string)=>discussionRequest(project,card,retry)||
 (sourceMessageId&&!attachmentDisabledReason(project,card)?card.messages.find(message=>message.id===sourceMessageId&&message.role!=='agent'):undefined);

export function createDiscussionQueue({enabled,analyze=analyzeDiscussion,suggest=suggestChanges,route=routeConversation,evaluate=evaluateRequirement,classifyInterruption=classifyAssessmentInterruption,delayMs=1200,onSuggested=async()=>{}}:{onSuggested?:(projectId:string,cardId:string)=>Promise<unknown>;enabled:boolean;analyze?:typeof analyzeDiscussion;suggest?:typeof suggestChanges;route?:typeof routeConversation;evaluate?:typeof evaluateRequirement;classifyInterruption?:typeof classifyAssessmentInterruption;delayMs?:number}){
 let closed=false;
 const delay=()=>new Promise<void>(resolve=>setTimeout(resolve,delayMs));
 async function assess(job:Job,p:Project,c:Card,reason:string,sourceMessageId?:string){
  const basis=assessmentBasis(p,c),requestId=latestHumanMessage(c)!.id;
  await mutateProject(p.id,next=>{const card=next.cards.find(x=>x.id===c.id)!;const assessment=beginAssessment(next,card,job.id,reason,basis,requestId);if(!assessment)throw new ConflictError('讨论已有更新');if(sourceMessageId&&card.messages.some(m=>m.id===sourceMessageId&&m.role!=='agent'))assessment.sourceMessageId=sourceMessageId;});
  job.label='正在为您评估需求';await putJob(job);
  const result=validateAssessment(await evaluate(p,c,reason,async label=>{if(!closed){job.label=label;await putJob(job);}}),p,c);
  if(closed)throw new SafeAIError('服务已停止，本次评估可以按最新讨论重试。');
  // Recheck only newly arrived chat; keep the expensive assessment result when
  // the input has merely gained unrelated conversation. Recheck again if a
  // message arrived during classification, before taking the write lock.
  for(let check=0;check<8;check++){
   const latest=await getProject(p.id),current=latest.cards.find(x=>x.id===c.id)!;
   const turn=currentAgentTurn(latest,current,requestId),latestBasis=assessmentBasis(latest,turn);
   const turnId=latestHumanMessage(turn)!.id;
   if(latestBasis===basis)return {result,basis,turnId};
   const additions=assessmentAdditions(p,c,latest,turn);
   if(!additions)throw new ConflictError('需求依据已有更新');
   const decision=await classifyInterruption(p,c,reason,additions);
   const verified=await getProject(p.id),target=verified.cards.find(x=>x.id===c.id)!;
   if(assessmentBasis(verified,currentAgentTurn(verified,target,requestId))!==latestBasis)continue;
   if(decision==='related')throw new ConflictError('相关业务讨论已有更新');
   if(decision==='cancel'){
    await mutateProject(p.id,next=>{
     const card=next.cards.find(x=>x.id===c.id)!;
     if(assessmentBasis(next,currentAgentTurn(next,card,requestId))!==latestBasis)throw new ConflictError('讨论已有更新');
     stopAssessment(card,job.id,'cancelled');card.assistantCursor=turnId;
    });
    throw new AssessmentCancelled();
   }
   return {result,basis:latestBasis,turnId};
  }
  throw new SafeAIError('讨论持续更新，暂未能核对评估依据，请稍后重试。');
 }
 async function supersede(job:Job){
  await mutateProject(job.projectId,p=>{const c=p.cards.find(c=>c.id===job.cardId);if(c)stopAssessment(c,job.id,'superseded');});
  job.label='讨论已更新，正在结合补充信息重新判断';await putJob(job);
 }

 async function enqueue(projectId:string,cardId:string,force=false,resumeId?:string):Promise<Job|undefined>{
  if(!enabled||closed)return;
  const project=await getProject(projectId),card=project.cards.find(c=>c.id===cardId);
  if(!card)return;
  const assessment=resumeId?retryable(card,resumeId):undefined;
  if(resumeId&&!assessment)throw new Error('该评估不可重试。');
  const request=requestFor(project,card,force,assessment?.sourceMessageId);
  if(!request)return;
  const existing=(await listJobs(projectId)).find(j=>j.kind==='listen'&&j.cardId===cardId&&['queued','running'].includes(j.status));
  if(existing)return existing;
  let job:Job;
  try{job=await newJob(projectId,'listen',request.materialIds?.length?'正在读取附件':'正在处理 @Agent 请求',cardId);}catch(error){if(error instanceof ConflictError)return;throw error;}
  void process(job,force,resumeId).catch(()=>console.error('讨论任务状态保存失败，请检查本地数据库。'));
  return job;
 }
 async function process(job:Job,force=false,resumeId?:string){
  let attempted='';
  const progress=async(label:string)=>{if(!closed){job.label=label;await putJob(job);}};
  const parseDeadline=Date.now()+20*60*1000;
  try{
   await delay();
   if(closed)return;
   job.status='running';await putJob(job);
   // Coalesce new mentions and attachments while keeping ordinary chat out of the current request.
   for(let pass=0;pass<4&&!closed;pass++){
    while(!closed&&(await listJobs(job.projectId)).some(j=>j.kind==='suggest'&&j.cardId===job.cardId&&['queued','running'].includes(j.status)))await delay();
    if(closed)return;
    const p=await getProject(job.projectId),card=p.cards.find(c=>c.id===job.cardId);
    if(!card)break;
    const resume=pass===0&&resumeId?retryable(card,resumeId):undefined;
    const request=requestFor(p,card,force&&pass===0,resume?.sourceMessageId);
    if(!request)break;
    attempted=request.id;
    const c=currentAgentTurn(p,card,attempted);
    const basis=discussionBasis(p,c);
    const pending=pendingAttachmentMessages(c),attachmentIds=[...new Set(pending.flatMap(m=>m.materialIds||[]))];
    const attached=conversationMaterials(p,attachmentIds);
    if(attached.some(m=>m.status==='处理中')){
     if(Date.now()>parseDeadline)throw new SafeAIError('附件读取尚未完成，文件已保存；读取完成后可继续分析。');
     if(job.label!=='正在读取附件，完成后分析'){job.label='正在读取附件，完成后分析';await putJob(job);}
     await delay();pass--;continue;
    }
    // Reuse only real attachment routing. Legacy text-only @Agent replies used
    // the same metadata and must not swallow a forced lifecycle retry.
    const priorRoute=!resume&&c.messages.findLast(m=>m.materialReply?.contextMessageId===attempted&&!!m.materialReply.sourceMessageIds?.length)?.materialReply;
    let summarize=!resume&&isRequirementUpdateRequest(request.text)&&!waitingQuestion(c);
    // Text requests can answer or correct an existing question. Attachments use
    // the separate route that can also propose draft requirement cards.
    const needsRouting=!resume&&pending.length>0;
    if(priorRoute){
     summarize=priorRoute.clarifiesCurrent;
     if(!summarize)await mutateProject(p.id,next=>{const card=next.cards.find(x=>x.id===c.id)!;if(discussionBasis(next,currentAgentTurn(next,card,attempted))!==basis)throw new ConflictError('讨论已有更新');card.assistantCursor=attempted;});
    }else if(needsRouting){
     job.label='正在整理附件摘要';await putJob(job);
     const materials=attached.filter(m=>m.text.trim());
     const warnings=attachmentWarnings(attached);
     if(!materials.length)throw new SafeAIError(`未能从附件读到可用内容，请检查后重新上传。${warnings.slice(0,2).join('；')}`);
     const result=await route(p,c,materials,pending.map(m=>m.id),warnings);
     if(closed)return;
     if(result.handling?.mode==='deep'){
      try{
       const evaluated=await assess(job,p,c,result.handling.reason);
       const materialResult=await route(p,c,materials,pending.map(m=>m.id),warnings,true);
       const shouldSummarize=(materialResult.clarifiesCurrent||evaluated.result.discussion.summarize)&&!evaluated.result.discussion.question&&(!waitingQuestion(c)||!!evaluated.result.discussion.answer);
       if(closed)return;
       await mutateProject(p.id,next=>{
        const card=next.cards.find(x=>x.id===c.id)!;
        const turn=currentAgentTurn(next,card,evaluated.turnId);
        if(assessmentBasis(next,turn)!==evaluated.basis)throw new ConflictError('讨论已有更新');
        const routed={...materialResult,reply:evaluated.result.report.conclusion,clarifiesCurrent:shouldSummarize};
        if(!attachConversationRoute(next,c.id,routed,discussionBasis(next,turn),pending.map(m=>m.id),materials.map(m=>m.id),warnings,job.id,evaluated.turnId))throw new ConflictError('讨论已有更新');
        attachDiscussion(next,c.id,evaluated.result.discussion,discussionBasis(next,currentAgentTurn(next,card,evaluated.turnId)),evaluated.turnId);
        finishAssessment(card,job.id,evaluated.result);
       });
       attempted=evaluated.turnId;
       summarize=shouldSummarize;
      }catch(error){if(error instanceof ConflictError){await supersede(job);await delay();continue;}throw error;}
     }else{
     try{await mutateProject(p.id,next=>{
      if(!attachConversationRoute(next,c.id,result,basis,pending.map(m=>m.id),materials.map(m=>m.id),warnings,undefined,attempted))throw new ConflictError('讨论已有更新');
      if(result.question){const card=next.cards.find(x=>x.id===c.id)!;attachDiscussion(next,c.id,{answer:null,question:result.question,summarize:false},discussionBasis(next,currentAgentTurn(next,card,attempted)),attempted);}
      if(!result.clarifiesCurrent)next.cards.find(x=>x.id===c.id)!.assistantCursor=attempted;
     });}catch(error){if(error instanceof ConflictError){await delay();continue;}throw error;}
     summarize=result.clarifiesCurrent;
     }
    }else if(!summarize){
     const result=resume?{handling:{mode:'deep' as const,trigger:'explicit' as const,reason:resume.reason},answer:null,question:null,summarize:false}:await analyze(c,p.materials,progress);
     if(closed)return;
     if(result.handling?.mode==='deep'){
      try{
       const evaluated=await assess(job,p,c,result.handling.reason,resume?.sourceMessageId);
       await mutateProject(p.id,next=>{
        const card=next.cards.find(x=>x.id===c.id)!;
        const turn=currentAgentTurn(next,card,evaluated.turnId);
        if(assessmentBasis(next,turn)!==evaluated.basis)throw new ConflictError('讨论已有更新');
        attachDiscussion(next,c.id,evaluated.result.discussion,discussionBasis(next,turn),evaluated.turnId);
        finishAssessment(card,job.id,evaluated.result);
       });
       attempted=evaluated.turnId;
       summarize=evaluated.result.discussion.summarize&&!evaluated.result.discussion.question;
      }catch(error){if(error instanceof ConflictError){await supersede(job);await delay();continue;}throw error;}
     }else{
     const current=await getProject(p.id),target=current.cards.find(x=>x.id===c.id);
     if(!target||discussionBasis(current,currentAgentTurn(current,target,attempted))!==basis){await delay();continue;}
     try{await mutateProject(p.id,current=>{if(!attachDiscussion(current,c.id,result,basis,attempted))throw new ConflictError('讨论已有更新');});}
     catch(error){if(error instanceof ConflictError){await delay();continue;}throw error;}
     summarize=result.summarize&&!result.question;
     }
    }
    if(summarize){
     const current=await getProject(p.id),target=currentAgentTurn(current,current.cards.find(x=>x.id===c.id)!,attempted);
     if(latestHumanMessage(target)?.id!==attempted){await delay();continue;}
     const summaryBasis=discussionBasis(current,target);
     job.label='正在把讨论整理为原型草稿';await putJob(job);
     const suggestion=await suggest(target,current.materials,current.cards,progress);
     if(closed)return;
     try{await mutateProject(p.id,next=>{
      const card=next.cards.find(x=>x.id===c.id)!;
      if(discussionBasis(next,currentAgentTurn(next,card,attempted))!==summaryBasis)throw new ConflictError('讨论已有更新');
      attachSuggestion(next,card.id,suggestion,card.revision,card.messages.length,attempted);
      card.assistantCursor=attempted;
     });}catch(error){if(error instanceof ConflictError){await delay();continue;}throw error;}
     await onSuggested(p.id,c.id);
    }
    const after=await getProject(p.id),latest=after.cards.find(x=>x.id===c.id);
    const nextRequest=latest&&discussionRequest(after,latest);
    if(!nextRequest||nextRequest.id===attempted)break;
    await delay();
   }
   job.status='succeeded';job.label='已处理本轮请求';
  }catch(error){
   if(error instanceof AssessmentCancelled){job.status='succeeded';job.label='已取消需求评估';const p=await getProject(job.projectId);attempted=p.cards.find(c=>c.id===job.cardId)?.assistantCursor||attempted;return;}
   job.status='failed';
   // Validation diagnostics are for bounded model repair, never user-facing job text.
   console.warn('讨论任务未完成', {jobId:job.id,category:error instanceof Error?error.name:'UnknownError',...(error instanceof SafeAIError?{reason:error.message.slice(0,1000)}:{})});
   job.error=error instanceof SafeAIError&&error.code==='invalid_evidence'?'本轮建议的原文依据未核对通过，尚未改动需求。请补充相关业务原话后点击“整理讨论”重试。'
    :job.label.includes('附件')?'附件分析未完成，原文件已保留，可以重新分析。'
    :job.label.includes('评估')?'本次评估未能完成，原消息和材料已保留，请按最新讨论重试。'
    :'本轮回应或追问未能完成。讨论内容已保留，请按最新讨论重试。';
  }finally{
   if(closed){job.status='failed';job.error='服务已重启，可以继续讨论或重新整理。';}
   const assessmentProject=await getDiscussionView(job.projectId,job.cardId!);
   if(assessmentProject.cards[0]?.assessments?.some(a=>a.id===job.id&&a.status==='running'))await mutateProject(job.projectId,p=>{const c=p.cards.find(c=>c.id===job.cardId);if(c)stopAssessment(c,job.id,job.status==='failed'?'failed':'superseded',job.error);});
   job.finishedAt=new Date().toISOString();await putJob(job);
   if(!closed){const p=await getProject(job.projectId),c=p.cards.find(c=>c.id===job.cardId),next=c&&discussionRequest(p,c);if(next&&next.id!==attempted)await enqueue(p.id,c.id);}
  }
 }
 return {enqueue,resume:(projectId:string,cardId:string,assessmentId:string)=>enqueue(projectId,cardId,true,assessmentId),close:()=>{closed=true;}};
}
