import test from 'node:test';
import assert from 'node:assert/strict';
import {FIELDS,type Action,type Fields,type IntakeBatch,type IntakeCandidate} from '../shared/types';
import {aiReviewFor,currentAIOrigin,decideAIField,pendingAIFields,resolvedIntakeFields} from '../shared/intake-fields';
import {createProject,attachIntakeBatch,applyAction,buildMarkdown,attachIntakeRefinement} from '../server/domain';
import {validateIntakeCandidates} from '../server/ai';
import {actionSchema} from '../server/validation';
import {demoInput} from '../server/demo-schema';
import {workspacePRD} from '../server/workspace-export';

const base='员工仅能查看本人采购申请。';
function candidate(key='query'):IntakeCandidate{return {key,title:'查询本人采购申请 '+key,origin:'材料要求',granularity:'具体',rationale:'一个独立查询结果',coverageGaps:[],fields:Object.fromEntries(FIELDS.map(([k])=>[k,base])) as Fields,sourceIds:['m'],evidence:Object.fromEntries(FIELDS.map(([k])=>[k,[{materialId:'m',quote:base}]])),assessment:'可确认',issues:[],aiSupplements:{exception:{text:'查询失败时保留筛选条件，并提供重试。',reason:'材料要求查询，但没有说明失败时如何恢复。',evidence:[{materialId:'m',quote:base}]},quality:{text:'建议在 2 秒内返回结果。',reason:'响应时限材料尚未定案，供业务考虑。'}}};}
function setup(candidates=[candidate()]){const p=createProject('AI 字段来源验收');p.materials=[{id:'m',name:'访谈纪要',kind:'调研访谈',location:'第1段',text:base,status:'待整理',cardIds:[],createdAt:'now'}];return {p,batch:attachIntakeBatch(p,candidates,['m'])};}
function action(batch:IntakeBatch,importSelected=true):Extract<Action,{type:'saveIntake'}>{return {type:'saveIntake',batchId:batch.id,revision:batch.revision,drafts:batch.drafts.map(d=>({id:d.id,title:d.title,fields:structuredClone(d.fields),selected:d.selected,exclusionReason:d.exclusionReason,coverageGaps:[...d.coverageGaps],...(d.aiReviews?{aiReviews:structuredClone(d.aiReviews)}:{})})),importSelected};}
function choose(batch:IntakeBatch){const d=batch.drafts[0];const reviews=decideAIField(d,'exception','保留');d.aiReviews=decideAIField({...d,aiReviews:reviews},'quality','删除');}

test('材料事实与 AI 分析有独立结构；AI 不能伪造人工选择或来源',()=>{
 const {p}=setup(),raw=candidate();const [parsed]=validateIntakeCandidates({cards:[raw]},p.materials,[]);
 assert.equal(parsed.fields.exception,base);assert.match(parsed.aiSupplements!.exception!.text,/重试/);assert.equal(parsed.evidence.exception![0].quote,base);
 assert.throws(()=>validateIntakeCandidates({cards:[{...raw,aiReviews:{exception:{decision:'保留'}}}]},p.materials,[]),/固定结构/);
 const invalid=structuredClone(raw);invalid.aiSupplements!.exception!.evidence![0].quote='材料要求两秒内返回';
 assert.throws(()=>validateIntakeCandidates({cards:[invalid]},p.materials,[]),/原文/);
 const mixed=structuredClone(raw);mixed.fields.quality='建议2秒完成';delete mixed.evidence.quality;
 assert.throws(()=>validateIntakeCandidates({cards:[mixed]},p.materials,[]),/缺少原文依据/);
});

test('仅保存草稿允许待选择；任何一项 AI 未决定都禁止入池且保持原项目',()=>{
 const {p,batch}=setup();applyAction(p,action(batch,false),'pm');assert.equal(p.cards.length,0);assert.equal(pendingAIFields(batch.drafts[0]).length,2);
 const before=structuredClone(p);assert.throws(()=>applyAction(p,action(batch),'pm'),/2 项 AI 分析补充/);assert.deepEqual(p,before);
 const a=action(batch);a.drafts[0].aiReviews=decideAIField(batch.drafts[0],'exception','保留');assert.throws(()=>applyAction(p,a,'pm'),/1 项 AI 分析补充/);assert.deepEqual(p,before);
 assert.throws(()=>applyAction(p,a,'business'),/权限/);assert.deepEqual(p,before);
});

test('保留才合入正式字段且标 AI 来源；删除不伤材料内容，不进入原型和 PRD',()=>{
 const {p,batch}=setup();choose(batch);const retained=batch.drafts[0].aiSupplements!.exception!.text,rejected=batch.drafts[0].aiSupplements!.quality!.text;
 applyAction(p,action(batch),'pm');const c=p.cards[0];assert.equal(c.fields.exception,base+'\n'+retained);assert.equal(c.fields.quality,base);
 assert.equal(c.provenance.exception[0].quote,base);assert.equal(currentAIOrigin(c,'exception')!.text,retained);assert.equal(currentAIOrigin(c,'quality'),undefined);
 assert.deepEqual(c.approvals,{});assert.deepEqual(c.confirmations,[]);assert.equal(p.phase,'可讨论');
 assert.ok(!JSON.stringify(demoInput(p)).includes(rejected));assert.ok(JSON.stringify(demoInput(p)).includes(retained));
 assert.ok(!buildMarkdown(p).includes(retained));const preview=buildMarkdown(p,[c]);assert.match(preview,/AI 分析补充（产品经理已选择保留）/);assert.ok(!preview.includes(rejected));
 const exported=workspacePRD(p);assert.equal(exported.formal,false);assert.match(exported.markdown,/AI 分析补充（产品经理已选择保留）/);assert.ok(!exported.markdown.includes(rejected));
 applyAction(p,{type:'pmConfirm',cardId:c.id},'pm');applyAction(p,{type:'businessConfirm',cardId:c.id,result:'通过',comment:'核对业务规则'},'business');assert.match(buildMarkdown(p),/AI 分析补充（产品经理已选择保留）/);
 const fields={...c.fields,exception:'人工重新确定的恢复规则'};applyAction(p,{type:'editCard',cardId:c.id,fields,title:c.title,reason:'调整恢复方式'},'pm');assert.equal(currentAIOrigin(c,'exception'),undefined);assert.ok(c.aiOrigins?.exception);
});

test('改 AI 建议或材料字段后原选择失效，不能沿用旧决定入池',()=>{
 for(const change of ['suggestion','base'] as const){const {p,batch}=setup();choose(batch);const a=action(batch);if(change==='suggestion')a.drafts[0].aiReviews!.exception!.text='失败时自动重试三次';else a.drafts[0].fields.exception='人工补充另一项事实';
 const before=structuredClone(p);assert.throws(()=>applyAction(p,a,'pm'),/AI 分析补充未处理/);assert.deepEqual(p,before);
 a.importSelected=false;applyAction(p,a,'pm');assert.equal(aiReviewFor(batch.drafts[0],'exception')!.decision,undefined);assert.equal(batch.drafts[0].aiReviews!.exception!.decision,undefined);
 }
});

test('选中子卡也必须处理父概要的 AI 补充；未入池的其他卡不强制处理',()=>{
 const parent={...candidate('overview'),granularity:'概要' as const,coverageGaps:['后续扩展范围']};const child={...candidate('child'),parentKey:parent.key,aiSupplements:{}};
 const {p,batch}=setup([parent,child]);const a=action(batch);a.drafts[0].selected=false;assert.throws(()=>applyAction(p,a,'pm'),/AI 分析补充未处理/);
 const isolated=setup([candidate('later'),{...candidate('ready'),aiSupplements:{}}]);const b=action(isolated.batch);b.drafts[0].selected=false;applyAction(isolated.p,b,'pm');assert.equal(isolated.p.cards.length,1);assert.match(isolated.p.cards[0].title,/ready/);
});

test('旧版整卡建议也拆开标记，空 aiSupplements 不能绕过逐字段确认',()=>{
 for(const explicit of [false,true]){const old={...candidate('legacy'),origin:'建议补充' as const,evidence:{},aiSupplements:explicit?{}:undefined};const {p,batch}=setup([old]);assert.equal(pendingAIFields(batch.drafts[0]).length,9);assert.match(batch.drafts[0].fields.permission,/待明确/);const a=action(batch);a.drafts[0].selected=true;assert.throws(()=>applyAction(p,a,'pm'),/AI 分析补充未处理/);assert.equal(p.cards.length,0);}
});

test('明确删除仅删建议；待明确占位不补造事实；包含事实的待明确描述不会被覆盖',()=>{
 const {batch}=setup();const d=batch.drafts[0];d.aiReviews=decideAIField(d,'exception','删除');assert.equal(resolvedIntakeFields(d).exception,base);
 d.fields.exception='待明确：材料未明确异常处理。';d.aiReviews=decideAIField(d,'exception','删除');assert.equal(resolvedIntakeFields(d).exception,d.fields.exception);
 d.aiReviews=decideAIField(d,'exception','保留');assert.equal(resolvedIntakeFields(d).exception,d.aiSupplements!.exception!.text);
 d.fields.exception='待明确：失败提示文案。材料规定失败时不得清空数据。';d.aiReviews=decideAIField(d,'exception','保留');assert.ok(resolvedIntakeFields(d).exception.includes('不得清空数据'));
});

test('不能伪造新的 AI 字段或覆盖来源元数据；已经入池的选择不能修改',()=>{
 const {p,batch}=setup();let a=action(batch,false);a.drafts[0].aiReviews={goal:{text:'其他内容',decision:'保留',reviewedText:'其他内容',reviewedBase:base}};assert.throws(()=>applyAction(p,a,'pm'),/不存在的 AI 补充/);
 a=action(batch);Object.assign(a.drafts[0],{aiSupplements:{}});assert.equal(actionSchema.safeParse(a).success,false);
 choose(batch);applyAction(p,action(batch),'pm');a=action(batch,false);a.drafts[0].aiReviews!.exception!.decision='删除';assert.throws(()=>applyAction(p,a,'pm'),/已入池卡片/);
});

test('概要细化保留原人工选择，新子卡独立标 AI 且不继承确认',()=>{
 const parent={...candidate('parent'),granularity:'概要' as const,coverageGaps:['异常路径待细化']};const {p,batch}=setup([parent]);choose(batch);const d=batch.drafts[0],before=structuredClone(d.aiReviews);
 attachIntakeRefinement(p,batch.id,d.id,[{...parent,key:d.id},{...candidate('child'),parentKey:d.id}],batch.revision);
 assert.deepEqual(d.aiReviews,before);assert.equal(batch.drafts[1].aiReviews,undefined);assert.equal(pendingAIFields(batch.drafts[1]).length,2);assert.equal(p.cards.length,0);
});
