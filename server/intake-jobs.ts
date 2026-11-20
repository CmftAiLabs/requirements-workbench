import {randomUUID} from 'node:crypto';
import type {Job,Material,Project,IntakeCandidate} from '../shared/types';
import {hasIntakeResult,INTAKE_MAX_CHARACTERS,INTAKE_MAX_MATERIALS,nextIntakeMaterials} from '../shared/material-intake';
import {attachIntakeBatch} from './domain';
import {extractIntakeRequirements} from './ai';
import {getProject,mutateProject,newJob,putJob,listJobs,pool,ConflictError} from './store';

interface IntakeStore {
 get:(id:string)=>Promise<Project>;
 update:(id:string,fn:(p:Project)=>void)=>Promise<void>;
 create:(id:string,label:string)=>Promise<Job>;
 save:(job:Job)=>Promise<void>;
 active:(id:string)=>Promise<boolean>;
 pending:()=>Promise<string[]>;
}
const database:IntakeStore={
 get:getProject,update:async(id,fn)=>{await mutateProject(id,fn)},
 create:(id,label)=>newJob(id,'extract',label),save:putJob,
 active:async id=>(await listJobs(id)).some(j=>j.kind==='extract'&&['queued','running'].includes(j.status)),
 pending:async()=>(await pool.query("SELECT id FROM projects WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(body->'materials') m WHERE m->'intake'->>'status'='pending')")).rows.map(r=>r.id),
};
type Analyze=(materials:Material[],cards:Project['cards'],progress:(label:string)=>Promise<void>)=>Promise<IntakeCandidate[]>;
export function createIntakeQueue(options:{enabled:()=>boolean;error:(e:unknown)=>string;store?:IntakeStore;analyze?:Analyze;delayMs?:number}){
 const store=options.store||database,analyze=options.analyze||extractIntakeRequirements,timers=new Map<string,ReturnType<typeof setTimeout>>();let closed=false;
 const wake=(id:string)=>{
  if(closed||timers.has(id))return;
  const timer=setTimeout(()=>{timers.delete(id);void pump(id).catch(()=>console.error('材料已保存，自动分析暂未启动，请稍后重试。'));},options.delayMs??350);
  timer.unref();timers.set(id,timer);
 };
 async function pump(id:string){
  if(closed||!options.enabled()||await store.active(id))return;
  const p=await store.get(id);if(p.deliveries.some(d=>!d.completedAt))return;
  const selected=nextIntakeMaterials(p);if(!selected.length)return;
  try{await start(id,selected.map(m=>m.id))}catch(e){if(!(e instanceof ConflictError))throw e;}
 }
 async function start(id:string,ids:string[]){
  if(closed)throw new Error('服务正在重启，材料已保留。');
  if(!options.enabled())throw new Error('AI 助手尚未启用，材料已保留。');
  const p=await store.get(id),materialIds=[...new Set(ids)];
  if(!materialIds.length||materialIds.length>INTAKE_MAX_MATERIALS)throw new Error('每次最多分析20份材料。');
  if(p.deliveries.some(d=>!d.completedAt))throw new Error('当前 PRD 已冻结交付，完成后将继续分析新材料。');
  const selected=materialIds.map(mid=>p.materials.find(m=>m.id===mid));
  if(selected.some(m=>!m?.text.trim()||m.error||m.status==='处理中'))throw new Error('材料尚无可读取正文，请先检查解析结果。');
  if(materialIds.some(mid=>hasIntakeResult(p,mid)))throw new Error('材料已有需求卡片，请打开现有卡片继续编辑。');
  if(selected.reduce((n,m)=>n+m!.text.length,0)>INTAKE_MAX_CHARACTERS)throw new Error('本次材料超过18万字符，请分批整理。');
  const job=await store.create(id,`正在从 ${selected.length} 份材料生成需求卡片`);
  job.result={materialIds};
  try{
   await store.save(job);
   const groupId=randomUUID();await store.update(id,current=>{for(const mid of materialIds){const m=current.materials.find(m=>m.id===mid)!;if(hasIntakeResult(current,mid))throw new ConflictError('材料已有需求卡片，请刷新查看。');m.intake={groupId:m.intake?.groupId||groupId,status:'pending'};}});
  }catch(e){job.status='failed';job.error=options.error(e);job.finishedAt=new Date().toISOString();await store.save(job);throw e;}
  setImmediate(()=>{void execute(job,selected as Material[],p.cards).catch(()=>console.error('材料分析状态保存失败，请检查连接。'));});
  return job;
 }
 async function execute(job:Job,materials:Material[],cards:Project['cards']){
  const materialIds=materials.map(m=>m.id);
  try{
   job.status='running';await store.save(job);
   const drafts=await analyze(materials,cards,async label=>{job.label=`生成需求卡片 · ${label}`;await store.save(job);});
   if(closed)throw new Error('服务已重启，自动分析将继续。');
   await store.update(job.projectId,current=>{
    if(materialIds.some(mid=>hasIntakeResult(current,mid)))throw new ConflictError('材料已有需求卡片，请刷新查看。');
    const batch=attachIntakeBatch(current,drafts,materialIds);
    for(const m of current.materials)if(materialIds.includes(m.id))delete m.intake;
    job.result={materialIds,batchId:batch.id,draftCount:batch.drafts.length};
    job.label=`已生成 ${batch.drafts.length} 张需求卡片`;
   });
   job.status='succeeded';
  }catch(e){
   job.status='failed';job.error=options.error(e);
   if(!closed)await store.update(job.projectId,current=>{for(const m of current.materials)if(materialIds.includes(m.id)&&m.intake&&!hasIntakeResult(current,m.id))m.intake={...m.intake,status:'failed',error:job.error};});
  }finally{
   job.finishedAt=new Date().toISOString();await store.save(job);wake(job.projectId);
  }
 }
 return {start,wake,async resume(){for(const id of await store.pending())wake(id)},close(){closed=true;for(const timer of timers.values())clearTimeout(timer);timers.clear()}};
}
