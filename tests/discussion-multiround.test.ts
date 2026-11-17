import test from 'node:test';import assert from 'node:assert/strict';
import {discussionReplayProject} from './fixtures/discussion-replay';
import {applyAction,attachSuggestion} from '../server/domain';
import {attachDiscussion,validateDiscussion} from '../server/discussion';
import {validatedEvidence} from '../server/ai';
import {discussionMessages} from '../server/discussion-context';
import {discussionBasis,latestHumanMessage,waitingQuestion} from '../shared/discussion';
import {getChatDisabledReason} from '../shared/chat-policy';
import {cardStatus,type DiscussionAnalysis,type FollowUp} from '../shared/types';
import {PARTICIPANTS,type ParticipantId} from '../shared/participants';
const quiet:DiscussionAnalysis={handling:{mode:'quiet',trigger:'none',reason:''},answer:null,question:null,summarize:false};
function harness(){const {p,c}=discussionReplayProject();return {p,c,
 say(person:ParticipantId,text:string,replyTo?:string){const role=PARTICIPANTS.find(p=>p.id===person)!.role;applyAction(p,{type:'message',cardId:c.id,text,...(replyTo?{replyTo}:{})},role,person);return latestHumanMessage(c)!;},
 apply(raw:DiscussionAnalysis){const before=structuredClone({fields:c.fields,approvals:c.approvals,revision:c.revision});const once=validateDiscussion(raw,c);assert.deepEqual(validateDiscussion(once,c),once,'重复校验必须一致');assert.equal(attachDiscussion(p,c.id,once,discussionBasis(p,c)),true);assert.ok((c.followUps||[]).filter(q=>q.status==='waiting'&&q.baseRevision===c.revision).length<=1,'至多一个当前追问');assert.deepEqual({fields:c.fields,approvals:c.approvals,revision:c.revision},before,'讨论不自动改正文或审批');return once;}};}
const inclusion:NonNullable<DiscussionAnalysis['question']>={field:'scope',question:'本期是否纳入购买平台占位按钮？',options:['本期纳入，在申领页展示占位按钮','本期不纳入，暂不添加该按钮'],role:'pm',participantId:'pm'};

test('连续九轮：提出诉求→他人插话→短答否决→撤回→再次作答→更正决定，始终保留准确历史',()=>{
 const h=harness();h.say('business-operations','能不能加一个购买平台的按钮');h.apply({answer:null,question:inclusion,summarize:false});const q=waitingQuestion(h.c)!;
 h.say('business-sales','可以');h.apply(quiet);assert.equal(q.status,'waiting');
 const no=h.say('pm','@Agent 不要加入');h.apply(quiet);assert.equal(q.answerMessageId,no.id);assert.equal(waitingQuestion(h.c),undefined);
 h.say('business-operations','我不同意，我觉得应该加入');h.apply(quiet);assert.equal(q.answerMessageId,no.id,'异议不能撤回别人的决定');
 const withdraw=h.say('pm','我撤回刚才不加入购买平台按钮的决定，暂时没想好');h.apply({...quiet,reopenQuestion:{questionId:q.id,messageId:withdraw.id,quote:withdraw.text}});
 assert.equal(q.status,'waiting');assert.equal(q.answerMessageId,undefined);assert.equal(q.answerHistory?.[0].messageId,no.id);assert.equal(cardStatus(h.c),'待澄清');assert.match(getChatDisabledReason('pmConfirm',{project:h.p,card:h.c,role:'pm'}),/关键问题/);
 assert.throws(()=>validateDiscussion({answer:{questionId:q.id,messageId:no.id,quote:no.text},question:null,summarize:false},h.c),/回答必须/);
 assert.throws(()=>validatedEvidence({messageId:no.id,quote:no.text},[],h.c),/已撤回/);
 assert.equal(discussionMessages(h.c).find(m=>m.id===no.id)?.answerState,'withdrawn');
 h.say('business-sales','同意');h.apply(quiet);assert.equal(q.status,'waiting');
 const yes=h.say('pm','第一个');h.apply(quiet);assert.equal(q.status,'answered');assert.equal(q.answerMessageId,yes.id);
 const change=h.say('pm','我改主意了，撤回刚才纳入按钮的答复，改为本期不加入',q.id);
 h.apply({reopenQuestion:{questionId:q.id,messageId:change.id,quote:change.text},answer:{questionId:q.id,messageId:change.id,quote:change.text},question:null,summarize:false});
 assert.equal(q.status,'answered');assert.equal(q.answerMessageId,change.id);assert.equal(q.answerHistory?.length,2);assert.equal(waitingQuestion(h.c),undefined);
 h.say('business-sales','谢谢');h.apply(quiet);assert.equal(q.answerMessageId,change.id);
});

test('连续八轮：切换话题暂缓→回答新问题→恢复原题→旧答案不得复用→本人定向回答',()=>{
 const h=harness();h.say('business-operations','提交按钮想改成红色');const color={...inclusion,field:'quality' as const,question:'赵凯，更醒目的按钮希望怎样调整？',options:['保持蓝色并增大尺寸','改为红色再比较效果'],role:'business' as const,participantId:'business-operations' as const};h.apply({answer:null,question:color,summarize:false});const old=waitingQuestion(h.c)!;
 h.say('business-sales','我不喜欢红色');h.apply(quiet);assert.equal(old.status,'waiting');
 const next=h.say('pm','先讨论本期是否纳入购买平台按钮');h.apply({deferQuestion:{questionId:old.id,sourceMessageId:next.id,reason:'从按钮视觉调整转向购买平台按钮本期范围'},replyRequest:{participantId:'pm',purpose:'scope'},answer:null,question:inclusion,summarize:false});const scope=waitingQuestion(h.c)!;assert.equal(old.status,'deferred');
 const answer=h.say('pm','不');h.apply(quiet);assert.equal(scope.answerMessageId,answer.id);assert.equal(waitingQuestion(h.c),undefined);
 h.say('business-operations','继续刚才按钮颜色的问题');h.apply({answer:null,question:color,summarize:false});assert.equal(waitingQuestion(h.c)?.id,old.id,'恢复同一暂缓问题，不制造重复记录');assert.equal(h.c.followUps?.length,2);
 h.say('business','保持蓝色并增大尺寸');h.apply(quiet);assert.equal(old.status,'waiting','同角色其他人不能抢答');
 const choice=h.say('business-operations','第一个',old.id);h.apply(quiet);assert.equal(old.answerMessageId,choice.id);assert.equal(waitingQuestion(h.c),undefined);
 h.say('pm','收到');h.apply(quiet);assert.equal(old.status,'answered');
});

test('多人规则冲突由业务负责人答复，产品支持和业务同角色插话都不能代答',()=>{
 const h=harness();h.say('business-operations','购买月份必须填写，否则没法安排');h.say('business-sales','我认为选填，别阻止提交');
 const q={field:'flow' as const,question:'陈敏，购买月份应按哪种业务口径统一？',options:['必填，未选择不可提交','选填，未选择可以提交'],role:'business' as const,participantId:'business' as const};
 h.apply({replyRequest:{participantId:'business',purpose:'business_conflict'},answer:null,question:q,summarize:false});const pending=waitingQuestion(h.c)!;
 const pm=h.say('pm','我支持选填');assert.throws(()=>validateDiscussion({answer:{questionId:pending.id,messageId:pm.id,quote:pm.text},question:null,summarize:false},h.c),/被询问人员/);h.apply(quiet);
 const sales=h.say('business-sales','选填');assert.throws(()=>validateDiscussion({answer:{questionId:pending.id,messageId:sales.id,quote:sales.text},question:null,summarize:false},h.c),/被询问人员/);h.apply(quiet);
 const owner=h.say('business','选填');h.apply(quiet);assert.equal(pending.status,'answered');assert.equal(pending.answerMessageId,owner.id);
 const objection=h.say('business-operations','我撤回刚才选填的决定，必须必填');assert.throws(()=>validateDiscussion({...quiet,reopenQuestion:{questionId:pending.id,messageId:objection.id,quote:objection.text}},h.c),/原答复人/);assert.equal(pending.answerMessageId,owner.id);
});

test('不接受提问前、重新开启前、不是连续原文或已经被后续更正的旧证据',()=>{
 const h=harness();h.say('business-operations','想增加一个按钮');h.apply({answer:null,question:inclusion,summarize:false});const q=waitingQuestion(h.c)!;
 const early=h.say('pm','不，加入');early.createdAt='2000-01-01T00:00:00Z';assert.throws(()=>validateDiscussion({answer:{questionId:q.id,messageId:early.id,quote:'不加入'},question:null,summarize:false},h.c),/回答必须/);
 const first=h.say('pm','暂时不确定');h.say('pm','我还需要先看演示');assert.throws(()=>validateDiscussion({answer:{questionId:q.id,messageId:first.id,quote:first.text},question:null,summarize:false},h.c),/更新的发言/);
});

test('含糊短答不得结束追问；原问题必须随不带replyTo的正式答复传到后续生成上下文',()=>{
 const h=harness();h.say('business-operations','增加购买平台按钮');h.apply({answer:null,question:inclusion,summarize:false});const q=waitingQuestion(h.c)!;
 for(const text of ['没想好','@Agent 暂时没想好','再看看','不清楚']){const m=h.say('pm',text);h.apply({answer:{questionId:q.id,messageId:m.id,quote:m.text},question:null,summarize:false});assert.equal(q.status,'waiting');}
 const m=h.say('pm','不');h.apply(quiet);const context=discussionMessages(h.c).find(x=>x.id===m.id)!;assert.equal(context.replyContext?.question,q.question);assert.deepEqual(context.replyContext?.options,q.options);assert.equal(q.status,'answered');
});

test('更正一条旧答复时暂缓另一等待问题；完成更正后原待答问题仍保留，不能假装全卡确认',()=>{
 const h=harness();h.say('business-operations','增加购买平台按钮');h.apply({answer:null,question:inclusion,summarize:false});const first=waitingQuestion(h.c)!;
 h.say('pm','不');h.apply(quiet);
 h.say('business-operations','提交按钮希望更醒目');h.apply({answer:null,question:{...inclusion,field:'quality',question:'提交按钮准备采用什么颜色？',options:['保持蓝色','改为红色']},summarize:false});const second=waitingQuestion(h.c)!;
 const m=h.say('pm','我改变主意了，之前的答复作废，需要重新考虑购买平台按钮',first.id);h.apply({...quiet,reopenQuestion:{questionId:first.id,messageId:m.id,quote:m.text}});
 assert.equal(first.status,'waiting');assert.equal(second.status,'deferred');h.say('pm','本期不纳入，暂不添加该按钮');h.apply(quiet);assert.equal(first.status,'answered');assert.equal(second.status,'deferred');assert.equal(waitingQuestion(h.c),undefined);assert.equal(cardStatus(h.c),'待澄清');
});

test('同题在新修订可重新追问，已确认旧答复不能越过新追问的时间界限',()=>{
 const h=harness();h.say('business-operations','增加购买平台按钮');h.apply({answer:null,question:inclusion,summarize:false});const old=waitingQuestion(h.c)!;const answer=h.say('pm','不');h.apply(quiet);
 h.c.revision++;h.say('business-operations','范围已改，重新讨论购买平台占位按钮');h.apply({answer:null,question:inclusion,summarize:false});const next=waitingQuestion(h.c)!;assert.notEqual(next.id,old.id);
 assert.throws(()=>validateDiscussion({answer:{questionId:next.id,messageId:answer.id,quote:answer.text},question:null,summarize:false},h.c),/回答必须/);
});

test('深入评估接受单字答复证据，但禁止同轮撤回的旧答复继续支持结论',async()=>{
 const {validateAssessment}=await import('../server/requirement-assessment');
 const h=harness();h.say('business-operations','增加购买平台按钮');h.apply({answer:null,question:inclusion,summarize:false});const q=waitingQuestion(h.c)!;const m=h.say('pm','不');h.apply(quiet);
 const report={conclusion:'本期不加入。',perspectives:[],alternatives:[],evidence:[{messageId:m.id,quote:'不'}],unresolved:[],coverage:'本轮问题与答复。'};
 assert.doesNotThrow(()=>validateAssessment({report,discussion:{answer:null,question:null,summarize:false}},h.p,h.c));
 const correction=h.say('pm','撤回刚才不加入的答复，重新考虑',q.id);
 assert.throws(()=>validateAssessment({report,discussion:{reopenQuestion:{questionId:q.id,messageId:correction.id,quote:correction.text},answer:null,question:null,summarize:false}},h.p,h.c),/本轮正在撤回/);
});

test('真实回放回归：撤回并明确改为另一个选项，模型漏记answer时自动补齐并结束追问',()=>{
 const h=harness();h.say('business-operations','增加购买平台按钮');h.apply({answer:null,question:inclusion,summarize:false});const q=waitingQuestion(h.c)!;
 h.say('pm','第一个');h.apply(quiet);const m=h.say('pm','我改主意了，撤回刚才纳入按钮的答复，改为本期不加入',q.id);
 h.apply({...quiet,reopenQuestion:{questionId:q.id,messageId:m.id,quote:m.text},reply:'已重新打开该问题，本期维持不加入。'});
 assert.equal(q.status,'answered');assert.equal(q.answerMessageId,m.id);assert.equal(waitingQuestion(h.c),undefined);assert.equal(q.answerHistory?.length,1);assert.match(h.c.messages.at(-1)!.text,/已更正为/);
});
