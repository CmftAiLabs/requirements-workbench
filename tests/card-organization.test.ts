import test from 'node:test';
import assert from 'node:assert/strict';
import {createProject,addExtractedCards,applyAction,attachIntakeBatch,attachSuggestion} from '../server/domain';
import {FIELDS,cardStatus,type Fields,type IntakeCandidate,type Action} from '../shared/types';
import {groupingBasis,initialCommunicationCard,organizationOf,poolView} from '../shared/card-organization';
import {validateModuleGrouping} from '../server/pool-organization';
import {actionSchema} from '../server/validation';
import {validateIntakeCandidates} from '../server/ai';

const fields=Object.fromEntries(FIELDS.map(([k])=>[k,'主管可转交本部门客户；失败保留原负责人，成功立即更新权限。'])) as Fields;
const candidate=(title:string):IntakeCandidate=>({key:title,title,fields,sourceIds:['crm-kickoff'],assessment:'可确认',issues:[],evidence:{},granularity:'具体',origin:'材料要求',rationale:'独立业务结果',coverageGaps:[],organization:{module:'客户',priority:'优先沟通',reason:'归属规则影响权限与跟进记录。'}});
function setup(){const p=createProject('组织规则测试');addExtractedCards(p,[candidate('客户转交'),{...candidate('转交记录'),organization:{module:'记录',priority:'后续沟通',reason:'可在转交流程明确后核对记录细节。'}}],['crm-kickoff']);return p;}
function confirm(p:ReturnType<typeof setup>){const c=p.cards[0];applyAction(p,{type:'pmConfirm',cardId:c.id},'pm');applyAction(p,{type:'businessConfirm',cardId:c.id,result:'通过',comment:''},'business');}

test('调整模块与优先级只允许产品，不改变正文、修订、确认、阶段和快照',()=>{
 const p=setup();confirm(p);p.phase='已明确';p.version=[1,2,0];const before=structuredClone(p);
 const action:Action={type:'organizeCard',cardId:p.cards[0].id,organization:{module:'权限',priority:'正常沟通',reason:'当前关键规则已完成核对。'}};
 assert.throws(()=>applyAction(p,action,'business'));assert.deepEqual(p,before);
 applyAction(p,action,'pm');
 assert.equal(cardStatus(p.cards[0]),'已确认');assert.equal(p.phase,before.phase);assert.deepEqual(p.version,before.version);assert.deepEqual(p.snapshots,before.snapshots);
 const {organization,...actual}=p.cards[0],{organization:old,...expected}=before.cards[0];assert.deepEqual(actual,expected);assert.equal(organization!.module,'权限');assert.equal(p.events.length,before.events.length+1);
 for(const bad of [{...action,organization:{...action.organization,priority:'紧急'}},{...action,organization:{...action.organization,reason:' '}},{...action,organization:{...action.organization,module:'x'.repeat(31)}}])assert.equal(actionSchema.safeParse(bad).success,false);
});
test('待处理收纳确认卡，搜索全量；变更提议重返待处理但不撤销已有确认',()=>{
 const p=setup();confirm(p);const c=p.cards[0];
 assert.equal(poolView(p,'pending').visible.some(x=>x.id===c.id),false);
 assert.equal(initialCommunicationCard(p)?.id,p.cards[1].id);
 assert.equal(poolView(p,'pending','',c.id).visible.some(x=>x.id===c.id),true);
 assert.equal(poolView(p,'pending','客户转交').visible[0].id,c.id);
 assert.equal(poolView(p,'all').visible.length,2);
 applyAction(p,{type:'message',cardId:c.id,text:'补充一条普通说明'},'business');assert.equal(poolView(p,'pending').pending.some(x=>x.id===c.id),false);
 applyAction(p,{type:'proposeChange',cardId:c.id,text:'需要增加跨部门转交'},'business');
 assert.equal(cardStatus(c),'已确认');assert.equal(poolView(p,'pending').pending.some(x=>x.id===c.id),true);
 assert.equal(initialCommunicationCard(p)?.id,c.id);
 applyAction(p,{type:'scope',cardId:p.cards[1].id,included:false,reason:'本期排除'},'pm');
 assert.equal(poolView(p,'pending').outside.length,0);assert.equal(poolView(p,'pending','转交记录').outside.length,1);
});
test('沟通优先级不自动置顶；模块顺序稳定，后续沟通仍是待处理',()=>{
 const p=setup();p.moduleOrder=['记录','客户'];const view=poolView(p,'pending');
 assert.deepEqual(view.groups.map(g=>g.name),['记录','客户']);assert.equal(view.pinned.length,0);assert.equal(view.pending.length,2);
 delete p.cards[0].organization;assert.equal(organizationOf(p.cards[0]).module,'未分组');assert.equal(organizationOf(p.cards[0]).priority,'正常沟通');
});
test('确认后的新建议重新计入待处理；拒绝后收起且不撤销原确认',()=>{
 const p=setup();confirm(p);p.phase='已明确';p.version=[0,1,0];const c=p.cards[0],before=structuredClone(c);
 attachSuggestion(p,c.id,{summary:'可选变更',issues:[],changes:[{field:'flow',before:c.fields.flow,after:c.fields.flow+' 增加批量操作。',reason:'候选方案',evidence:[]}]},c.revision,c.messages.length);
 assert.equal(cardStatus(c),'已确认');assert.equal(poolView(p,'pending').pending.some(x=>x.id===c.id),true);assert.equal(p.phase,'已明确');
 applyAction(p,{type:'message',cardId:c.id,text:'还需继续比较'},'business');assert.equal(c.suggestion?.status,'已失效');assert.equal(poolView(p,'pending').pending.some(x=>x.id===c.id),true);
 attachSuggestion(p,c.id,{summary:'候选待取舍',issues:[],changes:[{field:'flow',before:c.fields.flow,after:c.fields.flow+' 增加批量操作。',reason:'候选方案',evidence:[]}]},c.revision,c.messages.length);
 applyAction(p,{type:'adoptConclusion',cardId:c.id,suggestionId:c.suggestion!.id,decisions:{flow:'不采纳'}},'pm');
 assert.equal(poolView(p,'pending').pending.some(x=>x.id===c.id),false);assert.deepEqual(c.fields,before.fields);assert.deepEqual(c.approvals,before.approvals);assert.equal(p.phase,'已明确');assert.deepEqual(p.version,[0,1,0]);
});

test('红旗置顶按身份保存，不重复展示，确认卡保留置顶且不改变业务状态',()=>{
 const p=setup();confirm(p);const before=structuredClone(p),c=p.cards[0];
 applyAction(p,{type:'pinChat',cardId:c.id,pinned:true},'business');
 assert.deepEqual(p.cards,before.cards);assert.equal(p.phase,before.phase);assert.deepEqual(p.events,before.events);
 assert.equal(poolView(p,'pending','','','business').pinned[0].id,c.id);
 assert.equal(poolView(p,'all','','','business').regular.some(x=>x.id===c.id),false);
 assert.equal(poolView(p,'all','','','pm').pinned.length,0);
 applyAction(p,{type:'pinChat',cardId:c.id,pinned:false},'business');
 assert.equal(poolView(p,'all','','','business').pinned.length,0);
 assert.equal(poolView(p,'all','','','business').regular.some(x=>x.id===c.id),true);
});

test('概要不进入聊天列表、数量、搜索或默认选择；概要仍保留在项目',()=>{
 const p=setup();p.cards.unshift({...structuredClone(p.cards[0]),id:'overview',title:'独有的概要标题',granularity:'概要'});
 assert.equal(poolView(p,'all').all.length,2);assert.equal(poolView(p,'pending','独有的概要标题').visible.length,0);
 assert.notEqual(initialCommunicationCard(p)?.id,'overview');
 assert.throws(()=>applyAction(p,{type:'pinChat',cardId:'overview',pinned:true},'pm'),/具体需求/);
 p.cards=p.cards.slice(0,1);assert.equal(initialCommunicationCard(p),undefined);assert.equal(p.cards.length,1);
});

test('没有多个有效模块时平铺；不分组可恢复，不丢失模块或确认',()=>{
 const p=setup();confirm(p);const cards=structuredClone(p.cards);
 assert.equal(poolView(p,'all').grouping,'modules');
 applyAction(p,{type:'setPoolGrouping',mode:'flat'},'pm');assert.equal(poolView(p,'all').loose.length,2);assert.deepEqual(p.cards,cards);
 assert.throws(()=>applyAction(p,{type:'setPoolGrouping',mode:'modules'},'business'),/产品经理/);
 applyAction(p,{type:'setPoolGrouping',mode:'modules'},'pm');assert.equal(poolView(p,'all').grouping,'modules');
 delete p.cards[1].organization;assert.equal(poolView(p,'all').grouping,'flat');
});

test('模块重命名同步整组及未入池候选，拒绝同名、空名与越权，保留正文确认和快照',()=>{
 const p=setup();confirm(p);const batch=attachIntakeBatch(p,[candidate('新的客户规则')],['crm-kickoff']);const before=structuredClone(p);
 const action:Action={type:'renameModule',from:'客户',to:'客户管理'};
 assert.throws(()=>applyAction(p,action,'reviewer'),/产品经理/);assert.deepEqual(p,before);
 assert.throws(()=>applyAction(p,{...action,to:'记录'},'pm'),/同名/);assert.deepEqual(p,before);
 assert.equal(actionSchema.safeParse({...action,to:' '}).success,false);
 applyAction(p,action,'pm');assert.equal(p.cards[0].organization?.module,'客户管理');assert.equal(batch.drafts[0].organization?.module,'客户管理');assert.equal(batch.revision,before.intakeBatches![0].revision+1);
 for(const [i,c] of p.cards.entries()){const {organization,...actual}=c,{organization:old,...expected}=before.cards[i];assert.deepEqual(actual,expected);}
 assert.equal(p.phase,before.phase);assert.deepEqual(p.version,before.version);assert.deepEqual(p.snapshots,before.snapshots);
});

test('自动归类拒绝漏卡、重复、外来卡、概要和同名模块；可建议不分组',()=>{
 const p=setup(),[a,b]=p.cards;const good={mode:'modules',summary:'两个独立业务模块',groups:[{name:'客户',cardIds:[a.id]},{name:'记录',cardIds:[b.id]}]};
 assert.deepEqual(validateModuleGrouping(good,p),good);
 assert.throws(()=>validateModuleGrouping({...good,groups:[good.groups[0],{name:'记录',cardIds:[a.id]}]},p),/重复归类/);
 assert.throws(()=>validateModuleGrouping({...good,groups:[good.groups[0],{name:'记录',cardIds:['outside']}]},p),/具体需求/);
 assert.throws(()=>validateModuleGrouping({...good,groups:[good.groups[0],{name:'客户',cardIds:[b.id]}]},p),/名称不能重复/);
 assert.throws(()=>validateModuleGrouping({...good,groups:[{name:'客户',cardIds:[a.id,b.id]}]},p),/不分组/);
 p.cards.push({...structuredClone(a),id:'overview',granularity:'概要'});
 assert.throws(()=>validateModuleGrouping({...good,groups:[good.groups[0],{name:'记录',cardIds:[b.id,'overview']}]},p),/具体需求/);
 assert.deepEqual(validateModuleGrouping({mode:'flat',summary:'没有清晰模块边界',groups:[]},p),{mode:'flat',summary:'没有清晰模块边界',groups:[]});
});

test('归类方案需要人应用，过期方案拒绝；置顶与确认变化不会使方案失效',()=>{
 const p=setup();confirm(p);const before=structuredClone(p);
 p.moduleProposal={id:'proposal',jobId:'job',base:groupingBasis(p),createdAt:new Date().toISOString(),mode:'modules',summary:'按业务入口归类',groups:[{name:'归属管理',cardIds:[p.cards[0].id]},{name:'记录查询',cardIds:[p.cards[1].id]}]};
 assert.deepEqual(p.cards,before.cards);
 assert.throws(()=>applyAction(p,{type:'applyModuleGrouping',proposalId:'proposal'},'business'),/产品经理/);
 applyAction(p,{type:'pinChat',cardId:p.cards[0].id,pinned:true},'pm');
 applyAction(p,{type:'applyModuleGrouping',proposalId:'proposal'},'pm');
 assert.equal(cardStatus(p.cards[0]),'已确认');assert.equal(p.cards[0].organization?.module,'归属管理');assert.equal(p.cards[0].revision,before.cards[0].revision);assert.deepEqual(p.snapshots,before.snapshots);assert.deepEqual(p.version,before.version);assert.equal(p.phase,before.phase);assert.equal(p.chatPins?.pm?.[0],p.cards[0].id);
 p.moduleProposal={id:'stale',jobId:'job2',base:groupingBasis(p),createdAt:new Date().toISOString(),mode:'flat',summary:'集中查看',groups:[]};p.cards[1].revision++;
 assert.throws(()=>applyAction(p,{type:'applyModuleGrouping',proposalId:'stale'},'pm'),/重新分析/);
});
test('材料候选的组织建议可编辑，统一入池保留；已入池正文与组织不从旧草稿覆写',()=>{
 const p=createProject('材料组织测试');const batch=attachIntakeBatch(p,[candidate('客户归属')],['crm-kickoff']);
 const make=(importSelected:boolean):Extract<Action,{type:'saveIntake'}>=>({type:'saveIntake',batchId:batch.id,revision:batch.revision,importSelected,drafts:batch.drafts.map(d=>({id:d.id,title:d.title,fields:d.fields,selected:d.selected,exclusionReason:d.exclusionReason,coverageGaps:d.coverageGaps,organization:d.organization}))});
 const action=make(false);action.drafts[0].organization={module:'客户管理',priority:'正常沟通',reason:'按客户模块逐项明确。'};applyAction(p,action,'pm');assert.equal(p.cards.length,0);
 applyAction(p,make(true),'pm');assert.deepEqual(p.cards[0].organization,action.drafts[0].organization);assert.deepEqual(p.cards[0].approvals,{});
 const invalid=make(false);invalid.drafts[0].organization={module:'其他',priority:'后续沟通',reason:'不应覆盖'};assert.throws(()=>applyAction(p,invalid,'pm'),/已入池/);
});
test('AI 候选接受固定优先级与理由，拒绝自造枚举',()=>{
 const p=createProject('AI组织测试'),draft=candidate('待核对需求');draft.fields=Object.fromEntries(FIELDS.map(([k])=>[k,'待明确：规则待业务补充'])) as Fields;draft.evidence={goal:[{materialId:p.materials[0].id,quote:p.materials[0].text.slice(0,25)}]};draft.assessment='待澄清';
 const result=validateIntakeCandidates({cards:[draft]},p.materials,[]);assert.deepEqual(result[0].organization,draft.organization);
 assert.throws(()=>validateIntakeCandidates({cards:[{...draft,organization:{...draft.organization,priority:'P0'}}]},p.materials,[]));
});
