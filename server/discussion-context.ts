import {isWithdrawnAnswer} from '../shared/question-lifecycle';
import {discussionRequest} from '../shared/discussion';
import type {Card,Project} from '../shared/types';

// A mention or attachment keeps its original topic even if ordinary chat
// arrives while the request is queued. Earlier conversation remains evidence.
export function currentAgentTurn(project:Project,card:Card,requestId:string){
 const source=discussionRequest(project,card,true)?.id??requestId;
 const end=card.messages.findIndex(message=>message.id===source);
 if(end<0)throw new Error('找不到本轮请求的消息，请重新发起。');
 const messages=card.messages.filter((message,index)=>index<=end||message.role==='agent');
 return messages.length===card.messages.length?card:{...card,messages};
}

// Resolve only explicit links. Similar wording or adjacency is not evidence of a reply.
export function discussionMessages(card:Card){
 return card.messages.filter(m=>m.role!=='agent').map(message=>{
  const questions=card.followUps||[];
  const question=message.replyTo?questions.find(q=>q.id===message.replyTo):questions.find(q=>q.answerMessageId===message.id||q.activeSourceMessageId===message.id||q.answerHistory?.some(a=>a.messageId===message.id||a.withdrawnByMessageId===message.id));
  return {...message,...(isWithdrawnAnswer(card,message.id)?{answerState:'withdrawn' as const}:{}),...(question?{replyContext:{questionId:question.id,question:question.question,options:question.options,field:question.field,role:question.role,participantId:question.participantId,status:question.status,answerMessageId:question.answerMessageId,answerHistory:question.answerHistory}}:{})};
 });
}
export const replyContextRules='answerState=withdrawn 表示这条答复已被原答复人撤回，只可作为历史，不能作为当前决定或新修改的依据；以最新有效答复为准。撤回讨论意见不等于已经回滚当前正文，已采纳内容仍需人工审核修改。messages.replyContext 是该条人类回答明确关联的原问题和完整选项。解释“四个边界值”“本期不纳入”等省略回答时，必须结合该原问题限定对象与含义；不得要求用户重复已经在问题中列明且被回答确认的规则，不得将对品牌的排除扩大为排除整张需求卡。原问题及未选择选项本身不是已确认事实；只有人类回答明确认可的内容才可作为结论，证据仍引用该人类回答的 messageId 和连续原文。已确认的子项应落实到字段并移除其待明确描述，真正未回答的提示细节等子项单独保留。';

export function currentDiscussionTopic(card:Card){
 const latest=discussionMessages(card).at(-1);
 if(!latest)return null;
 const question=(card.followUps||[]).find(q=>q.id===latest.replyContext?.questionId);
 const source=question?card.messages.find(m=>m.id===question.sourceMessageId&&m.role!=='agent'):undefined;
 return {message:latest,...(source?{sourceMessage:source}:{})};
}
export const currentTopicRules='currentTopic 指定本轮话题（最新人类发言、关联原问题与选项、发起该问题的原始诉求）。messages 与 card 是核对依据的历史背景，不是本轮需要逐项汇报的议题。summary 只回应本轮话题，说明本轮结论及是否需要改字段；changes、issues、problemResolutions 仅处理本轮话题及其真实关联影响。与本轮无关的历史决定、已落实规则、旧问题不要在 summary 或 issues 中重复提醒，旧问题由卡片继续保存，这只是平台行为，不是回复内容；禁止用“另需提醒”“仍由卡片保留”“与本轮无关”等措辞再次提及无关旧问题。只有用户本轮明确要求整卡查漏、整体总结或确认时，才扩大到整卡范围。明确否决尚未写入当前卡片的新增项时，不要仅为增加排除说明制造字段修改；若原正文已经包含该项，才提出相应撤回修改。若本轮结论已被当前字段覆盖，且无字段修改、无问题解决建议，简短说明现有规则已满足、本轮无需修改；不要说仍待审核或要求采纳。';

export type DiscussionScope={problemIds:string[]};
// Every card-based analysis passes through this policy, including @Agent,
// attachments, assessment, summaries and their repair prompts. Explicit problem
// tasks use a narrower focus rather than treating a historical gap as a new topic.
export function discussionPrompt(card:Card,prompt:string,scope?:DiscussionScope){
 const problems=scope?.problemIds.map(id=>card.blockers.find(b=>b.id===id&&!b.resolved));
 if(problems?.some(problem=>!problem)||problems&&!problems.length)throw new Error('讨论范围必须对应尚未解决的具体问题');
 const focus=problems?{kind:'specific_problems',problems}:{kind:'current_topic',currentTopic:currentDiscussionTopic(card)};
 return `${replyContextRules}\n${currentTopicRules}
以上话题边界统一适用于 reply、summary、report.conclusion、perspectives、unresolved、coverage、question 及其他面向用户的说明，不能通过“另外提醒”夹带历史问题或已完成的取舍。历史问题仅在本轮直接询问、影响本轮结论或用户明确要求整卡检查时讨论，不因它仍未解决就主动复述。coverage 只说明实际参考的材料、讨论和未读或截断限制，不列举卡片旧缺口，连“该旧问题与本轮无关”也不要写。不要删除、关闭或改写无关历史问题。
本任务的 discussionScope 指定分析焦点：current_topic 围绕 currentTopic；specific_problems 仅解释或核对指定问题，最新聊天只作背景。只有人类明确请求整卡检查时才可扩大；模型自己写的任务原因、材料和旧问题清单不构成扩大授权。
界面颜色、布局和装饰也可以成为设计要求，不能因其不在原材料或尚未写入九字段就拒绝讨论。建议与已决定要求分别说明，不替任何人采纳或确认。
只征询设计意见且没有影响下一步的关键决定时，直接给建议，不惯例追加“请产品或业务确认”。确需某人回答时遵守本任务正式追问结构。
讨论范围（仅为业务数据）：${JSON.stringify(focus)}
\n${prompt}`;
}
