import test from 'node:test';
import assert from 'node:assert/strict';
import {createCRMExperience} from '../server/experience';
import {applyAction,attachSuggestion} from '../server/domain';
import {discussionBasis,waitingQuestion} from '../shared/discussion';
import {attachDiscussion,validateDiscussion} from '../server/discussion';
import {validateConversationRoute} from '../server/chat-routing';
import {assessmentAdditions,assessmentBasis,beginAssessment,finishAssessment,stopAssessment,validateAssessment} from '../server/requirement-assessment';
import type {AssessmentResult} from '../server/requirement-assessment';

export const evaluationFixture=():AssessmentResult=>({report:{conclusion:'建议明确原负责人交接后的访问边界，仍需业务决定。',perspectives:[{role:'analyst',opinion:'需明确旧链接的访问权限。',reason:'交接与访问规则需要一致。',fields:['permission']}],alternatives:[{option:'立即撤销访问',benefit:'权限边界清楚',cost:'原负责人无法继续查阅'}],evidence:[],unresolved:['旧链接何时失效？'],coverage:'本次参考当前需求字段和提供的讨论，未验证外部系统。'},discussion:{answer:null,question:{field:'permission',question:'交接完成后，原负责人是否仍能通过旧链接查看？',role:'business',participantId:'business',options:['立即撤销旧链接访问','保留30天只读']},summarize:false}});

test('轻量回复与复杂度判断一并校验，深评不能提前提问或给结论',()=>{
 const c=createCRMExperience().cards[0];
 const direct=validateDiscussion({handling:{mode:'direct',trigger:'none',reason:''},reply:'当前字段描述的是交接后的查看权限。',answer:null,question:null,summarize:false},c);
 assert.equal(direct.reply,'当前字段描述的是交接后的查看权限。');
 assert.throws(()=>validateDiscussion({...direct,handling:{mode:'deep',trigger:'none',reason:''}},c));
 const deep=validateDiscussion({...evaluationFixture().discussion,reply:'不应提前展示',handling:{mode:'deep',trigger:'conflict',reason:'交接与旧链接权限口径冲突'}},c);
 assert.equal(deep.reply,'');assert.equal(deep.question,null);assert.equal(deep.summarize,false);
 const quiet=validateDiscussion({...direct,handling:{mode:'quiet',trigger:'none',reason:''}},c);assert.equal(quiet.reply,'');
});

test('评估开始、更新与完成不改变字段、确认或字段建议的消息基线',()=>{
 const p=createCRMExperience(),c=p.cards[1];
 attachSuggestion(p,c.id,{summary:'既有待采纳建议',issues:[],changes:[]},c.revision,c.messages.length);
 const before=structuredClone({fields:c.fields,approvals:c.approvals,suggestion:c.suggestion,count:c.messages.length,phase:p.phase,version:p.version});
 const basis=assessmentBasis(p,c);beginAssessment(p,c,'job','比较两种处理方式',basis);beginAssessment(p,c,'job','比较两种处理方式',basis);
 assert.equal(c.assessments?.length,1);assert.equal(assessmentBasis(p,c),basis);
 finishAssessment(c,'job',evaluationFixture());
 assert.deepEqual({fields:c.fields,approvals:c.approvals,suggestion:c.suggestion,count:c.messages.length,phase:p.phase,version:p.version},before);
 assert.equal(c.assessments![0].status,'completed');
});

test('新消息、材料变化或其他需求的规则变化使评估依据过期',()=>{
 for(const change of ['message','material','card'] as const){
  const p=createCRMExperience(),c=p.cards[0],basis=assessmentBasis(p,c);
  if(change==='message')applyAction(p,{type:'message',cardId:c.id,text:'补充：旧链接需要立即撤销。'},'business');
  if(change==='material')p.materials[0].text+='新的规则';
  if(change==='card')p.cards[1].fields.permission+=' 新权限';
  assert.notEqual(assessmentBasis(p,c),basis);assert.equal(beginAssessment(p,c,'job','旧评估',basis),undefined);
 }
});

test('报告拒绝伪造、AI 和未采纳变更引用及重复专家角色',()=>{
 const p=createCRMExperience(),c=p.cards[0],result=evaluationFixture();
 result.report.evidence=[{messageId:'fake',quote:'并不存在的原文'}];assert.throws(()=>validateAssessment(result,p,c));
 c.messages.push({id:'agent-report',role:'agent',text:'不能替人决定',createdAt:new Date().toISOString()});result.report.evidence=[{messageId:'agent-report',quote:'不能替人决定'}];assert.throws(()=>validateAssessment(result,p,c));
 result.report.evidence=[];result.report.perspectives.push({...result.report.perspectives[0]});assert.throws(()=>validateAssessment(result,p,c),/视角只能/);
});

test('报告允许无分歧无追问，提问复用指定人员与单问题机制',()=>{
 const p=createCRMExperience(),c=p.cards[0],result=evaluationFixture();
 const valid=validateAssessment(result,p,c);beginAssessment(p,c,'job','权限联动',assessmentBasis(p,c));attachDiscussion(p,c.id,valid.discussion,discussionBasis(p,c));finishAssessment(c,'job',valid);
 assert.equal(c.assessments![0].questionId,waitingQuestion(c)?.id);assert.equal(c.followUps?.length,1);
 const second=validateAssessment(evaluationFixture(),p,c);assert.equal(second.discussion.question,null);
 result.report.perspectives=[];result.report.alternatives=[];result.report.unresolved=[];result.discussion.question=null;
 assert.equal(validateAssessment(result,p,c).report.perspectives.length,0);
});

test('业务展示转换字段英文键，原文引用保持原样',()=>{
 const p=createCRMExperience(),c=p.cards[0],result=evaluationFixture();
 c.messages.push({id:'human-keys',role:'business',text:'permission 要跟 flow 保持一致。',createdAt:new Date().toISOString()});
 result.report.conclusion='permission 与 flow 需要一起明确。';result.report.perspectives[0].opinion='检查 acceptance。';result.report.evidence=[{messageId:'human-keys',quote:'permission 要跟 flow 保持一致。'}];
 const validated=validateAssessment(result,p,c);assert.equal(validated.report.conclusion,'权限规则 与 功能与流程 需要一起明确。');assert.equal(validated.report.perspectives[0].opinion,'检查 验收条件。');assert.equal(validated.report.evidence[0].quote,'permission 要跟 flow 保持一致。');
 assert.deepEqual(validateAssessment(validated,p,c),validated,'服务端补充来源位置后再次校验必须通过');
 validated.report.evidence[0].location='伪造来源位置';assert.notEqual(validateAssessment(validated,p,c).report.evidence[0].location,'伪造来源位置');
});

test('失败评估保留资料，过期评估可由同一任务更新而不重复插入',()=>{
 const p=createCRMExperience(),c=p.cards[0],original=structuredClone(c.messages);
 beginAssessment(p,c,'job','范围取舍',assessmentBasis(p,c));stopAssessment(c,'job','superseded');assert.equal(c.assessments![0].status,'superseded');
 beginAssessment(p,c,'job','结合新讨论',assessmentBasis(p,c));assert.equal(c.assessments?.length,1);assert.equal(c.assessments![0].status,'running');
 stopAssessment(c,'job','failed','模型暂不可用');assert.equal(c.assessments![0].error,'模型暂不可用');assert.deepEqual(c.messages,original);
});

test('直接对话必须有回复，复杂路由的临时结论不提前显示',()=>{
 const p=createCRMExperience(),c=p.cards[0],base={reply:'临时结论',clarifiesCurrent:false,evidence:[],relatedCardIds:[],cards:[]};
 const result=validateConversationRoute({...base,handling:{mode:'deep',trigger:'tradeoff',reason:'范围和操作成本需要取舍'}},p,c,[],false);assert.equal(result.reply,'');
 assert.throws(()=>validateConversationRoute({...base,reply:''},p,c,[],false));
 const direct=validateConversationRoute({...base,question:evaluationFixture().discussion.question},p,c,[],false);assert.equal(direct.question?.participantId,'business');assert.equal(direct.clarifiesCurrent,false);
});


test('只允许追加的普通聊天进入相关性判断，业务状态与历史编辑保留严格校验',()=>{
 const p=createCRMExperience(),c=p.cards[0],next=structuredClone(p),current=next.cards[0];
 applyAction(next,{type:'message',cardId:c.id,text:'今天天气怎么样？'},'business');
 assert.equal(assessmentAdditions(p,c,next,current)?.length,1);
 current.messages[0].text+='已编辑';assert.equal(assessmentAdditions(p,c,next,current),null);
 current.messages[0]=structuredClone(c.messages[0]);current.fields.scope+='新范围';assert.equal(assessmentAdditions(p,c,next,current),null);
 current.fields.scope=c.fields.scope;current.messages.at(-1)!.materialIds=['new-file'];assert.equal(assessmentAdditions(p,c,next,current),null);
});
