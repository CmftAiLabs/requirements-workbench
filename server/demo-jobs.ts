import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {getProject,getPreviewProject,mutateProject,listJobs,newJob,putJob,ConflictError} from './store.ts';
import type {Project,Job} from '../shared/types.ts';
import type {DemoRevision} from '../shared/generated-demo.ts';
import {currentDemo,usableDemo,demoInput,demoInputKey,demoBasisKey,isDemoDraft,digest,demoCodeSchema} from './demo-schema.ts';
import {buildAndCheck,readDemoSource,ensureDemoBuilder,artifactDir} from './demo-builder.ts';
import {generateDemoCode} from './demo-generator.ts';
import {config} from './config.ts';
import {buildModularDemo} from './demo-modules';
import {recordMetric} from './metrics';
import {verifyModularDemo,applyDemoVerification} from './demo-verification';

export function appendDemo(p:Project,revision:DemoRevision){
 p.generatedDemo||={currentId:'',revisions:[]};
 p.generatedDemo.revisions.push(revision);p.generatedDemo.currentId=revision.id;
 p.events.push({id:randomUUID(),action:'原型更新',role:'system',detail:`原型修订 ${revision.number}：${revision.summary}；未代替任何人确认。`,createdAt:revision.createdAt});
}
/** Reuse checked code only when the effective content is exactly unchanged after a human action. */
export function reconcileDemo(p:Project){
 const r=usableDemo(p);if(!r||r.inputKey!==demoInputKey(p))return false;
 if(r.id===currentDemo(p)?.id&&r.basisKey===demoBasisKey(p)&&r.draft===isDemoDraft(p))return true;
 // Only exact effective content can reuse code; remaining suggestions stay visibly draft.
 const next={...r,id:randomUUID(),number:(p.generatedDemo?.revisions.at(-1)?.number||0)+1,createdAt:new Date().toISOString(),draft:isDemoDraft(p),basisKey:demoBasisKey(p),adoptedFrom:r.id,parentId:r.id};
 appendDemo(p,next);return true;
}
export function createDemoQueue({enabled,generate=generateDemoCode,build=buildAndCheck,prepare=build===buildAndCheck?ensureDemoBuilder:async()=>{}}:{prepare?:()=>Promise<void>;enabled:boolean;generate?:typeof generateDemoCode;build?:typeof buildAndCheck}){
 let closed=false;
 const controllers=new Set<AbortController>(),checking=new Set<string>();
 const verifyLater=(projectId:string,revision:DemoRevision)=>{
  if(closed||checking.has(revision.artifactId))return;
  checking.add(revision.artifactId);
  setImmediate(()=>{void (async()=>{
   try{const result=await verifyModularDemo(projectId,revision);if(!closed)await mutateProject(projectId,p=>applyDemoVerification(p.generatedDemo?.revisions||[],revision,result));}
   catch{if(!closed)await mutateProject(projectId,p=>applyDemoVerification(p.generatedDemo?.revisions||[],revision,{status:'interrupted',total:revision.verification?.total||0,passed:revision.checksPassed,startedAt:revision.verification?.startedAt||revision.createdAt,finishedAt:new Date().toISOString(),errors:['后台检查中断，原型仍可查看；下次更新会重新核对。']}));}
   finally{checking.delete(revision.artifactId);}
  })().catch(()=>console.error('原型后台检查状态保存失败'));});
 };
 // Resume only the current pending artifact after a service restart.
 const resume=async()=>{
  const {pool}=await import('./store');
  const rows=await pool.query("SELECT id FROM projects WHERE body->'generatedDemo' IS NOT NULL");
  for(const {id} of rows.rows){if(closed)return;const p=await getProject(id),revision=currentDemo(p);if(revision?.verification?.status==='pending')verifyLater(id,revision);}
 };
 async function enqueue(projectId:string,cardId?:string,force=false):Promise<Job|undefined>{
  if(closed||!enabled)return;
  const p=await getPreviewProject(projectId);if(!demoInput(p).cards.length)return;
  const existing=(await listJobs(projectId)).find(j=>j.kind==='demo'&&['queued','running'].includes(j.status));if(existing)return existing;
  const r=currentDemo(p);if(!force&&r&&r.inputKey===demoInputKey(p)&&r.basisKey===demoBasisKey(p))return;
  let job:Job;try{job=await newJob(projectId,'demo','Agent 正在生成可交互原型');}catch(e){if(e instanceof ConflictError)return (await listJobs(projectId)).find(j=>j.kind==='demo'&&['queued','running'].includes(j.status));throw e;}job.result={requestedCardId:cardId};
  setImmediate(()=>{void process(job).catch(()=>console.error('原型任务状态保存失败'));});return job;
 }
 async function process(job:Job){
  const started=performance.now();
  let stale=false;const controller=new AbortController();controllers.add(controller);let watch:ReturnType<typeof setInterval>|undefined;
  try{
   job.status='running';await putJob(job);await prepare();
   const waitUntil=Date.now()+600000;
   while(!closed&&(await listJobs(job.projectId)).some(j=>['listen','suggest'].includes(j.kind)&&['queued','running'].includes(j.status))){
    if(Date.now()>waitUntil)throw new Error('讨论整理尚未完成，请稍后更新原型。');
    if(job.label!=='等待本轮讨论整理完成'){job.label='等待本轮讨论整理完成';await putJob(job);}
    await new Promise(resolve=>setTimeout(resolve,500));
   }
   if(closed)return;
   const p=await getPreviewProject(job.projectId),basis=demoBasisKey(p),key=demoInputKey(p),prior=currentDemo(p);
   if(generate===generateDemoCode&&build===buildAndCheck){
    const guard=async()=>{if(closed)throw Error('服务正在停止');if(demoBasisKey(await getPreviewProject(p.id))!==basis){stale=true;const error=new ConflictError('需求已有更新，旧原型未发布，正在按最新内容重新生成。');controller.abort(error);throw error;}controller.signal.throwIfAborted();};
    watch=setInterval(()=>{void guard().catch(()=>{});},1500);watch.unref();
    const result=await buildModularDemo(p,prior,{guard,previewFirst:true,requestedCardId:(job.result as {requestedCardId?:string})?.requestedCardId,signal:controller.signal,progress:async label=>{job.label=label;await putJob(job);}});
    let published:DemoRevision|undefined;
    await guard();await mutateProject(p.id,current=>{
     if(demoBasisKey(current)!==basis){stale=true;throw new ConflictError('需求已有更新，旧原型未发布。');}
     published={...result,id:randomUUID(),number:(current.generatedDemo?.revisions.at(-1)?.number||0)+1,createdAt:new Date().toISOString(),inputKey:key,basisKey:basis,draft:isDemoDraft(current),cardIds:demoInput(current).cards.map(c=>c.id),model:config.model,parentId:prior?.id};appendDemo(current,published);
    });
    job.status='succeeded';job.label=`原型已可操作 · 后台继续检查`;job.result={artifactId:result.artifactId,sourceHash:result.sourceHash,reused:result.reused,timings:result.timings};if(published)verifyLater(p.id,published);return;
   }
   const retry=(await listJobs(p.id)).find(j=>j.status==='failed'&&(j.result as {basisKey?:string})?.basisKey===basis&&(j.result as {candidateArtifactId?:string})?.candidateArtifactId)?.result as {candidateArtifactId:string;lastCheckFailure?:string}|undefined;
   let files=await readDemoSource(p.id,prior),failure='',cached:ReturnType<typeof demoCodeSchema.parse>|undefined;
   if(retry){try{const source=await readDemoSource(p.id,{artifactId:retry.candidateArtifactId});const proposal=demoCodeSchema.parse(JSON.parse(await readFile(path.join(artifactDir(p.id,retry.candidateArtifactId),'proposal.json'),'utf8')));files=source;cached=proposal;failure=retry.lastCheckFailure||'';}catch{/* Interrupted staging is not a reusable artifact; keep the last published sources. */}}
   for(let attempt=0;attempt<3;attempt++){
    if(closed)return;
    job.label=attempt?`Agent 正在修复原型 · 第 ${attempt} 次`:'Agent 正在编写原型页面与交互';await putJob(job);
    const result=cached?{files,proposal:cached as import('../shared/generated-demo.ts').DemoCodeProposal}:await generate(p,files,failure||undefined,async characters=>{job.result={...job.result as object,generatedCharacters:characters};await putJob(job);});cached=undefined;files=result.files;
    if(closed)return;
    if(demoBasisKey(await getPreviewProject(p.id))!==basis){stale=true;throw new ConflictError('讨论已有更新，本次旧原型未发布，正在按最新需求重新生成。');}
    const artifactId=randomUUID();job.result={...job.result as object,candidateArtifactId:artifactId,basisKey:basis,inputKey:key};job.label='正在运行原型并检查交互';await putJob(job);
    try{
     const report=await build(p.id,artifactId,files,result.proposal);
     if(closed)return;
     await mutateProject(p.id,current=>{
      if(demoBasisKey(current)!==basis){stale=true;throw new ConflictError('需求已有更新，本次旧原型未发布。');}
      appendDemo(current,{id:randomUUID(),artifactId,number:(current.generatedDemo?.revisions.at(-1)?.number||0)+1,createdAt:new Date().toISOString(),inputKey:key,basisKey:basis,draft:isDemoDraft(current),summary:result.proposal.summary,viewport:result.proposal.viewport,cardIds:demoInput(current).cards.map(c=>c.id),bindings:result.proposal.bindings,assumptions:result.proposal.assumptions,checksPassed:report.checks.length,sourceHash:digest(files),model:config.model,parentId:prior?.id});
     });
     job.status='succeeded';job.label=`原型已更新 · ${report.checks.length} 项交互检查通过`;job.result={artifactId,sourceHash:digest(files),attempts:attempt+1};return;
    }catch(e){if(stale)throw e;failure=JSON.stringify({error:e instanceof Error?e.message:'原型检查失败',requiredChecks:result.proposal.checks,instruction:'修复代码或不准确的定位；保持原检查意图和业务结果，不能删除失败的业务场景来通过检查。'});job.result={...job.result as object,lastCheckFailure:failure.slice(0,5000)};if(attempt===2)throw new Error('原型暂未通过运行检查，上一版已保留。可以重试或继续讨论后再更新。');}
   }
  }catch(e){job.status='failed';job.error=e instanceof Error?e.message:'Demo 生成未完成，上一版已保留。';}
  finally{
   if(watch)clearInterval(watch);controllers.delete(controller);
   if(closed){job.status='failed';job.error='服务已重启，未完成的原型可以重试。';}
   job.finishedAt=new Date().toISOString();await putJob(job);
   recordMetric('demo.job.total',performance.now()-started,{failed:job.status==='failed'});
   if(stale&&!closed)await enqueue(job.projectId);
  }
 }
 return {enqueue,resume,close:()=>{closed=true;for(const c of controllers)c.abort(new Error('服务正在停止'));}};
}
