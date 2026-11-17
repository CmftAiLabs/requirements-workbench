import type {Card,FollowUp,Message} from './types';
import {isQuestionRecipient} from './participants';
export const questionSourceId=(q:FollowUp)=>q.activeSourceMessageId||q.sourceMessageId;
export const questionOpenedAt=(q:FollowUp)=>q.activeSince||q.createdAt;
export function eligibleQuestionAnswer(card:Card,q:FollowUp,message:Message){
 if(message.role==='agent'||message.kind==='change'||!isQuestionRecipient(q,message.role,message.participantId))return false;
 const source=card.messages.findIndex(m=>m.id===questionSourceId(q));
 return source>=0&&card.messages.findIndex(m=>m.id===message.id)>source&&Date.parse(message.createdAt)>=Date.parse(questionOpenedAt(q));
}
export function isWithdrawalIntent(text:string){
 const intent='撤回|收回|改为|改成|改(?:变)?主意|重新考虑|(?:刚才|之前|此前).{0,20}(?:说错|不算|作废)|取消.{0,12}(?:决定|答复)';
 return new RegExp(intent).test(text)&&!/[?？]/.test(text)&&!new RegExp(`(?:不要|无需|不必|别|不)(?:再)?(?:${intent})|(?:如果|假如|能否|能不能|是否|要不要).{0,12}(?:${intent})`).test(text);
}
export function withdrawalCandidates(card:Card){
 const message=card.messages.filter(m=>m.role!=='agent').at(-1);
 if(!message||message.role==='agent'||message.kind==='change'||!isWithdrawalIntent(message.text))return [];
 const role=message.role;
 return (card.followUps||[]).filter(q=>q.status==='answered'&&(!message.replyTo||message.replyTo===q.id)&&isQuestionRecipient(q,role,message.participantId)&&q.answerMessageId&&card.messages.findIndex(m=>m.id===message.id)>card.messages.findIndex(m=>m.id===q.answerMessageId));
}
export const isWithdrawnAnswer=(card:Card,messageId:string)=>!!card.followUps?.some(q=>q.answerHistory?.some(a=>a.messageId===messageId));
