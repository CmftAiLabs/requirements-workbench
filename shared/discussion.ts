import {isBusinessOwner,isQuestionRecipient,personFor,type ParticipantId} from './participants';
import {cardStatus,type Card,type Message,type Project,type Role} from './types.ts';
import {readInterfaceTitleChange} from './interface-title';
import {mentionsAgent} from './agent-mention';

export const roleNames:Record<Role,string>={pm:'产品经理',business:'业务负责人',reviewer:'历史参与者'};
export const latestHumanMessage=(card:Card)=>card.messages.filter(m=>m.role!=='agent').at(-1);
export const waitingQuestion=(card:Card)=>card.included&&card.granularity!=='概要'?card.followUps?.find(q=>q.status==='waiting'&&q.role!=='reviewer'&&q.baseRevision===card.revision):undefined;
export const unansweredQuestion=(card:Card)=>waitingQuestion(card)||(card.included&&card.granularity!=='概要'?card.followUps?.find(q=>q.status==='deferred'&&q.baseRevision===card.revision):undefined);
export function isRequirementUpdateRequest(text:string){
 if(readInterfaceTitleChange(text))return true;
 // Treat a negated instruction as a question/reply, not a request to make a draft.
 // Separate clauses keep “不要改需求，但请更新原型” actionable for the latter clause.
 return text.split(/[，,。；;！!？?\n]|但是|不过|但/).some(clause=>{
  if(/(?:不要|不必|不需要|无需|勿|别|暂不|先不|不(?:用|能|可|允许)?)\s*(?:(?:自动|直接|立即|继续|再)\s*)?(?:更新|修改|生成|整理|总结)/.test(clause))return false;
  return /(?:更新|修改|生成|整理|总结).*(?:原型|需求|字段|结论|修改建议)|(?:按|根据).*(?:讨论|口径).*(?:整理|更新|修改)/i.test(clause);
 });
}
export function discussionRequest(project:Project,card:Card,retry=false):Message|undefined{
 if(card.granularity==='概要'||!card.included||project.deliveries.some(d=>!d.completedAt))return;
 const cursor=retry?-1:card.messages.findIndex(message=>message.id===card.assistantCursor);
 const approvedAt=Object.values(card.approvals).map(approval=>approval.createdAt).sort().at(-1);
 return card.messages.findLast((message,index)=>index>cursor&&message.role!=='agent'&&
  (message.kind!=='change'||message.accepted)&&(!approvedAt||message.createdAt>=approvedAt)&&
  (Boolean(message.materialIds?.length)||mentionsAgent(message.text)));
}
// Changes to people’s decisions while a model is running invalidate its result too.
export function discussionBasis(project:Project,card:Card){
 return JSON.stringify([card.title,card.revision,card.round,card.included,card.fields,card.messages,card.blockers,card.approvals,card.followUps,card.suggestion?.id,project.deliveries.map(d=>[d.id,d.completedAt])]);
}
export function waitingLabel(card:Card,role?:Role,participantId?:ParticipantId){
 const q=waitingQuestion(card);
 if(q){const pending=role&&isQuestionRecipient(q,role,participantId)?'等你补充':`等${personFor(q.role,q.participantId).name}回复`;return cardStatus(card)==='已确认'?`已确认 · ${pending}`:pending;}
 if(cardStatus(card)!=='已确认'&&card.approvals.pm?.revision===card.revision&&card.approvals.pm?.round===card.round&&card.approvals.pm?.result==='通过')return role&&isBusinessOwner(role,participantId)?'等你确认':'等业务确认';
 return '';
}
