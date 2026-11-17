import test from 'node:test';
import assert from 'node:assert/strict';
import {PARTICIPANTS,personLabel,type ParticipantId} from '../shared/participants';
import {createCRMExperience} from '../server/experience';
import {applyAction,addExtractedCards,createProject} from '../server/domain';
import {attachDiscussion,validateDiscussion} from '../server/discussion';
import {discussionBasis,waitingQuestion} from '../shared/discussion';
import {getChatDisabledReason} from '../shared/chat-policy';
import {FIELDS,type Fields} from '../shared/types';

test('一个产品和三位业务拥有独立身份，同角色发言不会覆盖作者',()=>{
 assert.equal(PARTICIPANTS.length,4);
 assert.deepEqual([...new Set(PARTICIPANTS.map(p=>p.role))],['pm','business']);
 const p=createCRMExperience(),c=p.cards[0],before=structuredClone(c.fields);
 for(const participantId of ['business','business-sales','business-operations'] as const){
  applyAction(p,{type:'message',cardId:c.id,text:'补充本人负责的业务边界。'},'business',participantId);
  assert.equal(c.messages.at(-1)?.participantId,participantId);
  assert.equal(p.events.at(-1)?.participantId,participantId);
 }
 assert.deepEqual(c.messages.slice(-3).map(personLabel),['陈敏 · 业务负责人','李雯 · 招商业务','赵凯 · 会务业务']);
 assert.deepEqual(c.fields,before);
 assert.throws(()=>applyAction(p,{type:'message',cardId:c.id,text:'伪造产品身份'},'pm','business-sales'),/人员与角色不匹配/);
});

test('Agent 定向追问具体业务人员，其他业务人员不能替他回答',()=>{
 const p=createCRMExperience(),c=p.cards[0];
 applyAction(p,{type:'message',cardId:c.id,text:'请明确招商业务的手机号交换规则。'},'pm','pm');
 attachDiscussion(p,c.id,{answer:null,question:{field:'permission',question:'客户同意前是否可以公开手机号码？',options:['同意后交换','直接公开'],role:'business',participantId:'business-sales'},summarize:false},discussionBasis(p,c));
 const q=waitingQuestion(c)!;
 assert.equal(q.participantId,'business-sales');
 assert.match(getChatDisabledReason('pmConfirm',{project:p,card:c,role:'pm',participantId:'pm'}),/等李雯回复/);
 assert.throws(()=>applyAction(p,{type:'message',cardId:c.id,text:'同意后交换',replyTo:q.id},'business','business-operations'),/追问已更新/);
 applyAction(p,{type:'message',cardId:c.id,text:'同意后交换'},'business','business-operations');
 const other=c.messages.at(-1)!;
 assert.throws(()=>validateDiscussion({answer:{questionId:q.id,messageId:other.id,quote:other.text},question:null,summarize:true},c),/被询问人员/);
 applyAction(p,{type:'message',cardId:c.id,text:'招商业务明确，接受邀请后才交换手机号。',replyTo:q.id},'business','business-sales');
 const answer=c.messages.at(-1)!;
 attachDiscussion(p,c.id,{answer:{questionId:q.id,messageId:answer.id,quote:answer.text},question:null,summarize:true},discussionBasis(p,c));
 assert.equal(q.status,'answered');assert.deepEqual(c.approvals,{});
 assert.throws(()=>validateDiscussion({answer:null,question:{field:'permission',question:'是否同意当前权限规则？',options:['同意','不同意'],role:'business',participantId:'pm'},summarize:false},c),/角色匹配/);
 assert.throws(()=>validateDiscussion({answer:null,question:{field:'permission',question:'是否同意当前权限规则？',options:['同意','不同意'],role:'reviewer'},summarize:false},c));
});

test('业务负责人统一确认，其他业务成员不能采纳或覆盖确认',()=>{
 const p=createProject('多人确认流程');
 const fields=Object.fromEntries(FIELDS.map(([key,label])=>[key,`${label}已经由业务明确`])) as Fields;
 addExtractedCards(p,[{title:'预约洽谈',fields,sourceIds:['crm-kickoff'],assessment:'可确认',issues:[],evidence:{}}],['crm-kickoff']);
 const c=p.cards[0];
 applyAction(p,{type:'pmConfirm',cardId:c.id},'pm','pm');
 for(const participantId of ['business-sales','business-operations'] as ParticipantId[]){
  assert.match(getChatDisabledReason('businessConfirm',{project:p,card:c,role:'business',participantId}),/业务负责人/);
  assert.throws(()=>applyAction(p,{type:'businessConfirm',cardId:c.id,result:'通过',comment:'同意'},'business',participantId),/业务负责人/);
  assert.match(getChatDisabledReason('applySuggestion',{project:p,card:c,role:'business',participantId}),/产品经理/);
 }
 applyAction(p,{type:'businessConfirm',cardId:c.id,result:'通过',comment:'统一业务口径'},'business','business');
 assert.equal(c.approvals.business?.participantId,'business');
 applyAction(p,{type:'submitReview'},'pm','pm');
 assert.throws(()=>applyAction(p,{type:'review',result:'通过',comment:''},'business','business-sales'),/业务负责人/);
 applyAction(p,{type:'review',result:'通过',comment:'范围与卡片一致'},'business','business');
 assert.equal(p.phase,'已明确');
});
