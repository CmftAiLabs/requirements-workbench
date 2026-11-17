import assert from 'node:assert/strict';
import {writeFile,mkdir} from 'node:fs/promises';
import pg from 'pg';
import {discussionReplayProject} from '../tests/fixtures/discussion-replay';
import {applyAction,attachSuggestion} from '../server/domain';
import {analyzeDiscussion,suggestChanges} from '../server/ai';
import {evaluateRequirement} from '../server/requirement-assessment';
import {attachDiscussion} from '../server/discussion';
import {setSelectedModel,currentModel} from '../server/model-settings';
import {discussionBasis,latestHumanMessage,waitingQuestion} from '../shared/discussion';
import {PARTICIPANTS,type ParticipantId} from '../shared/participants';
import type {DiscussionAnalysis} from '../shared/types';
// Explicit real gateway replay. Only reads the selected model from the database;
// all discussion and question mutations stay in disposable in-memory projects.
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
try{const setting=(await pool.query("SELECT value FROM app_settings WHERE key='model'")).rows[0]?.value;setSelectedModel(process.argv[2]||setting);}finally{await pool.end();}
const results:unknown[]=[];
function replay(name:string,prepare?:(card:ReturnType<typeof discussionReplayProject>['c'])=>void){
 const {p,c}=discussionReplayProject(name);prepare?.(c);const baseline=JSON.stringify([c.fields,c.approvals,c.revision]);
 function say(person:ParticipantId,text:string,replyTo?:string){applyAction(p,{type:'message',cardId:c.id,text,...(replyTo?{replyTo}:{})},PARTICIPANTS.find(p=>p.id===person)!.role,person);return latestHumanMessage(c)!;}
 function attach(result:DiscussionAnalysis){assert.equal(attachDiscussion(p,c.id,result,discussionBasis(p,c)),true);assert.ok((c.followUps||[]).filter(q=>q.status==='waiting').length<=1);assert.equal(JSON.stringify([c.fields,c.approvals,c.revision]),baseline);}
 async function turn(person:ParticipantId,text:string,check:()=>void,replyTo?:string){
  const m=say(person,text,replyTo),start=Date.now();let result:DiscussionAnalysis|undefined;
  try{result=await analyzeDiscussion(c,p.materials);if(result.handling?.mode==='deep')result=(await evaluateRequirement(p,c,result.handling.reason)).discussion;attach(result);if(result.summarize&&!result.question){const draft=await suggestChanges(c,p.materials,p.cards);attachSuggestion(p,c.id,draft,c.revision,c.messages.length);}assert.equal(JSON.stringify([c.fields,c.approvals,c.revision]),baseline);check();results.push({name,text,ms:Date.now()-start,ok:true,result,questions:structuredClone(c.followUps)});console.log(JSON.stringify({name,text,ok:true,ms:Date.now()-start}));}
  catch(error){results.push({name,text,ms:Date.now()-start,ok:false,result,error:String(error),questions:structuredClone(c.followUps)});throw error;}
  return m;
 }
 function seed(question:NonNullable<DiscussionAnalysis['question']>){say('business-operations','讨论新增购买平台占位按钮和按钮样式，尚未决定。');attach({answer:null,question,summarize:false});return waitingQuestion(c)!;}
 return {c,turn,seed};
}
const scope:NonNullable<DiscussionAnalysis['question']>={field:'scope',question:'本期是否纳入购买平台占位按钮？',options:['本期纳入，在申领页展示占位按钮','本期不纳入，暂不添加该按钮'],role:'pm',participantId:'pm'};
const runs=await Promise.allSettled([
 (async()=>{const h=replay('短答、撤回及更正');const q=h.seed(scope);
 await h.turn('business-sales','可以',()=>assert.equal(q.status,'waiting'));
 await h.turn('pm','@Agent 不要加入',()=>{assert.equal(q.status,'answered');assert.equal(q.answerMessageId,latestHumanMessage(h.c)!.id);});
 await h.turn('pm','我撤回刚才不加入购买平台按钮的决定，暂时没想好',()=>{assert.equal(q.status,'waiting');assert.equal(q.answerHistory?.length,1);},q.id);
 await h.turn('business-sales','同意',()=>assert.equal(q.status,'waiting'));
 await h.turn('pm','第一个',()=>{assert.equal(q.status,'answered');assert.equal(q.answerMessageId,latestHumanMessage(h.c)!.id);});
 await h.turn('pm','我改主意了，撤回刚才纳入按钮的答复，改为本期不加入',()=>{assert.equal(q.status,'answered');assert.equal(q.answerMessageId,latestHumanMessage(h.c)!.id);assert.equal(q.answerHistory?.length,2);assert.equal(waitingQuestion(h.c),undefined);},q.id);
 })(),
 (async()=>{const h=replay('切换话题与定向恢复');const q=h.seed({...scope,field:'quality',question:'赵凯，更醒目的提交按钮希望怎样调整？',options:['保持蓝色并增大尺寸','改为红色再比较效果'],role:'business',participantId:'business-operations'});
 await h.turn('pm','先不讨论颜色。现在讨论购买平台占位按钮，本期加不加请正式问我，业务已说明只需展示一个占位按钮。',()=>{assert.equal(q.status,'deferred');assert.equal(waitingQuestion(h.c)?.participantId,'pm');});
 await h.turn('pm','@Agent 不要加入',()=>{assert.equal(waitingQuestion(h.c),undefined);assert.equal(q.status,'deferred');});
 await h.turn('business-operations','第一个',()=>{assert.equal(q.status,'answered');assert.equal(q.answerMessageId,latestHumanMessage(h.c)!.id);assert.equal(waitingQuestion(h.c),undefined);},q.id);
 await h.turn('pm','谢谢',()=>assert.equal(waitingQuestion(h.c),undefined));
 await h.turn('pm','@Agent 请深入评估刚才购买平台按钮不纳入和提交按钮保持蓝色增大尺寸这两个结论的影响，只评估，不修改，也不要重问已经回答的问题。',()=>assert.equal(waitingQuestion(h.c),undefined));
 })(),
 (async()=>{const h=replay('多人冲突',c=>{c.fields.scope+='本期已纳入购买月份。';c.fields.data+='购买月份必填性待业务负责人统一。';});h.seed({...scope,field:'data',question:'陈敏，购买月份的业务口径统一为哪一种？赵凯认为必填，李雯认为选填。',options:['必填，未选择不可提交','选填，未选择可以提交'],role:'business',participantId:'business'});const q=waitingQuestion(h.c)!;
 await h.turn('pm','我支持选填',()=>assert.equal(q.status,'waiting'));
 await h.turn('business-sales','选填',()=>assert.equal(q.status,'waiting'));
 await h.turn('business','选填',()=>{assert.equal(q.status,'answered');assert.equal(q.answerMessageId,latestHumanMessage(h.c)!.id);});
 await h.turn('business-operations','我不同意陈敏刚才的口径，购买月份必须必填，否则无法安排。请陈敏解释并统一这个冲突。',()=>{assert.equal(q.status,'answered');assert.equal(q.answerHistory,undefined);assert.equal(waitingQuestion(h.c)?.participantId,'business');});
 await h.turn('business','仍然选填，没有月份时按实际提交时间安排，不阻止提交',()=>{assert.equal(waitingQuestion(h.c),undefined);assert.equal(h.c.followUps!.at(-1)!.status,'answered');});
 })(),
]);
await mkdir('.work/expert-discussion',{recursive:true});
const output={model:currentModel(),at:new Date().toISOString(),runs:runs.map(r=>r.status==='fulfilled'?{ok:true}:{ok:false,error:String(r.reason)}),turns:results};
await writeFile('.work/expert-discussion/live-multiround.json',JSON.stringify(output,null,2));
console.log(JSON.stringify({model:currentModel(),runs:output.runs,turns:results.length}));
if(runs.some(r=>r.status==='rejected'))process.exitCode=1;
