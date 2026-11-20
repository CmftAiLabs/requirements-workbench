import type {Material,Project} from '../shared/types';
import {participantById,type ParticipantId} from '../shared/participants';
import {attachmentDisabledReason} from '../shared/chat-attachments';
import {applyAction} from './domain';

/** Must be called inside a project transaction. Retried uploads share one message. */
export function appendMaterialMessage(project:Project,cardId:string,participantId:ParticipantId,input:{text:string;replyTo?:string;clientMessageId:string},materials:Material[]){
 const card=project.cards.find(c=>c.id===cardId),person=participantById(participantId)!;
 if(!card)throw new Error('需求不存在');
 const duplicate=card.messages.find(m=>m.clientMessageId===input.clientMessageId);
 if(duplicate){
  if(duplicate.participantId!==participantId)throw new Error('这条材料消息属于其他参与人员。');
  return {message:duplicate,created:false};
 }
 const disabled=attachmentDisabledReason(project,card);
 if(disabled)throw new Error(disabled);
 if(!materials.length||materials.length>5)throw new Error('每次请添加1至5份材料。');
 applyAction(project,{type:'message',cardId,text:input.text.trim()||'补充了项目材料。',...(input.replyTo?{replyTo:input.replyTo}:{})},person.role,participantId);
 project.materials.push(...materials);
 const message=card.messages.at(-1)!;
 message.materialIds=materials.map(m=>m.id);message.clientMessageId=input.clientMessageId;
 for(const material of materials){
  material.sourceConversation={cardId,messageId:message.id,participantId};
  material.location=`沟通群 · ${card.title} · ${person.name}`;
 }
 return {message,created:true};
}
