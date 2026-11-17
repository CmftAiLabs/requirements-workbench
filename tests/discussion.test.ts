import test from 'node:test';
import assert from 'node:assert/strict';
import {createCRMExperience} from '../server/experience.ts';
import {applyAction} from '../server/domain.ts';
import {attachDiscussion,validateDiscussion} from '../server/discussion.ts';
import {discussionBasis,isRequirementUpdateRequest,latestHumanMessage,shouldListen,waitingLabel,waitingQuestion} from '../shared/discussion.ts';
import {demoUpdate,readDemoTrace,tracePayload} from '../shared/demo-trace.ts';
import {buildDemoHTML} from '../shared/project-demo.ts';
import {getChatDisabledReason} from '../shared/chat-policy.ts';
import {needsAttention} from '../shared/card-organization.ts';
import type {DiscussionAnalysis} from '../shared/types.ts';

const question:DiscussionAnalysis={answer:null,question:{field:'permission',question:'交接完成后，原负责人是否还可以查看客户详情？',options:['立即撤销访问','保留30天只读'],role:'business'},summarize:false};

test('只读提问中的否定更新指令不触发需求或原型草稿',()=>{
 for(const text of ['@Agent 请解释数量规则，不要修改需求或生成原型。','先只解释材料，不生成修改建议。','@Agent 暂不更新原型，请回答验收条件。','@Agent 无需自动整理需求字段。','要不要更新原型？'])assert.equal(isRequirementUpdateRequest(text),false,text);
 for(const text of ['@Agent 请根据讨论更新需求字段和原型。','不要修改需求，但请更新原型。','无需真实登录，请生成原型。'])assert.equal(isRequirementUpdateRequest(text),true,text);
});
function asked(){const p=createCRMExperience(),c=p.cards[0];applyAction(p,{type:'message',cardId:c.id,text:'交接后权限如何处理，还没有完全想清楚。'},'pm');attachDiscussion(p,c.id,question,discussionBasis(p,c));return {p,c,q:waitingQuestion(c)!};}

test('主动追问只记录会话，不修改正文、确认、阶段与版本',()=>{
 const p=createCRMExperience(),c=p.cards[0];const before=structuredClone({fields:c.fields,approvals:c.approvals,phase:p.phase,version:p.version,revision:c.revision,blockers:c.blockers});
 assert.equal(attachDiscussion(p,c.id,question,discussionBasis(p,c)),true);
 assert.deepEqual({fields:c.fields,approvals:c.approvals,phase:p.phase,version:p.version,revision:c.revision,blockers:c.blockers},before);
 assert.equal(waitingLabel(c,'business'),'等你补充');assert.match(waitingLabel(c,'pm'),/陈敏/);
 assert.equal(shouldListen(p,c),false);
});
test('等待时不重复追问，不把其他角色和伪造引用当成回答',()=>{
 const {p,c,q}=asked();applyAction(p,{type:'message',cardId:c.id,text:'立即撤销访问'},'reviewer');const message=latestHumanMessage(c)!;
 assert.throws(()=>validateDiscussion({answer:{questionId:q.id,messageId:message.id,quote:message.text},question:null,summarize:true},c),/被询问人员/);
 const result=validateDiscussion({...question,summarize:true},c);assert.equal(result.question,null);assert.equal(result.summarize,false);
 attachDiscussion(p,c.id,result,discussionBasis(p,c));assert.equal(c.followUps?.length,1);
 applyAction(p,{type:'message',cardId:c.id,text:'我还不知道'},'business');assert.throws(()=>validateDiscussion({answer:{questionId:q.id,messageId:latestHumanMessage(c)!.id,quote:'立即撤销访问'},question:null,summarize:true},c));
});
test('定向回答记为已回复，仍不代表采纳或确认',()=>{
 const {p,c,q}=asked();applyAction(p,{type:'message',cardId:c.id,text:'立即撤销访问',replyTo:q.id},'business');const message=latestHumanMessage(c)!;
 attachDiscussion(p,c.id,{answer:{questionId:q.id,messageId:message.id,quote:message.text},question:null,summarize:true},discussionBasis(p,c));
 assert.equal(q.status,'answered');assert.equal(q.answerMessageId,message.id);assert.equal(waitingQuestion(c),undefined);assert.deepEqual(c.approvals,{});assert.equal(c.revision,1);
 assert.throws(()=>applyAction(p,{type:'message',cardId:c.id,text:'另一个回答',replyTo:q.id},'business'),/追问已更新/);
});
test('新消息或人工决定使旧分析失效，旧结果不能覆盖最新讨论',()=>{
 const {p,c}=asked(),basis=discussionBasis(p,c);applyAction(p,{type:'message',cardId:c.id,text:'补充一个新边界条件'},'business');const before=structuredClone(p);
 assert.equal(attachDiscussion(p,c.id,question,basis),false);assert.deepEqual(p,before);
 const approvedBasis=discussionBasis(p,c);c.approvals.pm={id:'pm-test',role:'pm',revision:c.revision,round:c.round,result:'通过',comment:'人工核对',createdAt:new Date().toISOString()};assert.equal(attachDiscussion(p,c.id,question,approvedBasis),false);
});
test('新版需求与排除项不沿用旧等待状态；闲聊不触发模型',()=>{
 const {p,c}=asked();c.revision++;assert.equal(waitingQuestion(c),undefined);c.revision--;c.included=false;assert.equal(waitingQuestion(c),undefined);assert.equal(shouldListen(p,c),false);c.included=true;
 applyAction(p,{type:'message',cardId:c.id,text:'收到，谢谢'},'pm');assert.equal(shouldListen(p,c),false);
});
test('关键问题待回答时不能确认，已确认卡片的新讨论仍出现在待处理列表',()=>{
 const p=createCRMExperience(),c=p.cards[1];
 applyAction(p,{type:'pmConfirm',cardId:c.id},'pm');
 applyAction(p,{type:'businessConfirm',cardId:c.id,result:'通过',comment:'演练核对'},'business');
 assert.equal(needsAttention(p,c),false);
 applyAction(p,{type:'message',cardId:c.id,text:'重试三次仍失败后，要不要自动告警？'},'pm');
 attachDiscussion(p,c.id,{...question,question:{...question.question!,field:'exception',question:'重试三次仍失败后，是否自动告警？'}},discussionBasis(p,c));
 assert.equal(needsAttention(p,c),true);assert.ok(c.approvals.business,'追问不替人撤销已有确认');
 c.approvals={};
 assert.match(getChatDisabledReason('pmConfirm',{project:p,card:c,role:'pm'}),/关键问题/);
 assert.throws(()=>applyAction(p,{type:'pmConfirm',cardId:c.id},'pm'),/关键问题/);
});
test('变化摘要区别建议草稿与已保存修订，不把初次预览当成九处变化',()=>{
 const p=createCRMExperience(),c=p.cards[0];assert.equal(demoUpdate(c).changes.length,0);
 const before=c.fields.permission;c.suggestion={id:'suggestion-demo',baseRevision:c.revision,messageCount:c.messages.length,summary:'建议立即撤权',issues:[],changes:[{field:'permission',before,after:'交接后立即撤销原负责人访问权限',reason:'业务意见',evidence:[]}],createdAt:new Date().toISOString(),status:'待决定'};
 assert.equal(demoUpdate(c).draft,true);assert.deepEqual(demoUpdate(c).changes.map(c=>c.field),['permission']);assert.equal(c.fields.permission,before);
 applyAction(p,{type:'applySuggestion',cardId:c.id,suggestionId:c.suggestion.id,decisions:{permission:'采纳'}},'pm');assert.equal(demoUpdate(c).draft,false);assert.equal(demoUpdate(c).changes[0].before,before);assert.equal(c.approvals.business,undefined);
});
test('原型消息只定位本项目具体卡，不接受越权卡片或任何确认指令',()=>{
 const p=createCRMExperience(),c=p.cards[0],valid={channel:'requirements-demo',type:'trace',projectId:p.id,cardIds:[c.id],field:'permission'};
 assert.deepEqual(readDemoTrace(valid,p),{cardIds:[c.id],field:'permission'});
 for(const invalid of [{...valid,projectId:'other'},{...valid,cardIds:['other']},{...valid,cardIds:[p.cards[2].id]},{...valid,type:'confirm'}])assert.equal(readDemoTrace(invalid,p),null);
 assert.ok(!tracePayload(p,c).cards.some(card=>card.id===p.cards[2].id));
 c.title='</script><script>alert(1)</script>';const html=buildDemoHTML(p,c);assert.equal((html.match(/<script>/g)||[]).length,1);assert.ok(!html.includes('</script><script>alert'));assert.match(html,/event.source!==window.parent/);assert.match(html,/connect-src 'none'/);
});

test('按问题性质分配正式追问：产品管范围和设计取舍，业务管规则与使用反馈',()=>{
 const c=createCRMExperience().cards[0];
 for(const [purpose,participantId,role] of [['scope','pm','pm'],['design_choice','pm','pm'],['usage','business-operations','business'],['business_rule','business-sales','business'],['business_conflict','business','business'],['design_feedback','business-operations','business']] as const){
  const result=validateDiscussion({replyRequest:{purpose,participantId},answer:null,question:{field:'quality',question:'针对本轮问题，请确认哪种方案更适合？',options:['采用方案一','采用方案二'],role,participantId},summarize:false},c);
  assert.equal(result.question?.participantId,participantId);
 }
 for(const [purpose,participantId,role] of [['scope','business','business'],['business_rule','pm','pm'],['business_conflict','business-sales','business'],['design_feedback','pm','pm']] as const){
  assert.throws(()=>validateDiscussion({replyRequest:{purpose,participantId},answer:null,question:{field:'quality',question:'针对本轮问题，请确认哪种方案更适合？',options:['方案一','方案二'],role,participantId},summarize:false},c),/应.*询问/);
 }
});
test('需要真人回答必须正式追问，禁止只在正文点名或错配对象',()=>{
 const c=createCRMExperience().cards[0];
 for(const reply of ['如需调整，请产品经理林舟决定是否纳入本期。','需要业务负责人陈敏明确必填规则。','请赵凯补充使用场景。']){
  assert.throws(()=>validateDiscussion({reply,answer:null,question:null,summarize:false},c),/正式追问/);
 }
 assert.throws(()=>validateDiscussion({replyRequest:{participantId:'pm',purpose:'scope'},answer:null,question:null,summarize:false},c),/正式追问/);
 assert.doesNotThrow(()=>validateDiscussion({reply:'林舟此前已明确本期不纳入；无需林舟再次决定。',answer:null,question:null,summarize:false},c));
});
test('设计建议与正式追问一起保存，产品表示异议后向原业务方收集反馈而不自动确认',()=>{
 const p=createCRMExperience(),c=p.cards[0];
 applyAction(p,{type:'message',cardId:c.id,text:'蓝色提交按钮能否改红色，醒目一点？'},'business','business-operations');
 applyAction(p,{type:'message',cardId:c.id,text:'红的不好吧，大家意见如何？'},'pm','pm');
 const before=structuredClone({fields:c.fields,approvals:c.approvals,blockers:c.blockers,revision:c.revision});
 const result:DiscussionAnalysis={replyRequest:{participantId:'business-operations',purpose:'design_feedback'},reply:'建议先保持蓝色并增强对比度或尺寸，也可比较红色方案；这是待讨论建议。',answer:null,question:{field:'quality',role:'business',participantId:'business-operations',question:'赵凯，保持蓝色并增大按钮能否满足醒目要求？',options:['可以先比较增强后的蓝色','仍希望比较红色方案']},summarize:false};
 assert.equal(attachDiscussion(p,c.id,result,discussionBasis(p,c)),true);
 assert.equal(c.messages.at(-1)?.text,result.reply);assert.equal(waitingQuestion(c)?.participantId,'business-operations');assert.equal(waitingLabel(c,'business','business-operations'),'等你补充');assert.match(waitingLabel(c,'pm','pm'),/赵凯/);
 assert.deepEqual({fields:c.fields,approvals:c.approvals,blockers:c.blockers,revision:c.revision},before);
});

test('新话题与旧追问冲突时保留原输出供修正，不先删新追问再报对象错误',()=>{
 const {c,q}=asked();applyAction({ ...createCRMExperience(),cards:[c] },{type:'message',cardId:c.id,text:'能不能加一个购买平台的按钮'},'business','business-operations');
 const raw={replyRequest:{participantId:'business-operations',purpose:'usage'},reply:'先明确购买平台按钮的用途。',answer:null,question:{field:'flow',question:'购买平台按钮点击后希望做什么？',options:['跳转购买网站','记录购买平台'],role:'business',participantId:'business-operations'},summarize:false};
 const before=structuredClone(raw);
 assert.throws(()=>validateDiscussion(raw,c),new RegExp(q.id));assert.throws(()=>validateDiscussion(raw,c),/deferQuestion/);assert.deepEqual(raw,before);assert.equal(q.status,'waiting');
});
test('明确转题可暂缓旧追问，新正式追问保持对象一致且重复校验结果一致',()=>{
 const {p,c,q}=asked();applyAction(p,{type:'message',cardId:c.id,text:'能不能加一个购买平台的按钮'},'business','business-operations');
 const raw:DiscussionAnalysis={deferQuestion:{questionId:q.id,sourceMessageId:latestHumanMessage(c)!.id,reason:'从交接权限转向新增购买平台按钮用途'},replyRequest:{participantId:'business-operations',purpose:'usage'},reply:'先明确按钮点击后的用途，再判断范围。',answer:null,question:{field:'flow',question:'购买平台按钮点击后希望做什么？',options:['跳转购买网站','记录购买平台'],role:'business',participantId:'business-operations'},summarize:false};
 const before=structuredClone({fields:c.fields,blockers:c.blockers,approvals:c.approvals,revision:c.revision});
 const once=validateDiscussion(raw,c);assert.deepEqual(validateDiscussion(once,c),once);
 assert.equal(attachDiscussion(p,c.id,once,discussionBasis(p,c)),true);
 assert.equal(q.status,'deferred');assert.equal(q.answerMessageId,undefined);assert.equal(waitingQuestion(c)?.participantId,'business-operations');assert.equal(c.followUps?.length,2);
 assert.deepEqual({fields:c.fields,blockers:c.blockers,approvals:c.approvals,revision:c.revision},before);
});
test('不能用转题丢掉明确回复，不能没有新追问就暂缓旧问题',()=>{
 const {p,c,q}=asked();applyAction(p,{type:'message',cardId:c.id,text:'我明确选择交接后立即撤权',replyTo:q.id},'business');
 const raw={deferQuestion:{questionId:q.id,sourceMessageId:latestHumanMessage(c)!.id,reason:'假装切换为购买平台按钮用途'},replyRequest:{participantId:'business-operations',purpose:'usage'},answer:null,question:{field:'flow',question:'购买平台按钮希望做什么？',options:['跳转网站','记录平台'],role:'business',participantId:'business-operations'},summarize:false};
 assert.throws(()=>validateDiscussion(raw,c),/暂缓旧问题必须/);assert.equal(q.status,'waiting');
 assert.throws(()=>validateDiscussion({...raw,question:null},c),/暂缓旧问题必须/);
});

test('暂缓不等于已回答：仍阻止整卡确认，能定向回复且不挤掉当前问题',()=>{
 const {p,c,q}=asked();q.status='deferred';
 assert.match(getChatDisabledReason('pmConfirm',{project:p,card:c,role:'pm'}),/关键问题/);
 const current={...q,id:'new-question',question:'购买平台按钮希望做什么？',participantId:'business-operations' as const,status:'waiting' as const};c.followUps!.push(current);
 applyAction(p,{type:'message',cardId:c.id,text:'交接后立即撤销访问权限',replyTo:q.id},'business');
 const message=latestHumanMessage(c)!;
 const result:DiscussionAnalysis={answer:{questionId:q.id,messageId:message.id,quote:message.text},question:null,summarize:false};
 assert.equal(attachDiscussion(p,c.id,result,discussionBasis(p,c)),true);
 assert.equal(q.status,'answered');assert.equal(q.answerMessageId,message.id);assert.equal(waitingQuestion(c)?.id,current.id);
});

test('不再按字数过滤；当前被询问人的短答先结合原问题，而非被当成寒暄',()=>{
 const {p,c}=asked();
 for(const text of ['不','不加','不要加入','可以','收到']){
  applyAction(p,{type:'message',cardId:c.id,text},'business');assert.equal(shouldListen(p,c),true,text);
 }
 c.followUps=[];
 applyAction(p,{type:'message',cardId:c.id,text:'不加'},'pm');assert.equal(shouldListen(p,c),true);
 applyAction(p,{type:'message',cardId:c.id,text:'收到'},'pm');assert.equal(shouldListen(p,c),false);
});
function scopeQuestion(){
 const p=createCRMExperience(),c=p.cards[0];
 applyAction(p,{type:'message',cardId:c.id,text:'能否增加购买平台按钮？'},'business','business-operations');
 attachDiscussion(p,c.id,{answer:null,question:{field:'scope',question:'本期是否纳入购买平台占位按钮？',options:['本期纳入，在申领页展示占位按钮','本期不纳入，暂不添加该按钮'],role:'pm',participantId:'pm'},summarize:false},discussionBasis(p,c));
 return {p,c,q:waitingQuestion(c)!};
}
test('普通短答和@Agent短答即使模型误判安静，也登记到原问题并给出回执',()=>{
 for(const text of ['不要加入','@Agent 不要加入','不','可以']){
  const {p,c,q}=scopeQuestion();applyAction(p,{type:'message',cardId:c.id,text},'pm','pm');
  const original=structuredClone({fields:c.fields,approvals:c.approvals,revision:c.revision});
  const raw:DiscussionAnalysis={handling:{mode:'quiet',trigger:'none',reason:''},answer:null,question:null,summarize:false};
  const fixed=validateDiscussion(raw,c);assert.equal(fixed.handling?.mode,'direct');assert.equal(fixed.answer?.quote,text);assert.equal(fixed.answer?.questionId,q.id);assert.match(fixed.reply!,/已记录/);
  assert.deepEqual(validateDiscussion(fixed,c),fixed);
  attachDiscussion(p,c.id,fixed,discussionBasis(p,c));assert.equal(q.status,'answered');assert.equal(q.answerMessageId,latestHumanMessage(c)?.id);assert.equal(waitingQuestion(c),undefined);
  assert.deepEqual({fields:c.fields,approvals:c.approvals,revision:c.revision},original);
 }
});
test('不会将其他人的否定、模糊回答、多选歧义或反问句擅自登记成范围决定',async()=>{
 const {matchQuestionOption}=await import('../shared/question-answer');
 const {p,c,q}=scopeQuestion();
 applyAction(p,{type:'message',cardId:c.id,text:'不要加入'},'business','business-operations');assert.equal(matchQuestionOption(c),null);
 for(const text of ['收到','不知道','我想吃肯德基','不要改颜色','可以吗','不要加入？']){applyAction(p,{type:'message',cardId:c.id,text},'pm','pm');assert.equal(matchQuestionOption(c),null,text);}
 applyAction(p,{type:'message',cardId:c.id,text:'不'},'pm','pm');q.options.push('暂时搁置');assert.equal(matchQuestionOption(c),null);
 q.options.pop();q.question='本期是否不纳入购买平台按钮？';assert.equal(matchQuestionOption(c),null);
 q.question='本期是否纳入购买平台按钮？';q.baseRevision--;assert.equal(matchQuestionOption(c),null);
});
