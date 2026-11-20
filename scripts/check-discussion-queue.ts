import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import pg from 'pg';
import type {Card,Project,FollowUp} from '../shared/types';
import type {ParticipantId} from '../shared/participants';

// Paid-model replay of the actual queue in a disposable database. Production
// access is read-only model selection; no test messages enter real projects.
const admin=new pg.Pool({connectionString:process.env.DATABASE_URL}),dbName=`requirements_queue_${process.pid}_${randomUUID().slice(0,8)}`;
const repeat=Number(process.argv[2]||2);if(!Number.isInteger(repeat)||repeat<1||repeat>5)throw Error('重复次数必须为1至5');
const results:{name:string;ok:boolean;[key:string]:unknown}[]=[],runId=new Date().toISOString().replace(/[:.]/g,'-');
let created=false,store:typeof import('../server/store')|undefined,queue:ReturnType<typeof import('../server/discussion-jobs').createDiscussionQueue>|undefined;
try{
 const model=(await admin.query("SELECT value FROM app_settings WHERE key='model'")).rows[0]?.value||process.env.MODEL_NAME;
 await admin.query(`CREATE DATABASE "${dbName}"`);created=true;
 const testURL=new URL(process.env.DATABASE_URL!);testURL.pathname='/'+dbName;process.env.DATABASE_URL=testURL.toString();
 store=await import('../server/store');await store.initStore();
 const {setSelectedModel}=await import('../server/model-settings');setSelectedModel(model);
 const {createDiscussionQueue}=await import('../server/discussion-jobs');
 const {discussionReplayProject}=await import('../tests/fixtures/discussion-replay');
 const {applyAction}=await import('../server/domain'),{attachDiscussion}=await import('../server/discussion');
 const {discussionBasis}=await import('../shared/discussion'),{PARTICIPANTS}=await import('../shared/participants');
 const {mentionAgent}=await import('../shared/agent-mention');
 const {discussionDisplay}=await import('../server/discussion-scope');
 queue=createDiscussionQueue({enabled:true,delayMs:1}); // onSuggested deliberately does not generate prototypes.
 async function fixture(name:string,prepare?:(p:Project,c:Card)=>void){
  const {p,c}=discussionReplayProject(name);prepare?.(p,c);await store!.insertProject(p);
  const baseline=structuredClone({fields:c.fields,approvals:c.approvals,revision:c.revision});
  async function turn(person:ParticipantId,text:string,check:(card:Card)=>void,replyTo?:string,legacyReply=false){
   const start=Date.now(),personRole=PARTICIPANTS.find(p=>p.id===person)!.role;
   const before=await store!.getProject(p.id),messageCount=before.cards[0].messages.length,assessmentCount=before.cards[0].assessments?.length||0;
   await store!.mutateProject(p.id,next=>applyAction(next,{type:'message',cardId:c.id,text:mentionAgent(text),...(replyTo?{replyTo}:{})},personRole,person));
   if(legacyReply)await store!.mutateProject(p.id,next=>{
    const card=next.cards[0],last=card.messages.at(-1)!;
    card.messages.push({id:randomUUID(),role:'agent',text:'旧版仅回复：收到撤回。',createdAt:new Date().toISOString(),materialReply:{contextMessageId:last.id,sourceMessageIds:[],materialIds:[],clarifiesCurrent:false,relatedCardIds:[],evidence:[],warnings:[]}});card.assistantCursor=last.id;
   });
   const job=await queue!.enqueue(p.id,c.id,legacyReply);
   if(job){
    const deadline=Date.now()+300000;
    for(;;){const current=(await store!.listJobs(p.id)).find(j=>j.id===job.id)!;
     if(['succeeded','failed'].includes(current.status)){assert.equal(current.status,'succeeded',current.error);break;}
     if(Date.now()>deadline)throw Error('模型队列回放超时');await new Promise(r=>setTimeout(r,700));
    }
   }
   const after=(await store!.getProject(p.id)).cards[0];
   assert.deepEqual({fields:after.fields,approvals:after.approvals,revision:after.revision},baseline);
   assert.ok((after.followUps||[]).filter(q=>q.status==='waiting'&&q.baseRevision===after.revision).length<=1);
   check(after);
   results.push({name,text,ms:Date.now()-start,ok:true,jobId:job?.id,messages:after.messages.slice(messageCount),assessments:after.assessments?.slice(assessmentCount),questions:after.followUps,suggestion:after.suggestion});
   console.log(JSON.stringify({name,text,ok:true,ms:Date.now()-start}));return after;
  }
  return {p,c,turn};
 }
 function seed(p:Project,c:Card,status:FollowUp['status']){
  applyAction(p,{type:'message',cardId:c.id,text:'讨论是否增加购买平台占位按钮。'},'business','business-operations');
  attachDiscussion(p,c.id,{answer:null,question:{field:'scope',question:'本期是否纳入购买平台占位按钮？',options:['本期纳入','本期不纳入'],role:'pm',participantId:'pm'},summarize:false},discussionBasis(p,c));
  const q=c.followUps![0];
  if(status==='answered'){applyAction(p,{type:'message',cardId:c.id,text:'第二个',replyTo:q.id},'pm','pm');attachDiscussion(p,c.id,{answer:null,question:null,summarize:false},discussionBasis(p,c));}
  else q.status=status;
 }
 for(let round=1;round<=repeat;round++){
  const cases=[
   {name:`队列撤回与更正-${round}`,run:async()=>{
    const h=await fixture(`队列撤回与更正-${round}`,(p,c)=>seed(p,c,'answered')),id=h.c.followUps![0].id;
    await h.turn('pm','@Agent 我撤回刚才不纳入购买平台按钮的答复，暂时没想好',c=>{assert.equal(c.followUps![0].status,'waiting');assert.equal(c.followUps![0].answerHistory?.length,1);},undefined,true);
    await h.turn('business-sales','同意',c=>assert.equal(c.followUps![0].status,'waiting'));
    await h.turn('pm','第一个',c=>assert.equal(c.followUps![0].status,'answered'));
    await h.turn('pm','@Agent 我撤回刚才纳入的决定，改为本期不纳入',c=>{assert.equal(c.followUps![0].id,id);assert.equal(c.followUps![0].status,'answered');assert.equal(c.followUps![0].answerHistory?.length,2);},id);
   }},
   {name:`队列暂缓恢复-${round}`,run:async()=>{
    const h=await fixture(`队列暂缓恢复-${round}`,(p,c)=>seed(p,c,'deferred')),id=h.c.followUps![0].id;
    await h.turn('pm','@Agent 第二个',c=>{assert.equal(c.followUps!.length,1);assert.equal(c.followUps![0].id,id);assert.equal(c.followUps![0].status,'answered');},id);
    await h.turn('pm','谢谢',c=>assert.equal(c.followUps![0].status,'answered'));
   }},
   {name:`队列局部与整卡-${round}`,run:async()=>{
    const h=await fixture(`队列局部与整卡-${round}`,(_p,c)=>{
     c.fields.scope+='本期已纳入购买月份，必填性待明确。';
     c.blockers=[{id:'old-errors',field:'exception',reason:'无效输入提示的验收细节待明确',resolved:false,createdAt:'2026-10-23'},{id:'old-month',field:'data',reason:'购买月份必填还是选填待明确',resolved:false,createdAt:'2026-10-23'}];
    });
    const display=(c:Card)=>JSON.stringify({reply:c.messages.filter(m=>m.role==='agent').at(-1)?.text,report:c.assessments?.at(-1)?.report,suggestion:c.suggestion&&discussionDisplay(c.suggestion)});
    await h.turn('business-operations','@Agent 右上角加装饰图案你怎么看？只提设计意见。不要追问，不要修改需求。',c=>{assert.doesNotMatch(display(c),/购买(?:的)?月份|无效输入/);assert.ok(c.blockers.every(b=>!b.resolved));});
    await h.turn('pm','@Agent 请整卡检查目前还缺哪些信息，只列已有未解决问题。不要修改需求，不要新建追问。',c=>{assert.match(display(c),/月份/);assert.match(display(c),/提示/);assert.ok(c.blockers.every(b=>!b.resolved));});
    const priorAgents=(await store!.getProject(h.p.id)).cards[0].messages.filter(m=>m.role==='agent').length;
    await h.turn('pm','@Agent 现在只解释名称40字和41字的校验结果。不要再总结整张卡，不要追问，不要修改需求。',c=>{
     const newReply=c.messages.filter(m=>m.role==='agent').slice(priorAgents).map(m=>m.text).join('\n');assert.match(newReply,/40|41/);assert.doesNotMatch(newReply,/月份|无效输入提示/);assert.ok(c.blockers.every(b=>!b.resolved));
    });
   }},
  ];
  // Real production queue, sequential across cases to avoid saturating the model.
  for(const entry of cases)try{await entry.run();}catch(error){results.push({name:entry.name,ok:false,error:String(error)});console.log(JSON.stringify({name:entry.name,ok:false,error:String(error)}));process.exitCode=1;}
 }
 await mkdir('.work/expert-discussion',{recursive:true});
 await writeFile(`.work/expert-discussion/live-queue-${runId}.json`,JSON.stringify({model,repeat,results},null,2));
 console.log(JSON.stringify({model,repeat,turns:results.filter(r=>r.ok).length,failures:results.filter(r=>!r.ok).length}));
}finally{
 queue?.close();await store?.pool.end();
 if(created)await admin.query(`DROP DATABASE "${dbName}"`);await admin.end();
}
