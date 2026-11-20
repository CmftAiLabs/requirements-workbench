import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createProject,applyAction} from '../server/domain';
import {createIntakeQueue} from '../server/intake-jobs';
import {ConflictError} from '../server/store';
import {materialAnalysisLabel,nextIntakeMaterials} from '../shared/material-intake';
import {FIELDS,type Material,type Job,type Fields,type IntakeCandidate} from '../shared/types';

const material=(id:string,group='upload'):Material=>({id,name:id+'.txt',kind:'会议纪要',location:'文件',text:'客户可查询自己的申请。',createdAt:'now',status:'待整理',cardIds:[],intake:{status:'pending',groupId:group}});
const candidate=(m:Material):IntakeCandidate=>({key:m.id,title:'查询申请 '+m.id,granularity:'具体',origin:'材料要求',rationale:'材料中的独立业务要求',coverageGaps:[],fields:{...Object.fromEntries(FIELDS.map(([k])=>[k,'待明确：业务规则'])) as Fields,goal:m.text},sourceIds:[m.id],assessment:'待澄清',issues:[],evidence:{goal:[{materialId:m.id,quote:m.text}]}});
const until=async(check:()=>boolean)=>{const deadline=Date.now()+4000;while(!check()){if(Date.now()>deadline)throw Error('queue did not settle');await new Promise(r=>setTimeout(r,5));}};
function fixture(){
 let project=createProject('自动材料回归');project.materials=[];const jobs:Job[]=[];
 const store={get:async()=>structuredClone(project),update:async(_id:string,fn:(p:typeof project)=>void)=>{const next=structuredClone(project);fn(next);next.stamp++;project=next;},create:async(id:string,label:string)=>{if(jobs.some(j=>['queued','running'].includes(j.status)))throw new ConflictError('已有任务');const j:Job={id:randomUUID(),projectId:id,kind:'extract',label,status:'queued',createdAt:new Date().toISOString()};jobs.push(j);return structuredClone(j)},save:async(j:Job)=>{jobs[jobs.findIndex(x=>x.id===j.id)]=structuredClone(j)},active:async()=>jobs.some(j=>['queued','running'].includes(j.status)),pending:async()=>[project.id]};
 return {store,jobs,get project(){return project},add:(m:Material)=>project.materials.push(m)};
}

test('同批文档等图片解析完成；跳过历史、聊天及失败材料，按大小自动分批',()=>{
 const p=createProject('材料策略');p.materials=[];const a=material('text'),image=material('image');image.status='处理中';image.text='';p.materials=[a,image];assert.deepEqual(nextIntakeMaterials(p),[]);
 image.status='待整理';image.text='识别文字';assert.deepEqual(nextIntakeMaterials(p).map(m=>m.id),['text','image']);
 const legacy=material('legacy');delete legacy.intake;const chat=material('chat');chat.sourceConversation={cardId:'c',messageId:'msg',participantId:'business'};const failed=material('failed');failed.intake!.status='failed';p.materials.push(legacy,chat,failed);assert.equal(nextIntakeMaterials(p).length,2);
 a.text='甲'.repeat(100000);image.text='乙'.repeat(100000);assert.deepEqual(nextIntakeMaterials(p).map(m=>m.id),['text']);
 p.materials=Array.from({length:23},(_,i)=>material(String(i)));assert.equal(nextIntakeMaterials(p).length,20);
});

test('上传后自动生成可编辑卡片，重复唤醒不重复调用；人工入池不冒充确认',async t=>{
 const f=fixture();f.add(material('a'));f.add(material('b'));let calls=0;
 const q=createIntakeQueue({store:f.store,enabled:()=>true,error:e=>String(e),delayMs:1,analyze:async ms=>{calls++;return ms.map(candidate)}});t.after(()=>q.close());
 q.wake(f.project.id);q.wake(f.project.id);await until(()=>f.jobs.some(j=>j.status==='succeeded'));
 assert.equal(calls,1);assert.equal(f.project.intakeBatches?.[0].drafts.length,2);assert.equal(f.project.cards.length,0);assert.equal(f.project.phase,'可讨论');
 await q.resume();await new Promise(r=>setTimeout(r,15));assert.equal(calls,1);
 const batch=f.project.intakeBatches![0],drafts=structuredClone(batch.drafts);drafts[0].title='人工编辑后的名称';
 applyAction(f.project,{type:'saveIntake',batchId:batch.id,revision:batch.revision,drafts,importSelected:true},'pm');
 assert.equal(f.project.cards.length,2);assert.equal(f.project.cards[0].title,'人工编辑后的名称');assert.ok(f.project.cards.every(c=>!c.approvals.pm&&!c.approvals.business));
 assert.ok(f.project.materials.every(m=>!m.intake));
});

test('分析中追加材料自动接续；失败不死循环，人工重试保留旧卡与未决项',async t=>{
 const f=fixture();f.add(material('a','first'));let release!:()=>void,entered=false,calls=0,fail=true;const gate=new Promise<void>(r=>release=r);
 const q=createIntakeQueue({store:f.store,enabled:()=>true,error:e=>e instanceof Error?e.message:String(e),delayMs:1,analyze:async ms=>{calls++;if(ms[0].id==='a'){entered=true;await gate;}else if(fail)throw Error('模型连接暂时中断');return ms.map(candidate)}});t.after(()=>{release();q.close()});
 q.wake(f.project.id);await until(()=>entered);f.add(material('b','second'));q.wake(f.project.id);release();await until(()=>f.jobs.length===2&&f.jobs.every(j=>['failed','succeeded'].includes(j.status)));
 assert.equal(f.project.intakeBatches?.length,1);assert.equal(f.project.materials.find(m=>m.id==='b')?.intake?.status,'failed');
 q.wake(f.project.id);await new Promise(r=>setTimeout(r,20));assert.equal(calls,2);
 fail=false;await q.start(f.project.id,['b']);await until(()=>f.project.intakeBatches?.length===2);assert.equal(calls,3);assert.equal(f.project.cards.length,0);assert.equal(f.project.intakeBatches?.[0].drafts[0].title,'查询申请 a');
 await assert.rejects(()=>q.start(f.project.id,['a']),/已有需求卡片/);
});

test('未配置模型及交付冻结时保留请求；恢复后仅处理有明确自动请求的材料',async t=>{
 const f=fixture();f.add(material('pending'));const historical=material('historical');delete historical.intake;f.add(historical);let enabled=false,calls=0;
 const q=createIntakeQueue({store:f.store,enabled:()=>enabled,error:e=>String(e),delayMs:1,analyze:async ms=>{calls++;return ms.map(candidate)}});t.after(()=>q.close());
 await q.resume();await new Promise(r=>setTimeout(r,15));assert.equal(calls,0);
 f.project.deliveries.push({id:'frozen',completedAt:undefined} as never);enabled=true;await q.resume();await new Promise(r=>setTimeout(r,15));assert.equal(calls,0);
 f.project.deliveries[0].completedAt='now';await q.resume();await until(()=>f.jobs.some(j=>j.status==='succeeded'));assert.equal(calls,1);assert.equal(f.project.intakeBatches?.[0].materialIds[0],'pending');assert.equal(historical.status,'待整理');
});

test('待分析、运行与失败状态清晰，读取列表不会改写材料',()=>{
 const m=material('a'),before=structuredClone(m);assert.equal(materialAnalysisLabel(m,[]),'等待自动分析');assert.equal(materialAnalysisLabel(m,[],'等待启用 AI'),'等待启用 AI');assert.equal(materialAnalysisLabel(m,[{kind:'extract',status:'running',result:{materialIds:['a']}}]),'正在生成卡片');assert.deepEqual(m,before);
 m.intake!.status='failed';assert.equal(materialAnalysisLabel(m,[]),'分析未完成');m.status='处理中';assert.equal(materialAnalysisLabel(m,[]),'处理中');
});
