import type {ParticipantId} from '../shared/participants';
import {randomUUID} from 'node:crypto';
import type {Action,ModuleGroupingSuggestion,Project,Role} from '../shared/types';
import {concreteChats,groupingBasis,isNamedModule,namedModules,organizationModules,organizationOf} from '../shared/card-organization';
import {moduleGroupingSchema,moduleNameSchema} from './organization-schema';

export function validateModuleGrouping(raw:unknown,project:Project):ModuleGroupingSuggestion{
 const result=moduleGroupingSchema.parse(raw),cards=concreteChats(project);
 if(result.mode==='flat'){
  if(result.groups.length)throw new Error('不分组方案的 groups 必须为空。');
  return result;
 }
 if(result.groups.filter(g=>isNamedModule(g.name)).length<2)throw new Error('没有两个可区分的业务模块时，应使用不分组方案。');
 const names=result.groups.map(g=>g.name.toLocaleLowerCase());
 if(new Set(names).size!==names.length)throw new Error('模块名称不能重复。');
 const ids=result.groups.flatMap(g=>g.cardIds);
 if(new Set(ids).size!==ids.length)throw new Error('同一需求不能重复归类。');
 if(ids.length!==cards.length||ids.some(id=>!cards.some(c=>c.id===id)))throw new Error('归类必须恰好覆盖全部具体需求，不得遗漏、新增或包含概要卡。');
 return result;
}

/** These actions only organize existing chats; they never call content/approval invalidation. */
export function applyPoolAction(project:Project,action:Action,role:Role,participantId?:ParticipantId):boolean{
 if(action.type==='pinChat'){
  const card=project.cards.find(c=>c.id===action.cardId);
  if(!card||card.granularity==='概要')throw new Error('只能置顶已有的具体需求聊天。');
  const pins=(project.chatPins?.[participantId||role]||[]).filter(id=>id!==card.id);
  project.chatPins={...project.chatPins,[participantId||role]:action.pinned?[card.id,...pins]:pins};
  return true;
 }
 if(!['setPoolGrouping','renameModule','applyModuleGrouping'].includes(action.type))return false;
 if(role!=='pm')throw new Error('仅产品经理可调整项目模块分类。');
 const record=(detail:string)=>project.events.push({id:randomUUID(),action:'调整聊天分类',role,detail,createdAt:new Date().toISOString()});
 if(action.type==='setPoolGrouping'){
  if(action.mode==='modules'&&namedModules(project).length<2)throw new Error('当前没有可区分的多个模块，可先使用自动归类。');
  if(project.poolGrouping!==action.mode){project.poolGrouping=action.mode;record(action.mode==='flat'?'切换为不分组；模块信息和需求确认保留。':'按已有模块分组；需求内容和确认保留。');}
  return true;
 }
 if(action.type==='renameModule'){
  const from=moduleNameSchema.parse(action.from),to=moduleNameSchema.parse(action.to);
  if(!isNamedModule(to))throw new Error('请使用具体的业务模块名称；平铺查看可选择“不分组”。');
  if(!concreteChats(project).some(c=>organizationOf(c).module===from))throw new Error('原模块已不存在，请刷新后重试。');
  if(from===to)return true;
  if(organizationModules(project).some(name=>name!==from&&name.toLocaleLowerCase()===to.toLocaleLowerCase()))throw new Error('已有同名模块，请使用其他名称。');
  const modules=organizationModules(project);
  for(const card of concreteChats(project))if(organizationOf(card).module===from)card.organization={...organizationOf(card),module:to};
  for(const batch of project.intakeBatches||[]){
   let changed=false;
   for(const draft of batch.drafts)if(!draft.poolCardId&&!draft.relatedCardId&&draft.granularity!=='概要'&&organizationOf(draft).module===from){draft.organization={...organizationOf(draft),module:to};changed=true;}
   if(changed)batch.revision++;
  }
  project.moduleOrder=[...new Set(modules.map(name=>name===from?to:name))];
  record(`模块“${from}”重命名为“${to}”；正式需求和未入池候选同步，正文、确认和版本保留。`);
  return true;
 }
 if(action.type==='applyModuleGrouping'){
  const proposal=project.moduleProposal;
  if(!proposal||proposal.id!==action.proposalId)throw new Error('归类方案已不存在，请重新分析。');
  if(proposal.base!==groupingBasis(project))throw new Error('需求或模块已有变化，请重新分析后应用。');
  const result=validateModuleGrouping({mode:proposal.mode,summary:proposal.summary,groups:proposal.groups},project);
  if(result.mode==='modules'){
   for(const group of result.groups)for(const id of group.cardIds){const card=project.cards.find(c=>c.id===id)!;card.organization={...organizationOf(card),module:group.name};}
   project.moduleOrder=result.groups.map(g=>g.name);
  }
  project.poolGrouping=result.mode;
  delete project.moduleProposal;
  record(`产品采用 Agent 归类方案：${result.mode==='flat'?'不分组':result.groups.map(g=>g.name).join('、')}。仅调整聊天分类，正文、确认和版本保留。`);
  return true;
 }
 return false;
}
