import {eligibleQuestionAnswer,withdrawalCandidates} from '../shared/question-lifecycle';
import {matchQuestionOption,matchQuestionText} from '../shared/question-answer';
import {questionPurposes} from './question-routing';
import {SafeAIError} from './ai-error';
import {participantById,defaultParticipantId,isQuestionRecipient} from '../shared/participants';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {FIELDS,type Card,type Project,type DiscussionAnalysis} from '../shared/types.ts';
import {discussionBasis,isRequirementUpdateRequest,latestHumanMessage,waitingQuestion} from '../shared/discussion.ts';
import {handlingSchema} from './expert-policy';

export const discussionSchema=z.object({
 reopenQuestion:z.object({questionId:z.string(),messageId:z.string(),quote:z.string().trim().min(1).max(1500)}).strict().nullable().optional(),
 deferQuestion:z.object({questionId:z.string(),sourceMessageId:z.string(),reason:z.string().trim().min(6).max(300)}).strict().nullable().optional(),
 replyRequest:z.object({participantId:z.enum(['pm','business','business-sales','business-operations']),purpose:z.enum(questionPurposes)}).strict().nullable().optional(),
 handling:handlingSchema.optional(),
 reply:z.string().trim().max(1200).optional(),
 answer:z.object({questionId:z.string(),messageId:z.string(),quote:z.string().trim().min(1).max(1500)}).strict().nullable(),
 question:z.object({field:z.enum(FIELDS.map(([key])=>key) as [typeof FIELDS[number][0],...typeof FIELDS[number][0][]]),question:z.string().trim().min(6).max(300),options:z.array(z.string().trim().min(2).max(100)).min(2).max(4),role:z.enum(['pm','business']),participantId:z.enum(['pm','business','business-sales','business-operations']).optional()}).strict().nullable(),
 summarize:z.boolean(),
}).strict();
const normalize=(s:string)=>s.normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu,'');

export function validateDiscussion(raw:unknown,card:Card):DiscussionAnalysis{
 const parsed=discussionSchema.safeParse(raw);
 if(!parsed.success){
  const paths=parsed.error.issues.slice(0,5).map(i=>i.path.join('.')||'根对象');
  const error=new SafeAIError(`讨论回复结构不符合要求：${paths.join('、')}。`);
  error.shapeIssues=parsed.error.issues.map(i=>({path:i.path.map(String),message:i.message}));throw error;
 }
 const result=parsed.data,pending=waitingQuestion(card),matched=matchQuestionOption(card);
 let reopening:NonNullable<Card['followUps']>[number]|undefined;
 if(result.reopenQuestion){
  const operation=result.reopenQuestion,last=latestHumanMessage(card);
  reopening=withdrawalCandidates(card).find(q=>q.id===operation.questionId);
  if(!reopening||!last||operation.messageId!==last.id||!last.text.includes(operation.quote)||result.deferQuestion)throw new SafeAIError('撤回必须引用原答复人最新明确撤回或更正的发言；其他人的异议不能撤回该决定。');
  const correction=last.text.split(/改为|改成/).at(-1);
  if(correction!==last.text&&correction&&matchQuestionText(reopening,correction)){
   if(result.answer&&(result.answer.questionId!==reopening.id||result.answer.messageId!==last.id))throw new SafeAIError('同一句已明确更正原问题答案，请登记原问题和最新更正消息。');
   result.answer={questionId:reopening.id,messageId:last.id,quote:last.text};
   if(!result.summarize)result.reply=`已更正为：${matchQuestionText(reopening,correction)}。原答复保留作历史记录。`;
  }
  if(result.handling?.mode==='quiet')result.handling={mode:'direct',trigger:'none',reason:''};
  if(result.question&&!result.answer)throw new SafeAIError('撤回后系统会重新开启原追问；请保留reopenQuestion，question设为null，不另建重复问题。');
  if(!result.reply)result.reply='已记录撤回此前答复，原记录保留；已写入的需求仍需审核修改。';
 }
 if(matched){
  if(result.answer&&(result.answer.questionId!==matched.question.id||result.answer.messageId!==matched.message.id))throw new SafeAIError('当前被询问人已明确选择原问题选项，请记录该条真实答复，不要改记其他问题或历史发言。');
  if(result.deferQuestion)throw new SafeAIError('当前发言已明确回答原问题，不能当作转题暂缓。');
  result.answer={questionId:matched.question.id,messageId:matched.message.id,quote:matched.message.text};
  if(result.handling?.mode==='quiet'){result.handling={mode:'direct',trigger:'none',reason:''};result.question=null;result.replyRequest=null;}
  if(!result.reply&&!result.question&&!result.summarize)result.reply=`已记录：${matched.option}。`;
 }

 if(result.handling?.mode==='deep'||result.handling?.mode==='quiet'){
  result.reply='';result.question=null;result.replyRequest=null;result.deferQuestion=null;result.summarize=false;
 }
 if(result.answer){
  const answer=result.answer,message=card.messages.find(m=>m.id===answer.messageId),target=card.followUps?.find(q=>q.id===answer.questionId&&(['waiting','deferred'].includes(q.status)&&q.baseRevision===card.revision||q.id===reopening?.id));
  if(!target||!message||target.status==='deferred'&&message.replyTo!==target.id||!message.text.includes(answer.quote)||(target.id===reopening?.id?message.id!==result.reopenQuestion!.messageId:!eligibleQuestionAnswer(card,target,message)))throw new SafeAIError('回答必须来自被询问人员在问题之后的真实发言。');
  const latestEligible=card.messages.filter(m=>eligibleQuestionAnswer(card,target!,m)).at(-1);
  if(target.id!==reopening?.id&&latestEligible?.id!==message.id)throw new SafeAIError('同一回答人已有更新的发言，请结合最新意见判断，不能用旧回答覆盖后续更正。');
  if(/^(?:不知道|不清楚|待确认|暂不确定|还没确定|(?:暂时|暂|还)?没想好|再看看|再想想)[。！!\s]*$/.test(message.text.replace(/^\s*@\s*(?:agent|需求助手|需求伙伴|助手)\s*/i,'').trim()))result.answer=null;
 }
 // A topic switch must be explicit and tied to the latest human message.
 if(result.deferQuestion){
  const change=result.deferQuestion,last=latestHumanMessage(card);
  if(!pending||change.questionId!==pending.id||!last||change.sourceMessageId!==last.id||last.replyTo||last.kind==='change'||result.answer||!result.question||!result.replyRequest||normalize(result.question.question)===normalize(pending.question))throw new SafeAIError('暂缓旧问题必须依据最新的非答复业务发言，并提供不同的新话题正式追问；不能把原问题当作已回答。');
 }
 if(pending&&result.answer?.questionId!==pending.id&&!result.deferQuestion&&!reopening){
  if(result.replyRequest&&(result.replyRequest.participantId!==(pending.participantId||defaultParticipantId(pending.role))||result.question&&normalize(result.question.question)!==normalize(pending.question)))throw new SafeAIError(`当前仍等待问题 ${pending.id} 的回答。若最新发言确实转向新的业务话题，请用 deferQuestion 指明该旧问题、最新消息 sourceMessageId 和转题原因，并保留对象一致的新 question/replyRequest；否则继续等待，不要要求其他人回答。`);
  result.question=null;result.summarize=false;
 }

 if(result.question){
  const person=participantById(result.question.participantId||defaultParticipantId(result.question.role));
  if(!person||person.role!==result.question.role)throw new SafeAIError('追问对象必须是当前沟通群内角色匹配的人员。');
  result.question.participantId=person.id;
  if(new Set(result.question.options.map(normalize)).size!==result.question.options.length)throw new SafeAIError('追问选项不能重复。');
  if(card.followUps?.some(q=>q.baseRevision===card.revision&&q.status!=='superseded'&&q.status!=='deferred'&&normalize(q.question)===normalize(result.question!.question)&&(q.participantId||defaultParticipantId(q.role))===result.question!.participantId))result.question=null;
 }
 if(result.deferQuestion&&!result.question)throw new SafeAIError('新追问重复或无效，不能暂缓旧问题。');
 const recipient=result.question?.participantId||(reopening&&!result.answer?reopening.participantId||defaultParticipantId(reopening.role):undefined)||(pending&&result.answer?.questionId!==pending.id?pending.participantId||defaultParticipantId(pending.role):undefined);
 if(result.replyRequest){
  const request=result.replyRequest;
  if(recipient!==request.participantId)throw new SafeAIError('需要真人回答时必须生成对象一致的正式追问，不能只在文字中点名。');
  if(['scope','design_choice'].includes(request.purpose)&&recipient!=='pm')throw new SafeAIError('本期范围与设计方案取舍应正式询问产品经理。');
  if(['usage','business_rule','design_feedback'].includes(request.purpose)&&recipient==='pm')throw new SafeAIError('使用场景、业务规则和设计使用反馈应询问相关业务人员，不能默认交给产品经理。');
  if(request.purpose==='business_conflict'&&recipient!=='business')throw new SafeAIError('业务规则分歧应正式询问业务负责人陈敏。');
 }
 // Catch the concrete failure even if the model omits replyRequest.
 for(const [id,label] of [['pm','(?:产品经理(?:林舟)?|林舟)'],['business','(?:业务负责人(?:陈敏)?|陈敏)'],['business-sales','李雯'],['business-operations','赵凯']] as const){
  const handoff=new RegExp(`(?:请|需要|需|等待|待|由)\\s*${label}[^，。；\\n]{0,18}(?:决定|确认|明确|回复|回答|补充|选择|统一)`);
  const clauses=(result.reply||'').split(/[，。；\n]/).filter(t=>!/(?:无需|不需要|不必|不用|不再|已经|此前|已明确|已确认)/.test(t));
  if(clauses.some(t=>handoff.test(t))&&recipient!==id)throw new SafeAIError('回复要求某人决定或补充时，必须生成给该人的正式追问，不能只在文字里点名。');
 }
 const direct=result.handling?.mode!=='deep'&&result.handling?.mode!=='quiet';
 const canSummarize=direct&&!result.question&&!result.reopenQuestion&&(!pending||result.answer?.questionId===pending.id);
 // A draft promise must produce the real, reviewable action. Never treat this
 // routing decision as adoption or let it bypass an unanswered question.
 const promisesDraft=/(?:已(?:整理|生成|形成)|(?:以下|下面|本轮|可采纳).{0,12})(?:.{0,24})(?:字段修改|修改建议|需求草稿|字段草稿)/u.test(result.reply||'');
 if(canSummarize&&(isRequirementUpdateRequest(latestHumanMessage(card)?.text||'')||promisesDraft))result.summarize=true;
 if(result.question)result.summarize=false;
 return result;
}

/** Only conversation metadata changes here: never fields, blockers or approvals. */
export function attachDiscussion(project:Project,cardId:string,raw:DiscussionAnalysis,basis:string){
 const card=project.cards.find(c=>c.id===cardId);
 if(!card||discussionBasis(project,card)!==basis)return false;
 const result=validateDiscussion(raw,card),last=latestHumanMessage(card);
 if(!last)return false;
 if(result.reopenQuestion){
  const q=card.followUps!.find(q=>q.id===result.reopenQuestion!.questionId)!,at=new Date().toISOString();
  (q.answerHistory||=[]).push({messageId:q.answerMessageId!,answeredAt:q.answeredAt,withdrawnByMessageId:result.reopenQuestion.messageId,withdrawnAt:at});
  delete q.answerMessageId;delete q.answeredAt;q.baseRevision=card.revision;q.activeSourceMessageId=last.id;q.activeSince=at;q.status='waiting';
  for(const other of card.followUps||[])if(result.answer?.questionId!==q.id&&other.id!==q.id&&other.status==='waiting')other.status='deferred';
  if(card.suggestion?.status==='待决定')card.suggestion.status='已失效';
 }
 if(result.deferQuestion)waitingQuestion(card)!.status='deferred';
 if(result.answer){const q=card.followUps!.find(q=>q.id===result.answer!.questionId)!;q.status='answered';q.answerMessageId=result.answer.messageId;q.answeredAt=new Date().toISOString();}
 for(const q of card.followUps||[])if(q.status==='waiting'&&q.baseRevision!==card.revision)q.status='superseded';
 if(result.reply&&!result.summarize)card.messages.push({id:randomUUID(),role:'agent',text:result.reply,createdAt:new Date().toISOString()});
 if(result.question&&!waitingQuestion(card)){
  const deferred=card.followUps?.find(q=>q.status==='deferred'&&q.baseRevision===card.revision&&(q.participantId||defaultParticipantId(q.role))===result.question!.participantId&&normalize(q.question)===normalize(result.question!.question));
  if(deferred){deferred.status='waiting';deferred.activeSince=new Date().toISOString();deferred.activeSourceMessageId=last.id;}
  else (card.followUps||=[]).push({...result.question,id:randomUUID(),createdAt:new Date().toISOString(),baseRevision:card.revision,sourceMessageId:last.id,status:'waiting'});
 }
 card.assistantCursor=last.id;
 return true;
}
