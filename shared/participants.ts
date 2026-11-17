import type {Role} from './types';

// People have separate identities even when they share the same permissions.
export const PARTICIPANTS = [
 {id:'pm',role:'pm',name:'林舟',title:'产品经理',initial:'林',responsibility:'协调本期范围、需求取舍、功能与验收，采纳修改建议'},
 {id:'business',role:'business',name:'陈敏',title:'业务负责人',initial:'陈',responsibility:'统一业务口径、处理业务分歧，负责最终业务确认'},
 {id:'business-sales',role:'business',name:'李雯',title:'招商业务',initial:'李',responsibility:'企业参会、招商接洽、预约与联系方式交换'},
 {id:'business-operations',role:'business',name:'赵凯',title:'会务业务',initial:'赵',responsibility:'报名准入、议程安排、现场会务和异常处理'},
] as const;
export type ParticipantId = typeof PARTICIPANTS[number]['id'];
export type ActiveRole = 'pm'|'business';
export const participantById=(id?:string)=>PARTICIPANTS.find(person=>person.id===id);
export const defaultParticipantId=(role:Role):ParticipantId=>role==='pm'?'pm':'business';
export function personFor(role:Role|'agent',participantId?:string){
 if(role==='agent')return {id:'agent',role,name:'需求助手',title:'Agent',initial:'✦'};
 if(role==='reviewer')return {id:'legacy-reviewer',role,name:'周衡',title:'历史参与者',initial:'周'};
 const person=participantById(participantId);
 return person?.role===role?person:participantById(defaultParticipantId(role))!;
}
export const personLabel=(record:{role:Role|'agent';participantId?:string})=>{
 const person=personFor(record.role,record.participantId);return `${person.name} · ${person.title}`;
};
export const isBusinessOwner=(role:Role,participantId?:string)=>role==='business'&&(!participantId||participantId==='business');
export function isQuestionRecipient(question:{role:Role;participantId?:string},role:Role,participantId?:string){
 return question.role===role&&role!=='reviewer'&&
  (question.participantId||defaultParticipantId(question.role))===(participantId||defaultParticipantId(role));
}
