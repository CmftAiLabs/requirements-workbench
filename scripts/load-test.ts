import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import pg from 'pg';
import {parse} from 'dotenv';
import type {FastifyInstance} from 'fastify';
import type {Bootstrap,Project} from '../shared/types';
import type {WorkspaceSync} from '../shared/workspace-sync';
import {applyStatePatches} from '../shared/workspace-sync';

// Real HTTP and PostgreSQL, synthetic projects, no model calls and no production writes.
const arg=(name:string,fallback:string)=>process.argv.find(s=>s.startsWith(`--${name}=`))?.split('=')[1]||fallback;
const concurrency=Number(arg('concurrency','20')),requests=Number(arg('requests','200')),sizes=arg('sizes','100,300,1000').split(',').map(Number);
assert.ok(Number.isInteger(concurrency)&&concurrency>=1&&concurrency<=64);assert.ok(Number.isInteger(requests)&&requests>=1&&requests<=2000);assert.ok(sizes.every(n=>Number.isInteger(n)&&n>=1&&n<=2000));
const durationSeconds=Number(arg('duration','3'));assert.ok(Number.isFinite(durationSeconds)&&durationSeconds>=0&&durationSeconds<=60);
const writeCount=Number(arg('writes','64'));assert.ok(Number.isInteger(writeCount)&&writeCount>=1&&writeCount<=10000);
const reportFile=path.resolve(arg('report','.work/scaling/load-test.json'));
let sourceURL=process.env.TEST_DATABASE_URL||process.env.DATABASE_URL;
if(!sourceURL)sourceURL=parse(await readFile(new URL('../.env',import.meta.url))).DATABASE_URL;
assert.ok(sourceURL,'请配置本地 PostgreSQL DATABASE_URL');
const dbName=`requirements_load_${process.pid}_${randomUUID().slice(0,8)}`,testURL=new URL(sourceURL);testURL.pathname='/'+dbName;
const admin=new pg.Pool({connectionString:sourceURL,max:1});let created=false,app:FastifyInstance|undefined,store:typeof import('../server/store')|undefined,dataDir='';
const scenarios:unknown[]=[];
const stats=(values:number[])=>{const a=[...values].sort((a,b)=>a-b),p=(n:number)=>a[Math.max(0,Math.ceil(a.length*n)-1)]||0;return {count:a.length,p50Ms:+p(.5).toFixed(2),p95Ms:+p(.95).toFixed(2),maxMs:+(a.at(-1)||0).toFixed(2)};};
try{
 await admin.query(`CREATE DATABASE "${dbName}"`);created=true;
 process.env.DATABASE_URL=testURL.toString();process.env.MODEL_API_KEY='';process.env.SESSION_SECRET='load-test-session-secret-for-isolated-database-only';
 process.env.KNOWLEDGE_DELIVERY_URL='';process.env.TEAMMATE_DELIVERY_URL='';process.env.KNOWLEDGE_DELIVERY_TOKEN='';process.env.TEAMMATE_DELIVERY_TOKEN='';
 const {config}=await import('../server/config');dataDir=await mkdtemp(path.join(tmpdir(),'req-load-'));config.dataDir=dataDir;
 store=await import('../server/store');await store.initStore();const {buildApp}=await import('../server/app');app=await buildApp();const address=await app.listen({port:0,host:'127.0.0.1'});
 const {createCRMExperience}=await import('../server/experience'),{compactProject}=await import('../server/workspace-sync'),{planDemoModules}=await import('../server/demo-modules');
 const http=async(url:string,body?:unknown,allowConflict=false)=>{
  const start=performance.now(),response=await fetch(address+url,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'content-type':'application/json',origin:address,Prefer:'return=minimal'},...body===undefined?{}:{body:JSON.stringify(body)}}),text=await response.text();
  assert.ok(response.ok||allowConflict&&response.status===409,`HTTP ${response.status} at ${url.split('?')[0]}`);return {status:response.status,value:text?JSON.parse(text):null,ms:performance.now()-start,bytes:Buffer.byteLength(text)};
 };
 for(const size of sizes){
  const project=createCRMExperience(),template=structuredClone(project.cards[1]);project.name=`合成压测 ${size} 张需求`;project.cards=[];project.snapshots=[];project.deliveries=[];project.events=[];
  for(let i=0;i<size;i++)project.cards.push({...structuredClone(template),id:`load-card-${i}`,title:`合成业务需求 ${i}`,organization:{module:`业务模块 ${Math.floor(i/20)}`,priority:'正常沟通',reason:'合成压测分组'},messages:Array.from({length:100},(_,m)=>({id:`load-${i}-${m}`,role:'business',text:`合成讨论 ${i}/${m}：`+'业务条件与异常边界。'.repeat(8),createdAt:new Date(1700000000000+m*1000).toISOString()}))});
  project.materials=Array.from({length:Math.ceil(size/5)},(_,i)=>({...structuredClone(project.materials[0]),id:`load-material-${i}`,name:`合成材料 ${i}`,text:'合成资料正文，仅用于本地性能测试。'.repeat(1000)}));
  await store.insertProject(project);
  const legacy=await http(`/api/projects/${project.id}`),initial=await http(`/api/workspace/sync?projectId=${project.id}`),snapshot=initial.value as Extract<WorkspaceSync,{kind:'snapshot'}>;assert.equal(snapshot.kind,'snapshot');let client:Bootstrap=snapshot.value,cursor=snapshot.cursor;
  assert.equal(client.project.cards.length,size);assert.ok(client.project.cards.every(c=>c.messageCount===100&&c.messages.length===4));assert.ok(client.project.materials.every(m=>!m.text&&m.textAvailable));
  const durations:number[]=[],bytes:number[]=[];let taken=0;const phaseStart=performance.now(),phaseEnd=phaseStart+durationSeconds*1000;
  await Promise.all(Array.from({length:concurrency},async()=>{while(taken<requests||performance.now()<phaseEnd){taken++;const response=await http(`/api/workspace/sync?projectId=${project.id}&cursor=${cursor}`);assert.equal(response.value.kind,'unchanged');durations.push(response.ms);bytes.push(response.bytes);}}));
  const phaseMs=performance.now()-phaseStart;
  const writeTimes:number[]=[],tags=Array.from({length:writeCount},()=>`压测写入-${randomUUID()}`);let writeIndex=0,conflicts=0;
  let writing=true;const mixedTimes:number[]=[],mixedBytes:number[]=[];let mixedSnapshots=0;
  const readers=Array.from({length:Math.min(8,concurrency)},async()=>{let state=client,token=cursor;while(writing){const response=await http(`/api/workspace/sync?projectId=${project.id}&cursor=${token}`),update=response.value as WorkspaceSync;if(update.kind==='snapshot'){state=update.value;mixedSnapshots++;}else if(update.kind==='delta'){assert.equal(update.base,token);state=applyStatePatches(state,update.patches);}token=update.cursor;mixedTimes.push(response.ms);mixedBytes.push(response.bytes);}});
  const writers=Promise.all(Array.from({length:4},async()=>{while(writeIndex<tags.length){const tag=tags[writeIndex++],started=performance.now();let success=false;for(let attempt=0;attempt<128;attempt++){const response=await http(`/api/projects/${project.id}/actions`,{stamp:client.project.stamp,action:{type:'message',cardId:project.cards[0].id,text:tag,baseRevision:client.project.cards[0].revision,baseRound:client.project.cards[0].round,clientMessageId:tag}},true);if(response.status===204){success=true;break;}conflicts++;await new Promise(r=>setTimeout(r,5));}assert.ok(success,'并发写入重试耗尽');writeTimes.push(performance.now()-started);}})).finally(()=>{writing=false;});
  const outcomes=await Promise.allSettled([writers,...readers]);for(const outcome of outcomes)if(outcome.status==='rejected')throw outcome.reason;
  const fresh=(await http(`/api/workspace/sync?projectId=${project.id}`)).value as Extract<WorkspaceSync,{kind:'snapshot'}>;assert.equal(fresh.kind,'snapshot');client=fresh.value;cursor=fresh.cursor;
  const finalTag=`压测增量-${randomUUID()}`;tags.push(finalTag);await http(`/api/projects/${project.id}/actions`,{stamp:client.project.stamp,action:{type:'message',cardId:project.cards[0].id,text:finalTag,baseRevision:client.project.cards[0].revision,baseRound:client.project.cards[0].round,clientMessageId:finalTag}});
  const delta=await http(`/api/workspace/sync?projectId=${project.id}&cursor=${cursor}`),change=delta.value as WorkspaceSync;assert.equal(change.kind,'delta');if(change.kind==='delta'){client=applyStatePatches(client,change.patches);cursor=change.cursor;}
  const persisted=await store.getProject(project.id);assert.equal(persisted.cards[0].messages.length,100+tags.length);for(const tag of tags)assert.ok(persisted.cards[0].messages.some(m=>m.text===tag));assert.deepEqual(client.project,compactProject(persisted));
  const plans=planDemoModules(project),previous=plans.map(m=>({id:m.id,name:m.name,cardIds:m.cardIds,inputKey:m.inputKey,artifactId:'fixture',dependencies:[],summary:'fixture',viewport:{width:1280,height:756},timings:{generationMs:0,buildMs:0,checkMs:0,totalMs:0},sourceHash:'fixture'}));project.cards[0].fields.acceptance+=' 合成规则更新';const changedModules=planDemoModules(project,previous).filter(m=>m.changed);
  assert.equal(changedModules.length,1);assert.equal(conflicts,0,'同修订的独立并发发言不应产生版本冲突');
  const result={cards:size,messages:size*100,materials:project.materials.length,concurrency,requests:durations.length,durationSeconds,baselineFull:{bytes:legacy.bytes,ms:+legacy.ms.toFixed(2)},compactInitial:{bytes:initial.bytes,ms:+initial.ms.toFixed(2),reductionPercent:+((1-initial.bytes/legacy.bytes)*100).toFixed(2)},unchanged:{...stats(durations),meanBytes:Math.round(bytes.reduce((a,b)=>a+b,0)/bytes.length),requestsPerSecond:+(durations.length/phaseMs*1000).toFixed(2)},mixedReads:{...stats(mixedTimes),meanBytes:Math.round(mixedBytes.reduce((a,b)=>a+b,0)/mixedBytes.length),snapshotFallbacks:mixedSnapshots},writes:{...stats(writeTimes),concurrency:4,conflictsRetried:conflicts,noMessagesLost:true},delta:{bytes:delta.bytes,ms:+delta.ms.toFixed(2),reconstructed:true},moduleInvalidation:{total:plans.length,changed:changedModules.length,requirementsSent:changedModules[0].cardIds.length,modelCallsMade:0}};
  scenarios.push(result);console.log(JSON.stringify(result));
  assert.ok(result.compactInitial.reductionPercent>=80,'首屏传输缩减不足 80%');
  assert.ok(result.unchanged.p95Ms<=Number(arg('max-read-p95-ms','200')),'无变化读取 P95 超出预算');
  assert.ok(result.writes.p95Ms<=Number(arg('max-write-p95-ms','1000')),'并发讨论写入 P95 超出预算');
  assert.ok(result.mixedReads.p95Ms<=Number(arg('max-mixed-p95-ms','1000')),'混合负载读取 P95 超出预算');

 }
 const report={createdAt:new Date().toISOString(),node:process.version,platform:`${process.platform}/${process.arch}`,isolation:'temporary PostgreSQL database and local HTTP server; paid models disabled',scenarios};await mkdir(path.dirname(reportFile),{recursive:true});await writeFile(reportFile,JSON.stringify(report,null,2));console.log(`压测报告：${reportFile}`);
}finally{
 await app?.close();await store?.pool.end();if(dataDir)await rm(dataDir,{recursive:true,force:true});if(created)await admin.query(`DROP DATABASE "${dbName}" WITH (FORCE)`);await admin.end();
}
