import type {ParticipantId} from './participants';
import {cardStatus,type Card,type CardOrganization,type Project,type Role} from './types';
import {outlineGaps} from './intake-policy';
import {unansweredQuestion} from './discussion';
import {isNoopSuggestion} from './conclusion-presentation';

export const DEFAULT_ORGANIZATION:CardOrganization={module:'未分组',priority:'正常沟通',reason:'尚未给出沟通顺序建议，可结合影响范围调整。'};
export const organizationOf=(card:{organization?:CardOrganization}):CardOrganization=>card.organization||DEFAULT_ORGANIZATION;
export const priorityTone=(priority:CardOrganization['priority'])=>priority==='优先沟通'?'first':priority==='后续沟通'?'later':'normal';
export const hasPendingChange=(card:Card)=>card.messages.some(m=>m.kind==='change'&&!m.accepted);
export const hasUnreviewedSuggestion=(card:Card)=>!!card.suggestion&&!isNoopSuggestion(card.suggestion)&&card.suggestion.status!=='已写入';
export function needsAttention(project:Project,card:Card){
 if(!card.included)return false;
 if(hasPendingChange(card)||hasUnreviewedSuggestion(card)||unansweredQuestion(card))return true;
 if(card.granularity==='概要')return outlineGaps(project).some(g=>g.cardId===card.id);
 return cardStatus(card)!=='已确认';
}
export function organizationModules(project:Project){
 return [...new Set([...(project.moduleOrder||[]),...[...project.cards,...(project.intakeBatches||[]).flatMap(b=>b.drafts)].filter(c=>c.granularity!=='概要').map(c=>organizationOf(c).module)])];
}
export const concreteChats=(project:Project)=>project.cards.filter(c=>c.granularity!=='概要');
export const isNamedModule=(name:string)=>!['未分组','未分类','未归类','其他','全部','默认','项目范围'].includes(name.trim());
export function namedModules(project:Project){return organizationModules(project).filter(name=>isNamedModule(name)&&concreteChats(project).some(c=>organizationOf(c).module===name));}
export function poolGroupingMode(project:Project){return project.poolGrouping==='flat'?'flat':namedModules(project).length>=2?'modules':'flat';}
export function groupingBasis(project:Project){return JSON.stringify(concreteChats(project).map(c=>({id:c.id,title:c.title,revision:c.revision,included:c.included,module:organizationOf(c).module})).sort((a,b)=>a.id.localeCompare(b.id)));}
export function pinnedChats(project:Project,role:Role|ParticipantId){const cards=concreteChats(project);return (project.chatPins?.[role]||[]).map(id=>cards.find(c=>c.id===id)).filter((c):c is Card=>!!c);}
export function initialCommunicationCard(project:Project,role:Role|ParticipantId='pm'){
 const cards=concreteChats(project),pending=cards.filter(c=>needsAttention(project,c));
 return pinnedChats(project,role).find(c=>needsAttention(project,c))||pending[0]||cards.find(c=>c.included)||cards[0];
}
export function poolView(project:Project,mode:'pending'|'all',query='',selectedId?:string,role:Role|ParticipantId='pm'){
 const q=query.trim().toLocaleLowerCase();
 const matches=(card:Card)=>!q||[card.title,card.id,organizationOf(card).module,...Object.values(card.fields),...card.messages.map(m=>m.text)].join(' ').toLocaleLowerCase().includes(q);
 const all=concreteChats(project),pending=all.filter(c=>needsAttention(project,c));
 const pinned=pinnedChats(project,role).filter(matches),pinIds=new Set(pinned.map(c=>c.id));
 const visible=all.filter(c=>matches(c)&&(q||mode==='all'||needsAttention(project,c)||c.id===selectedId));
 const regular=visible.filter(c=>!pinIds.has(c.id)),grouping=poolGroupingMode(project);
 const groups=organizationModules(project).map(name=>{
  const cards=regular.filter(c=>c.included&&organizationOf(c).module===name);
  return {name,cards,pending:cards.filter(c=>needsAttention(project,c)).length};
 }).filter(g=>g.cards.length&&isNamedModule(g.name));
 return {all,pending,visible,pinned,regular,groups,grouping,loose:regular.filter(c=>c.included&&(grouping==='flat'||!isNamedModule(organizationOf(c).module))),outside:regular.filter(c=>!c.included),searching:!!q};
}
