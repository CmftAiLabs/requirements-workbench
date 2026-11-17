import test from 'node:test';
import assert from 'node:assert/strict';
import {discussionReplayProject} from './fixtures/discussion-replay';
import {applyAction,attachSuggestion,completeNoopSuggestion} from '../server/domain';
import {attachDiscussion} from '../server/discussion';
import {discussionBasis,waitingLabel} from '../shared/discussion';
import {cardStatus,type Card} from '../shared/types';
import {getChatDisabledReason} from '../shared/chat-policy';
import {conclusionPresentation} from '../shared/conclusion-presentation';
import {liveSuggestion} from '../shared/crm-demo';
import {workspacePRD} from '../server/workspace-export';
import {demoInputKey,demoBasisKey} from '../server/demo-schema';
import {planDemoModules} from '../server/demo-modules';
import {appendDemo,reconcileDemo} from '../server/demo-jobs';

test('新旧空总结均不堵住人工确认，迁移只记录一次普通回应',()=>{
 const {p,c}=discussionReplayProject();
 attachSuggestion(p,c.id,{summary:'当前规则已一致，无需修改。',changes:[],issues:[]},c.revision,0);
 assert.equal(liveSuggestion(c),undefined);assert.equal(conclusionPresentation(c.suggestion!).actionable,false);
 assert.equal(getChatDisabledReason('pmConfirm',{project:p,card:c,role:'pm'}),'');
 assert.deepEqual(c.approvals,{});assert.equal(c.revision,1);
 assert.equal(completeNoopSuggestion(c),false);assert.equal(c.messages.length,1);
 c.suggestion!.status='待决定';c.messages=[];
 assert.equal(liveSuggestion(c),undefined);assert.equal(completeNoopSuggestion(c),true);
 assert.equal(completeNoopSuggestion(c),false);assert.equal(c.messages.length,1);
 applyAction(p,{type:'pmConfirm',cardId:c.id},'pm');
 applyAction(p,{type:'businessConfirm',cardId:c.id,result:'通过',comment:'人工核对完成'},'business');
 assert.equal(cardStatus(c),'已确认');
});

test('只有待核对事项时保留人工决定入口，不把问题当作空回应吞掉',()=>{
 const {p,c}=discussionReplayProject();
 attachSuggestion(p,c.id,{summary:'发现新的范围问题。',changes:[],issues:['是否允许代同事申领，需要业务明确。']},c.revision,0);
 assert.ok(liveSuggestion(c));assert.equal(conclusionPresentation(c.suggestion!).actionable,true);
 assert.match(getChatDisabledReason('pmConfirm',{project:p,card:c,role:'pm'}),/尚待决定/);
 assert.equal(c.blockers.length,0);
 applyAction(p,{type:'applySuggestion',cardId:c.id,suggestionId:c.suggestion!.id,decisions:{}},'pm');
 assert.equal(c.suggestion!.status,'已写入');assert.deepEqual(c.approvals,{});
});

test('确认后追问及未采纳建议保留原确认与正式PRD，人工采纳后才回退',()=>{
 const {p,c}=discussionReplayProject();
 applyAction(p,{type:'pmConfirm',cardId:c.id},'pm');
 applyAction(p,{type:'businessConfirm',cardId:c.id,result:'通过',comment:''},'business');
 applyAction(p,{type:'submitReview'},'pm');applyAction(p,{type:'review',result:'通过',comment:''},'business');
 const before=structuredClone(c),prd=workspacePRD(p).markdown;
 applyAction(p,{type:'message',cardId:c.id,text:'申领数量是否需要降低上限，先讨论。'},'pm');
 attachDiscussion(p,c.id,{answer:null,question:{field:'data',question:'本期申领数量上限是否改为十件？',options:['保留二十件','改为十件'],role:'business'},summarize:false},discussionBasis(p,c));
 assert.equal(cardStatus(c),'已确认');assert.match(waitingLabel(c),/回复/);
 assert.deepEqual(c.approvals,before.approvals);assert.equal(p.phase,'已明确');assert.equal(workspacePRD(p).markdown,prd);
 attachSuggestion(p,c.id,{summary:'建议调整为最多十件。',issues:[],changes:[{field:'data',before:c.fields.data,after:c.fields.data+' 每次申领最多十件。',reason:'待产品决定',evidence:[]}]},c.revision,c.messages.length);
 assert.equal(cardStatus(c),'已确认');assert.equal(workspacePRD(p).markdown,prd);
 applyAction(p,{type:'applySuggestion',cardId:c.id,suggestionId:c.suggestion!.id,decisions:{data:'不采纳'}},'pm');
 assert.deepEqual(c.fields,before.fields);assert.deepEqual(c.approvals,before.approvals);assert.equal(p.phase,'已明确');
 attachSuggestion(p,c.id,{summary:'产品同意本期调整。',issues:[],changes:[{field:'data',before:c.fields.data,after:c.fields.data+' 每次申领最多十件。',reason:'本轮决定',evidence:[]}]},c.revision,c.messages.length);
 applyAction(p,{type:'applySuggestion',cardId:c.id,suggestionId:c.suggestion!.id,decisions:{data:'采纳'}},'pm');
 assert.equal(p.phase,'可讨论');assert.deepEqual(c.approvals,{});assert.equal(workspacePRD(p).formal,false);
 assert.equal(p.snapshots.at(-1)!.markdown,prd);
});

test('未确认卡片的待答问题仍阻挡确认',()=>{
 const {p,c}=discussionReplayProject();
 applyAction(p,{type:'message',cardId:c.id,text:'业务范围还需要确认。'},'pm');
 attachDiscussion(p,c.id,{answer:null,question:{field:'scope',question:'本期是否包含其他部门申领？',options:['只含行政部','包括其他部门'],role:'business'},summarize:false},discussionBasis(p,c));
 assert.equal(cardStatus(c),'待澄清');assert.ok(getChatDisabledReason('pmConfirm',{project:p,card:c,role:'pm'}));
 assert.throws(()=>applyAction(p,{type:'pmConfirm',cardId:c.id},'pm'));
});

test('概要全部字段进入项目及模块更新依据，不得把旧产物标为已同步',()=>{
 const {p,c}=discussionReplayProject();
 const overview:Card={...structuredClone(c),id:'overview',granularity:'概要',title:'一期范围',coverageGaps:[]};
 c.parentId=overview.id;p.cards.unshift(overview);
 const original=planDemoModules(p);
 appendDemo(p,{id:'r1',artifactId:'original-artifact',number:1,createdAt:'now',inputKey:demoInputKey(p),basisKey:demoBasisKey(p),draft:false,summary:'旧原型',cardIds:[c.id],bindings:[],assumptions:[],checksPassed:1,sourceHash:'old',model:'fixture'});
 for(const field of ['goal','scope','constraint','permission','data'] as const){
  const next=structuredClone(p),parent=next.cards[0];
  applyAction(next,{type:'updateOverview',cardId:parent.id,title:parent.title,fields:{...parent.fields,[field]:parent.fields[field]+' 新的公共要求。'},coverageGaps:[],reason:'人工调整公共规则'},'pm');
  assert.notEqual(demoInputKey(next),demoInputKey(p));assert.notEqual(planDemoModules(next)[0].inputKey,original[0].inputKey);
  assert.equal(reconcileDemo(next),false);assert.equal(next.generatedDemo!.revisions.length,1);
 }
 assert.equal(reconcileDemo(p),true);
});
