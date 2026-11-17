import test from 'node:test';
import assert from 'node:assert/strict';
import {addExtractedCards, applyAction, attachIntakeBatch, attachIntakeRefinement, attachSuggestion, beginDelivery, buildMarkdown, createProject} from '../server/domain.ts';
import {concreteCards, intakeAssessment, isOverview, outlineGaps} from '../shared/intake-policy.ts';
import {cardStatus} from '../shared/types.ts';
import {actionSchema} from '../server/validation.ts';
import type {Action, Card, Fields, IntakeBatch, IntakeCandidate, Project} from '../shared/types.ts';

const fields = (): Fields => ({goal:'客户交接责任清晰',scope:'主管转交单个客户',flow:'选择新负责人并提交，成功后更新责任人',permission:'旧负责人立即无权，新负责人可编辑',exception:'失败回滚，重复请求幂等',data:'保存责任人与交接原因',constraint:'使用现有权限系统',quality:'50并发时95%请求3秒完成',acceptance:'交接成功、权限同步；失败时原数据不变'});
const candidate = (key:string, overrides:Partial<IntakeCandidate> = {}): IntakeCandidate => ({key,title:`需求 ${key}`,fields:fields(),sourceIds:['crm-kickoff'],assessment:'可确认',issues:[],evidence:{},granularity:'具体',origin:'材料要求',rationale:'独立判断范围并验收',coverageGaps:[],...overrides});
const outline = (): IntakeCandidate => candidate('outline',{title:'客户归属与交接',granularity:'概要',fields:{...fields(),permission:'',exception:'',data:'',quality:'',acceptance:''},rationale:'包含多个业务结果'});
function setup(children = 2) {
  const project = createProject('材料箱验收');
  const batch = attachIntakeBatch(project,[outline(),...Array.from({length:children},(_,index)=>candidate(`child-${index}`,{parentKey:'outline'}))],['crm-kickoff']);
  return {project,batch};
}
function saveAction(batch:IntakeBatch, importSelected = true): Extract<Action,{type:'saveIntake'}> {
  return {type:'saveIntake',batchId:batch.id,revision:batch.revision,importSelected,drafts:batch.drafts.map(draft=>({id:draft.id,title:draft.title,fields:structuredClone(draft.fields),selected:draft.selected,exclusionReason:draft.exclusionReason,coverageGaps:[...draft.coverageGaps]}))};
}
function confirm(project:Project, card:Card) {
  applyAction(project,{type:'pmConfirm',cardId:card.id},'pm');
  applyAction(project,{type:'businessConfirm',cardId:card.id,result:'通过',comment:''},'business');
}
function formalSetup() {
  const project = createProject('已有需求');
  addExtractedCards(project,[candidate('existing')],['crm-kickoff']);
  confirm(project,project.cards[0]);
  applyAction(project,{type:'submitReview'},'pm');
  applyAction(project,{type:'review',result:'通过',comment:''},'reviewer');
  return {project,card:project.cards[0]};
}

test('材料抽取只持久化候选草稿，材料要求默认选中，补充设想默认不选且不回退阶段',()=>{
  const project=createProject('CRM'); project.phase='已明确';
  const batch=attachIntakeBatch(project,[candidate('original'),candidate('idea',{origin:'建议补充'})],['crm-kickoff']);
  assert.equal(project.cards.length,0); assert.equal(project.phase,'已明确');
  assert.deepEqual(batch.drafts.map(item=>item.selected),[true,false]);
  assert.equal(project.materials[0].status,'已生成候选卡');
  assert.deepEqual(project.materials[0].cardIds,[]);
  const action=saveAction(batch,false); action.drafts[0].title='人工修订标题';
  applyAction(project,action,'pm');
  assert.equal(project.phase,'已明确'); assert.equal(batch.revision,2);
});

test('整批来源、证据、重复编号和父子层级在落盘前验证',()=>{
  const invalids: IntakeCandidate[][] = [
    [candidate('ok'),candidate('bad',{sourceIds:['unknown']})],
    [candidate('ok'),candidate('bad',{evidence:{goal:[{materialId:'crm-kickoff',quote:'不存在的来源原句'}]}})],
    [candidate('same'),candidate('same',{title:'另一需求'})],
    [candidate('root'),candidate('child',{parentKey:'root'})],
    [outline(),candidate('child',{granularity:'概要',parentKey:'outline'})],
    [candidate('orphan',{parentKey:'missing'})],
  ];
  for(const candidates of invalids){const project=createProject('CRM');const before=structuredClone(project);assert.throws(()=>attachIntakeBatch(project,candidates,['crm-kickoff']));assert.deepEqual(project,before);}
});

test('相同材料不能重复建立批次；标题相同正式卡自动关联，不能重复入池',()=>{
  const {project,card}=formalSetup();
  const batch=attachIntakeBatch(project,[candidate('existing',{title:card.title})],['crm-kickoff']);
  assert.equal(batch.drafts[0].relatedCardId,card.id);assert.equal(batch.drafts[0].selected,false);
  assert.throws(()=>attachIntakeBatch(project,[candidate('again')],['crm-kickoff']),/已经生成/);
  const action=saveAction(batch);action.drafts[0].selected=true;
  const before=structuredClone(project);assert.throws(()=>applyAction(project,action,'pm'),/关联正式卡/);assert.deepEqual(project,before);
});

test('入池只表示保留需求，具体卡可确认、待澄清、需评估，不自动生成任何审批',()=>{
  const project=createProject('CRM');
  const batch=attachIntakeBatch(project,[candidate('ready'),candidate('unclear',{fields:{...fields(),permission:'待明确'}}),candidate('evaluate',{assessment:'需评估',issues:['跨部门权限必要性待评估']})],['crm-kickoff']);
  applyAction(project,saveAction(batch),'pm');
  assert.deepEqual(project.cards.map(cardStatus),['可确认','待澄清','需评估']);
  assert.ok(project.cards.every(card=>card.revision===1&&card.confirmations.length===0&&Object.keys(card.approvals).length===0));
  assert.ok(batch.drafts.every(draft=>draft.poolCardId));
});

test('选具体子卡时自动一并导入概要；概要问题归为待细化范围，不产生重复阻断',()=>{
  const {project,batch}=setup(1);
  batch.drafts[0].issues=['批量转交边界还需明确'];
  const action=saveAction(batch);action.drafts[0].selected=false;
  applyAction(project,action,'pm');
  const parent=project.cards.find(isOverview)!;const child=concreteCards(project)[0];
  assert.equal(child.parentId,parent.id);assert.equal(parent.blockers.length,0);
  assert.deepEqual(parent.coverageGaps,['批量转交边界还需明确']);
  assert.equal(concreteCards(project).length,1);assert.equal(parent.approvals.pm,undefined);
});

test('人工改写候选字段清除对应来源证据，保留修改记录，未改字段来源仍保留',()=>{
  const project=createProject('CRM');const quote='客户负责人变更与权限变更必须在同一事务完成';
  const batch=attachIntakeBatch(project,[candidate('ready',{evidence:{quality:[{materialId:'crm-kickoff',quote}],permission:[{materialId:'crm-kickoff',quote}]}})],['crm-kickoff']);
  const action=saveAction(batch);action.drafts[0].fields.quality='100并发下95%请求2秒内完成';
  applyAction(project,action,'pm');const card=project.cards[0];
  assert.deepEqual(card.provenance.quality,[]);assert.equal(card.provenance.permission[0].quote,quote);
  assert.deepEqual(batch.drafts[0].editedFields,['quality']);assert.match(card.history[0].reason,/产品经理调整：质量要求/);
  assert.match(project.events.at(-1)!.detail,/人工调整/);
});

test('未选材料需求保留原范围，不能通过清空概要待细化字段绕过送审',()=>{
  const {project,batch}=setup();const action=saveAction(batch);action.drafts[2].selected=false;
  applyAction(project,action,'pm');const parent=project.cards.find(isOverview)!;
  confirm(project,concreteCards(project)[0]);
  applyAction(project,{type:'updateOverview',cardId:parent.id,title:parent.title,fields:parent.fields,coverageGaps:[],reason:'已明确已选部分'},'pm');
  assert.match(outlineGaps(project)[0].reasons.join('；'),/尚未入池或明确排除/);
  assert.throws(()=>applyAction(project,{type:'submitReview'},'pm'),/概要范围尚未覆盖/);
});

test('明确排除须保留理由，排除记录进入最终PRD与冻结快照',()=>{
  const {project,batch}=setup();const action=saveAction(batch);action.drafts[2].selected=false;action.drafts[2].exclusionReason='批量交接不属本期范围';
  applyAction(project,action,'pm');confirm(project,concreteCards(project)[0]);
  assert.deepEqual(outlineGaps(project),[]);
  applyAction(project,{type:'submitReview'},'pm');
  const snapshot=structuredClone(project.snapshots.at(-1)!);
  assert.match(snapshot.markdown,/批量交接不属本期范围/);assert.equal(snapshot.cards.length,1);
  assert.ok(!snapshot.markdown.includes('### 客户归属与交接'));
  batch.drafts[2].exclusionReason='后续理由';
  assert.deepEqual(project.snapshots.at(-1),snapshot);
});

test('根材料需求未选也必须显式处理；纯建议补充未选不阻止评审',()=>{
  const {project,card}=formalSetup();project.phase='可讨论';
  const batch=attachIntakeBatch(project,[candidate('root'),candidate('idea',{origin:'建议补充'})],['crm-kickoff']);
  const action=saveAction(batch);action.drafts[0].selected=false;
  applyAction(project,action,'pm');assert.equal(outlineGaps(project)[0].cardId,batch.drafts[0].id);
  assert.throws(()=>applyAction(project,{type:'submitReview'},'pm'),/尚未入池/);
  const excluded=saveAction(batch);excluded.drafts[0].exclusionReason='与现有已确认范围重复，不另立项';applyAction(project,excluded,'pm');
  assert.deepEqual(outlineGaps(project),[]);assert.equal(cardStatus(card),'已确认');applyAction(project,{type:'submitReview'},'pm');
});

test('概要不走整卡确认、字段Agent和普通编辑；仅具体卡计入确认和PRD',()=>{
  const {project,batch}=setup(1);applyAction(project,saveAction(batch),'pm');
  const parent=project.cards.find(isOverview)!;
  assert.throws(()=>applyAction(project,{type:'pmConfirm',cardId:parent.id},'pm'),/概要卡/);
  assert.throws(()=>applyAction(project,{type:'businessConfirm',cardId:parent.id,result:'通过',comment:''},'business'),/概要卡/);
  assert.throws(()=>applyAction(project,{type:'editCard',cardId:parent.id,title:parent.title,fields:parent.fields,reason:'编辑'},'pm'),/概要详情/);
  assert.throws(()=>attachSuggestion(project,parent.id,{summary:'总结',issues:[],changes:[]},1,0),/概要卡/);
  confirm(project,concreteCards(project)[0]);applyAction(project,{type:'submitReview'},'pm');
  assert.equal(project.snapshots.at(-1)!.cards.length,1);assert.equal(project.phase,'可评审');
  assert.ok(!buildMarkdown(project,project.cards).includes('### 客户归属与交接'));
});

test('无具体子卡的概要阻止评审，即使所有字段都填写完整',()=>{
  const {project}=formalSetup();project.phase='可讨论';
  const batch=attachIntakeBatch(project,[outline()],['crm-kickoff']);applyAction(project,saveAction(batch),'pm');
  assert.match(outlineGaps(project)[0].reasons.join('；'),/尚无本期已入池/);
  assert.throws(()=>applyAction(project,{type:'submitReview'},'pm'),/尚无本期已入池/);
});

test('过期、遗漏、重复、外部草稿和非法字段均原子拒绝，不留下部分卡片',()=>{
  for(const alter of [
    (action:ReturnType<typeof saveAction>)=>{action.revision=0;},
    (action:ReturnType<typeof saveAction>)=>{action.drafts.pop();},
    (action:ReturnType<typeof saveAction>)=>{action.drafts[1].id=action.drafts[0].id;},
    (action:ReturnType<typeof saveAction>)=>{action.drafts[1].id='another-batch';},
    (action:ReturnType<typeof saveAction>)=>{action.drafts[1].fields={...action.drafts[1].fields,invalid:'自由字段'} as Fields;},
    (action:ReturnType<typeof saveAction>)=>{action.drafts[1].exclusionReason='已排除却仍选中';},
  ]){const{project,batch}=setup();const action=saveAction(batch);alter(action);const before=structuredClone(project);assert.throws(()=>applyAction(project,action,'pm'));assert.deepEqual(project,before);}
});

test('导入权限和冻结交付均由后端校验',()=>{
  const {project,batch}=setup();for(const role of ['business','reviewer'] as const){const before=structuredClone(project);assert.throws(()=>applyAction(project,saveAction(batch),role),/权限/);assert.deepEqual(project,before);}
  const ready=formalSetup();beginDelivery(ready.project,'pm','local');
  assert.throws(()=>attachIntakeBatch(ready.project,[candidate('new')],['crm-kickoff']),/冻结交付/);
  project.deliveries=structuredClone(ready.project.deliveries);assert.throws(()=>applyAction(project,saveAction(batch),'pm'),/冻结交付/);
});

test('已入池草稿只读，重复导入不重复造卡，后续只导入新增选择且保留其他确认',()=>{
  const {project,batch}=setup();const action=saveAction(batch);action.drafts[2].selected=false;applyAction(project,action,'pm');
  const concrete=concreteCards(project)[0];confirm(project,concrete);const approvals=structuredClone(concrete.approvals);
  const edited=saveAction(batch);edited.drafts[1].fields.goal='不允许从材料箱改正式卡';const before=structuredClone(project);
  assert.throws(()=>applyAction(project,edited,'pm'),/需求池编辑/);assert.deepEqual(project,before);
  applyAction(project,saveAction(batch),'pm');assert.equal(project.cards.length,2);
  const more=saveAction(batch);more.drafts[2].selected=true;project.phase='已明确';applyAction(project,more,'pm');
  assert.equal(project.cards.length,3);assert.equal(project.phase,'可讨论');assert.deepEqual(concrete.approvals,approvals);
});

test('正式概要更新只使自身修订和阶段变化，来源快照与无关具体确认保持',()=>{
  const {project,batch}=setup(1);applyAction(project,saveAction(batch),'pm');const parent=project.cards.find(isOverview)!;const concrete=concreteCards(project)[0];confirm(project,concrete);
  project.phase='已明确';const approvals=structuredClone(concrete.approvals);const draftBefore=structuredClone(batch.drafts[0]);
  const action:Extract<Action,{type:'updateOverview'}>={type:'updateOverview',cardId:parent.id,title:parent.title,fields:parent.fields,coverageGaps:['回收规则尚未细化'],reason:'业务补充回收范围'};
  applyAction(project,action,'pm');assert.equal(parent.revision,2);assert.equal(project.phase,'可讨论');assert.deepEqual(concrete.approvals,approvals);assert.deepEqual(batch.drafts[0],draftBefore);
  const revision=parent.revision;applyAction(project,action,'pm');assert.equal(parent.revision,revision,'无变化不产生新修订');
  assert.throws(()=>applyAction(project,{...action,cardId:concrete.id},'pm'),/只有概要卡/);
});

test('细化保留原概要与人工编辑子卡，追加具体草稿，不直接入池；过期结果被拒绝',()=>{
  const {project,batch}=setup(1);const parent=batch.drafts[0];const childBefore=structuredClone(batch.drafts[1]);parent.coverageGaps=['现有回收范围待澄清'];
  const parentCandidate=candidate(parent.id,{...outline(),key:parent.id,coverageGaps:['新发现的通知边界']});
  const result=[parentCandidate,candidate('new-child',{parentKey:parent.id,title:'到期回收'})];
  attachIntakeRefinement(project,batch.id,parent.id,result,batch.revision);
  assert.equal(batch.revision,2);assert.equal(project.cards.length,0);assert.deepEqual(batch.drafts[1],childBefore);assert.equal(batch.drafts[2].parentId,parent.id);
  assert.deepEqual(parent.coverageGaps,['现有回收范围待澄清','新发现的通知边界']);
  const before=structuredClone(project);assert.throws(()=>attachIntakeRefinement(project,batch.id,parent.id,result,1),/已经变化/);assert.deepEqual(project,before);
});

test('正式概要仍可细化，使用正式正文，Agent不会改写已入池概要或重复候选',()=>{
  const {project,batch}=setup(1);applyAction(project,saveAction(batch),'pm');const parent=project.cards.find(isOverview)!;
  applyAction(project,{type:'updateOverview',cardId:parent.id,title:'客户交接与回收',fields:{...parent.fields,scope:'增加到期回收范围'},coverageGaps:[],reason:'新增范围'},'pm');
  const draft=batch.drafts[0];const prior=structuredClone(parent);
  const parentCandidate=candidate(draft.id,{...outline(),key:draft.id,title:parent.title,fields:parent.fields});
  attachIntakeRefinement(project,batch.id,draft.id,[parentCandidate,candidate('reclaim',{title:'到期回收',parentKey:draft.id})],batch.revision);
  assert.deepEqual(parent,prior);assert.equal(project.cards.length,2);assert.equal(batch.drafts.length,3);
  const before=structuredClone(project);assert.throws(()=>attachIntakeRefinement(project,batch.id,draft.id,[parentCandidate,candidate('duplicate',{title:'到期回收',parentKey:draft.id})],batch.revision),/重复/);assert.deepEqual(project,before);
});

test('概要范围与子卡范围保持一致，不能排除仍有本期子卡的概要',()=>{
  const {project,batch}=setup(1);applyAction(project,saveAction(batch),'pm');const parent=project.cards.find(isOverview)!;const child=concreteCards(project)[0];
  assert.throws(()=>applyAction(project,{type:'scope',cardId:parent.id,included:false,reason:'不做'},'pm'),/逐张处理/);
  applyAction(project,{type:'scope',cardId:child.id,included:false,reason:'下期再做'},'pm');applyAction(project,{type:'scope',cardId:parent.id,included:false,reason:'整体下期再做'},'pm');
  assert.throws(()=>applyAction(project,{type:'scope',cardId:child.id,included:true,reason:'恢复'},'pm'),/先恢复概要/);
});

test('保存请求使用固定枚举与字段，拒绝重复草稿和过长正文',()=>{
  const {batch}=setup();const action=saveAction(batch);assert.equal(actionSchema.safeParse(action).success,true);
  const repeated={...action,drafts:[action.drafts[0],action.drafts[0]]};assert.equal(actionSchema.safeParse(repeated).success,false);
  action.drafts[0].fields.goal='a'.repeat(12001);assert.equal(actionSchema.safeParse(action).success,false);
});

test('关联已有卡可人工记录覆盖理由解除遗漏阻断，不能编辑或重复选择',()=>{
  const {project,card}=formalSetup();const batch=attachIntakeBatch(project,[candidate('covered',{relatedCardId:card.id})],['crm-kickoff']);
  assert.equal(outlineGaps(project).length,1);
  const action=saveAction(batch);action.drafts[0].exclusionReason=`已核对由 ${card.title} 覆盖，不重复建卡`;
  applyAction(project,action,'pm');assert.deepEqual(outlineGaps(project),[]);assert.equal(project.cards.length,1);
  const invalid=saveAction(batch);invalid.drafts[0].fields.goal='将关联草稿改成另一需求';const before=structuredClone(project);
  assert.throws(()=>applyAction(project,invalid,'pm'),/关联正式卡/);assert.deepEqual(project,before);
});

test('候选卡评估随草稿字段更新，概要不因字段填写完整就成为可确认',()=>{
  const project=createProject('CRM');const batch=attachIntakeBatch(project,[candidate('ready')],['crm-kickoff']);
  const action=saveAction(batch,false);action.drafts[0].fields.permission='';applyAction(project,action,'pm');
  assert.equal(batch.drafts[0].assessment,'待澄清');
  const restore=saveAction(batch,false);restore.drafts[0].fields.permission='原负责人立即失去权限';applyAction(project,restore,'pm');
  assert.equal(batch.drafts[0].assessment,'可确认');
  assert.equal(intakeAssessment({...candidate('outline'),granularity:'概要'}),'待澄清');
});

test('纯背景材料可以形成空分析批次，不虚构需求且避免重复调用',()=>{
  const project=createProject('背景材料');project.phase='已明确';
  const batch=attachIntakeBatch(project,[],['crm-kickoff']);
  assert.deepEqual(batch.drafts,[]);assert.equal(project.cards.length,0);assert.equal(project.phase,'已明确');
  assert.equal(project.materials[0].status,'已整理');assert.match(project.events.at(-1)!.detail,/未识别到可抽取的新需求/);
  assert.throws(()=>attachIntakeBatch(project,[],['crm-kickoff']),/已经生成/);
});

test('已入池概要细化不得静默新增或移除正式范围，失败时无子卡或草稿部分落库',()=>{
  const {project,batch}=setup(1);applyAction(project,saveAction(batch),'pm');
  const parent=project.cards.find(isOverview)!;const draft=batch.drafts[0];
  applyAction(project,{type:'updateOverview',cardId:parent.id,title:parent.title,fields:parent.fields,coverageGaps:['批量交接范围待细化'],reason:'保留尚未展开范围'},'pm');
  for(const coverageGaps of [['批量交接范围待细化','通知方式尚未澄清'],[]]) {
    const candidates=[candidate(draft.id,{...outline(),key:draft.id,title:parent.title,fields:parent.fields,coverageGaps}),candidate('new-child',{title:'新增通知需求',parentKey:draft.id})];
    const before=structuredClone(project);
    assert.throws(()=>attachIntakeRefinement(project,batch.id,draft.id,candidates,batch.revision),/先到需求池编辑正式概要范围/);
    assert.deepEqual(project,before);
  }
  const matching=[candidate(draft.id,{...outline(),key:draft.id,title:parent.title,fields:parent.fields,coverageGaps:[...parent.coverageGaps!]}),candidate('new-child',{title:'新增通知需求',parentKey:draft.id})];
  attachIntakeRefinement(project,batch.id,draft.id,matching,batch.revision);
  assert.deepEqual(parent.coverageGaps,['批量交接范围待细化']);assert.equal(batch.drafts.length,3);
});

test('概要真实字段变化使本期子卡重新核对共同约束，独立卡和非本期子卡不受影响',()=>{
  const {project,batch}=setup(2);applyAction(project,saveAction(batch),'pm');
  addExtractedCards(project,[candidate('independent',{title:'独立客户报表需求'})],['crm-kickoff']);
  const parent=project.cards.find(isOverview)!;const children=concreteCards(project).filter(card=>card.parentId===parent.id);const independent=project.cards.find(card=>card.title==='独立客户报表需求')!;
  confirm(project,children[0]);confirm(project,children[1]);confirm(project,independent);
  applyAction(project,{type:'scope',cardId:children[1].id,included:false,reason:'下期再实施'},'pm');
  attachSuggestion(project,children[0].id,{summary:'待决定的流程建议',issues:[],changes:[{field:'flow',before:children[0].fields.flow,after:children[0].fields.flow+' 补充查看记录。',reason:'讨论建议',evidence:[]}]},children[0].revision,0);
  const childBefore=structuredClone(children[0]);const excludedBefore=structuredClone(children[1]);const independentBefore=structuredClone(independent);project.phase='已明确';
  applyAction(project,{type:'updateOverview',cardId:parent.id,title:parent.title,fields:{...parent.fields,scope:'本期增加跨部门单个客户交接',constraint:'跨部门交接须符合统一客户可见性制度'},coverageGaps:[],reason:'业务明确跨部门范围'},'pm');
  assert.equal(project.phase,'可讨论');assert.equal(children[0].revision,childBefore.revision);assert.equal(children[0].round,childBefore.round+1);
  assert.deepEqual(children[0].approvals,{});assert.deepEqual(children[0].history,childBefore.history);assert.deepEqual(children[0].confirmations,childBefore.confirmations);
  assert.equal(children[0].suggestion!.status,'已失效');assert.equal(children[0].blockers.length,1);
  assert.match(children[0].blockers[0].reason,/客户归属与交接.*场景与范围、依赖约束.*重新确认/);
  assert.deepEqual(children[1],excludedBefore);assert.deepEqual(independent,independentBefore);
});

test('概要标题和待细化清单修改不撤销子卡确认，非法概要修改不部分影响子卡',()=>{
  const {project,batch}=setup(1);applyAction(project,saveAction(batch),'pm');const parent=project.cards.find(isOverview)!;const child=concreteCards(project)[0];confirm(project,child);
  const childBefore=structuredClone(child);
  applyAction(project,{type:'updateOverview',cardId:parent.id,title:'客户归属管理',fields:parent.fields,coverageGaps:['补充批量需求是否纳入'],reason:'整理概要名称与后续清单'},'pm');
  assert.deepEqual(child,childBefore);
  const before=structuredClone(project);
  assert.throws(()=>applyAction(project,{type:'updateOverview',cardId:parent.id,title:parent.title,fields:{...parent.fields,scope:'修改范围'},coverageGaps:[''],reason:'范围调整'},'pm'),/尚待细化范围/);
  assert.deepEqual(project,before);
});

test('草稿排除理由不改变已明确PRD与正式范围，统一确认后才采用排除快照并回退',()=>{
  const {project,card}=formalSetup();const originalMarkdown=buildMarkdown(project);
  const batch=attachIntakeBatch(project,[candidate('future',{title:'批量客户交接'})],['crm-kickoff']);
  const draftAction=saveAction(batch,false);draftAction.drafts[0].selected=false;draftAction.drafts[0].exclusionReason='本期不包含批量交接';
  applyAction(project,draftAction,'pm');
  assert.equal(project.phase,'已明确');assert.equal(buildMarkdown(project),originalMarkdown);assert.equal(outlineGaps(project).length,1);
  assert.equal(batch.drafts[0].acceptedExclusionReason,undefined);
  const approvals=structuredClone(card.approvals);applyAction(project,saveAction(batch,true),'pm');
  assert.equal(project.phase,'可讨论');assert.equal(project.cards.length,1);assert.deepEqual(outlineGaps(project),[]);assert.deepEqual(card.approvals,approvals);
  assert.equal(batch.drafts[0].acceptedExclusionReason,'本期不包含批量交接');assert.equal(batch.drafts[0].acceptedExclusionTitle,'批量客户交接');
  applyAction(project,{type:'submitReview'},'pm');applyAction(project,{type:'review',result:'通过',comment:''},'reviewer');
  const confirmedMarkdown=buildMarkdown(project);const snapshot=structuredClone(project.snapshots.at(-1));
  const revised=saveAction(batch,false);revised.drafts[0].title='跨部门批量交接';revised.drafts[0].exclusionReason='跨部门批量场景改到下一期';
  applyAction(project,revised,'pm');
  assert.equal(project.phase,'已明确');assert.equal(buildMarkdown(project),confirmedMarkdown);assert.deepEqual(outlineGaps(project),[]);
  applyAction(project,saveAction(batch,true),'pm');
  assert.equal(project.phase,'可讨论');assert.match(buildMarkdown(project),/跨部门批量交接.*跨部门批量场景改到下一期/);
  assert.deepEqual(project.snapshots.at(-1),snapshot,'已明确历史PRD不随排除理由修改');
});

test('已接受排除可再次选中入池，草稿阶段保留旧决定，正式入池后清除排除快照',()=>{
  const {project}=formalSetup();const batch=attachIntakeBatch(project,[candidate('future')],['crm-kickoff']);
  const excluded=saveAction(batch);excluded.drafts[0].selected=false;excluded.drafts[0].exclusionReason='下期再做';applyAction(project,excluded,'pm');
  project.phase='已明确';const priorMarkdown=buildMarkdown(project);
  const restored=saveAction(batch,false);restored.drafts[0].selected=true;restored.drafts[0].exclusionReason='';applyAction(project,restored,'pm');
  assert.equal(project.phase,'已明确');assert.equal(buildMarkdown(project),priorMarkdown);assert.equal(batch.drafts[0].acceptedExclusionReason,'下期再做');
  applyAction(project,saveAction(batch),'pm');
  assert.equal(project.phase,'可讨论');assert.equal(project.cards.length,2);assert.ok(batch.drafts[0].poolCardId);
  assert.equal(batch.drafts[0].acceptedExclusionReason,'');assert.equal(batch.drafts[0].acceptedExclusionTitle,undefined);assert.ok(!buildMarkdown(project).includes('下期再做'));
});

test('仅在草稿撤销排除不会提前恢复范围，确认撤销才重新出现待处理范围',()=>{
  const {project}=formalSetup();const batch=attachIntakeBatch(project,[candidate('future')],['crm-kickoff']);
  const excluded=saveAction(batch);excluded.drafts[0].selected=false;excluded.drafts[0].exclusionReason='当前不实施';applyAction(project,excluded,'pm');
  project.phase='已明确';const restored=saveAction(batch,false);restored.drafts[0].exclusionReason='';applyAction(project,restored,'pm');
  assert.equal(project.phase,'已明确');assert.deepEqual(outlineGaps(project),[]);
  applyAction(project,saveAction(batch),'pm');
  assert.equal(project.phase,'可讨论');assert.equal(outlineGaps(project).length,1);assert.equal(project.cards.length,1);
});
