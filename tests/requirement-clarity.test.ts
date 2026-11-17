import test from 'node:test';
import assert from 'node:assert/strict';
import {hasUnresolvedContent} from '../shared/requirement-clarity';
import {cardStatus,FIELDS,type Fields} from '../shared/types';
import {getChatDisabledReason} from '../shared/chat-policy';
import {addExtractedCards,applyAction,attachSuggestion,createProject} from '../server/domain';
import {validateSuggestionDraft} from '../server/ai';
import {resolutionDisabledReason} from '../shared/resolution-policy';

test('明确的待确认流程状态不会遮蔽同一字段中的待澄清规则',()=>{
 for(const text of ['提交后状态为“待确认”。','处于待确认状态时允许撤销。','待确认时可撤销，对方不能再接受。','个人中心可查看待确认、已同意、已交换及相关终止状态；站内提醒失败仍可查看记录。','按已同意、待确认筛选邀请。','流程：待确认→已同意→已交换。'])assert.equal(hasUnresolvedContent(text),false,text);
 for(const text of ['', '待确认','时限待确认','待确认时间','状态待确认','状态为“待确认”，到期处理待确认。','待确认状态下的撤销规则待明确。','范围待确认，已安排会议。','可查看待确认、已同意；保存时限待确认。'])assert.equal(hasUnresolvedContent(text),true,text);
});

test('预约状态可以形成有依据的建议，采纳和人工确认与前端校验一致',()=>{
 const p=createProject('预约状态校验');
 const fields=Object.fromEntries(FIELDS.map(([key,label])=>[key,`${label}已有明确业务规则`])) as Fields;
 fields.flow='待明确：取消和重复邀请如何处理';
 addExtractedCards(p,[{title:'预约邀请',fields,sourceIds:['crm-kickoff'],assessment:'待澄清',issues:[],evidence:{}}],['crm-kickoff']);
 const c=p.cards[0];
 applyAction(p,{type:'addBlocker',cardId:c.id,field:'flow',reason:'取消和重复邀请规则不清楚'},'pm','pm');
 const after='提交后状态为“待确认”；待确认时允许撤销，撤销后对方不能再接受。同一时段重复提交回到原有效邀请。可查看待确认、已同意、已交换及相关终止状态。';
 applyAction(p,{type:'message',cardId:c.id,text:after},'business','business-operations');
 const evidence=[{messageId:c.messages.at(-1)!.id,quote:after}];
 const draft=validateSuggestionDraft({summary:'按会务意见补充取消和重复邀请规则，待产品采纳',issues:[],changes:[{field:'flow',before:fields.flow,after,reason:'会务明确执行规则',evidence}],problemResolutions:[{blockerId:c.blockers[0].id,resolution:after,evidence,requiredFields:['flow'],requiredRoles:['business']}]},c,p.materials);
 attachSuggestion(p,c.id,draft,c.revision,c.messages.length);
 assert.equal(c.fields.flow,fields.flow);
 assert.equal(c.blockers[0].resolved,false);
 assert.equal(resolutionDisabledReason(c,c.suggestion!.problemResolutions![0],{flow:'采纳'}),'');
 applyAction(p,{type:'applySuggestion',cardId:c.id,suggestionId:c.suggestion!.id,decisions:{flow:'采纳'},resolvedBlockerIds:[c.blockers[0].id]},'pm','pm');
 assert.equal(cardStatus(c),'可确认');
 assert.equal(getChatDisabledReason('pmConfirm',{project:p,card:c,role:'pm',participantId:'pm'}),'');
 applyAction(p,{type:'pmConfirm',cardId:c.id},'pm','pm');
 applyAction(p,{type:'businessConfirm',cardId:c.id,result:'通过',comment:'同意'},'business','business');
 assert.equal(cardStatus(c),'已确认');
 applyAction(p,{type:'editCard',cardId:c.id,title:c.title,fields:{...c.fields,flow:after+' 过期时限待确认。'},reason:'时限仍需业务补充'},'pm','pm');
 assert.equal(cardStatus(c),'待澄清');
 assert.match(getChatDisabledReason('pmConfirm',{project:p,card:c,role:'pm'}),/仍待明确/);
 assert.throws(()=>applyAction(p,{type:'pmConfirm',cardId:c.id},'pm','pm'),/未知内容|仍待明确/);
});
