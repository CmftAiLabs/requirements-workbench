import {addExtractedCards,applyAction,attachSuggestion,createProject} from './domain.js';
import type {ExtractedCard,Fields,Project,Role} from '../shared/types.js';
export function createCRMExperience(){
 const p=createProject('CRM · 协作体验');p.example='crm';
 const transfer:Fields={goal:'人员调岗时保持客户责任清晰，客户资料安全可控。',scope:'本期仅同部门单个客户交接，不含批量、跨部门交接和批量导出。',flow:'销售主管在客户详情选择同部门在职接收人，填写交接原因并提交；接收人不能等于原负责人。',permission:'销售主管可转交本部门客户；交接成功后原负责人保留 30 天只读，不得编辑、导出或再次转交；新负责人立即获得编辑权限。',exception:'负责人和权限必须在同一事务更新；任何失败全部回滚，不产生成功通知；重复提交只执行一次。',data:'记录客户编号、原负责人、新负责人、操作主管、时间及必填交接原因，审计记录保存一年，仅销售主管和审计管理员可查。',constraint:'依赖现有员工目录、部门关系和 CRM 权限服务；本期不改组织结构。',quality:'50 个并发交接请求下，95% 在 3 秒内完成；负责人和权限不能出现中间不一致状态。',acceptance:'正常交接后新负责人可编辑，原负责人 30 天内只读且不可导出或再次转交；覆盖无权、跨部门、离职接收人、重复提交和失败回滚。'};
 const notification:Fields={goal:'客户交接完成后，原负责人和新负责人及时获知变化。',scope:'只做站内通知，不接短信、邮件和 IM。',flow:'交接成功后向原负责人和新负责人各发送一条站内通知。',permission:'仅收件人可读自己的通知；原负责人撤权后仍可看摘要，打开客户详情提示无权访问。',exception:'通知失败不回滚交接，后台重试三次；同一交接每个收件人只生成一条通知。',data:'通知只含客户名称、交接时间、操作人和详情入口，不含联系电话；记录交接编号、收件人、状态及重试次数，保留 90 天。',constraint:'只使用现有站内消息服务。',quality:'正常情况下交接成功后 10 秒内送达。',acceptance:'双方各收到一次，第三人不可查看，失败可重试且不重复发送，摘要不泄露敏感信息。'};
 const draft=(title:string,fields:Fields,issues:string[]=[]):ExtractedCard=>({title,fields,sourceIds:p.materials.map(m=>m.id),assessment:issues.length?'待澄清':'可确认',issues,evidence:{}});
 addExtractedCards(p,[draft('客户交接与权限',transfer,['原负责人保留 30 天只读还是立即撤权？访谈与制度冲突，需业务与评审共同明确。']),draft('交接后的站内通知',notification),draft('跨部门批量导出',{...transfer,goal:'批量获取跨部门客户联系电话。',scope:'跨部门批量导出全部客户联系电话。'})],p.materials.map(m=>m.id));
 const card=p.cards[0];card.blockers[0].field='permission';
 applyAction(p,{type:'message',cardId:card.id,text:'这张卡片有一个关键分歧：访谈提出保留 30 天只读，权限制度要求立即撤权。请业务和评审核对，本期到底采用哪种规则？'},'pm');
 applyAction(p,{type:'message',cardId:card.id,text:'业务口径已明确：本期交接成功后立即撤销原负责人读取、编辑、导出和再次转交的全部权限，不保留 30 天只读，也不设置临时例外。原负责人打开旧链接提示无权访问，新负责人能查看历史跟进并编辑。其他交接范围、必填原因、失败回滚规则保持。'},'business');
 applyAction(p,{type:'message',cardId:card.id,text:'评审意见：业务提出的立即撤权符合权限制度，本期没有临时保留访问例外。验收需覆盖原负责人旧链接不可访问、新负责人可编辑，以及失败时负责人和权限全部回滚。请同步更新权限和验收，之后再做整卡确认。'},'reviewer');
 applyAction(p,{type:'message',cardId:p.cards[1].id,text:'站内通知的范围、收件人、隐私、重试与送达时限已在访谈中明确，请直接核对当前规则。'},'pm');
 applyAction(p,{type:'scope',cardId:p.cards[2].id,included:false,reason:'超出本期单客户交接范围，且涉及跨部门敏感信息导出，留待另行立项评估。'},'pm');
 return p;
}

/** Opt-in example script. Clearly labelled, never presented as a live model result. */
export function applyCRMExampleConclusion(p:Project,cardId:string,role:Role){
 if(!['pm','business','reviewer'].includes(role))throw new Error('当前身份无法请求示例结论');
 const c=p.cards.find(c=>c.id===cardId);
 if(p.example!=='crm'||!c||c.title!=='客户交接与权限'||c.revision!==1)throw new Error('预置结论只适用于尚未修改的 CRM 体验卡片');
 const business=c.messages.find(m=>m.role==='business'&&m.text.includes('本期交接成功后立即撤销原负责人读取、编辑、导出和再次转交的全部权限'));
 const reviewer=c.messages.find(m=>m.role==='reviewer'&&m.text.includes('业务提出的立即撤权符合权限制度'));
 const blocker=c.blockers.find(b=>!b.resolved&&b.field==='permission');
 if(!business||!reviewer||!blocker)throw new Error('当前讨论不符合预置脚本，请使用真实 Agent 继续整理');
 const evidence=[business,reviewer].map(m=>({messageId:m.id,quote:m.text}));
 attachSuggestion(p,c.id,{summary:'示例演练：按预置业务与评审意见，本期交接成功后立即撤销原负责人全部权限，不保留 30 天只读；同步更新验收，并解决权限制度冲突。此结论来自 CRM 体验脚本，未调用模型。',issues:[],changes:[
 {field:'permission',before:c.fields.permission,after:'销售主管可转交本部门客户；交接成功后立即撤销原负责人读取、编辑、导出和再次转交的全部权限，不保留 30 天只读，不设临时例外；旧链接无权访问，新负责人可查看历史跟进并编辑。',reason:'预置业务与评审讨论已明确',evidence},
 {field:'acceptance',before:c.fields.acceptance,after:'正常交接后新负责人可查看历史跟进并编辑，原负责人旧链接无权访问，不可读取、编辑、导出或再次转交；覆盖无权、跨部门、离职接收人、重复提交和失败完整回滚。',reason:'与立即撤权规则保持一致',evidence}
 ],problemResolutions:[{blockerId:blocker.id,resolution:'本期立即撤销原负责人全部权限，不保留 30 天只读，无临时例外。',requiredFields:['permission','acceptance'],requiredRoles:['business','reviewer'],evidence}]},c.revision,c.messages.length);
 c.suggestion!.origin='example';
}
