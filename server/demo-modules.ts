import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import type {Project} from '../shared/types';
import type {DemoModule,DemoRevision,DemoCodeProposal,DemoTimings} from '../shared/generated-demo';
import {prototypeStateSource,prototypePersona,moduleShell} from '../shared/prototype-shell';
import {demoInput,demoInputKey,demoOverviews,digest,validateDemoProposal} from './demo-schema';
import {preferredDemoViewport} from '../shared/demo-viewport';
import {isNamedModule} from '../shared/card-organization';
import {artifactDir,buildAndCheck,buildPreview,readDemoSource,readDemoProposal,DemoBindingCheckError} from './demo-builder';
import {repairDemoBindings} from './demo-locator-repair';
import {generateDemoCode,BusinessContractChangeRequired,type ModuleContext} from './demo-generator';
import {recordMetric} from './metrics';
import {prepareBusinessContract} from './demo-business-contract';
import type {DemoBusinessContract} from '../shared/generated-demo';
import {businessRuntimeKey,extendBusinessFields,type BusinessFieldAddition} from './demo-business-fields';
import {recordedInterfaceTitles} from '../shared/interface-title';
import {prototypeTitlePatch} from './demo-title-patch';

export function planDemoModules(p:Project,previous:DemoModule[]=[],businessContract?:DemoBusinessContract,isolateChanges=false){
 const effective=new Map(demoInput(p).cards.map(c=>[c.id,c]));
 const cards=p.cards.flatMap(c=>effective.has(c.id)?[effective.get(c.id)!]:[]),groups=new Map<string,typeof cards>();
 for(const card of cards){const key=card.module.trim()&&isNamedModule(card.module)?`named:${card.module.trim()}`:'unclassified';groups.set(key,[...groups.get(key)||[],card]);}
 const plans=[...groups].map(([key,items])=>{
  const id='module-'+digest(key).slice(0,16),name=key.startsWith('named:')?key.slice(6):p.name;
  // The same overview content participates in project reuse, module reuse and generation.
  const common=demoOverviews(p);
  const moduleKey=(business:string|null)=>digest({name,cards:[...items].sort((a,b)=>a.id.localeCompare(b.id)),common,project:p.name,reference:p.demo||null,contract:digest({source:prototypeStateSource,persona:prototypePersona,business})});
  return {id,name,cardIds:items.map(c=>c.id),inputKey:moduleKey(businessContract?businessRuntimeKey(businessContract):null),legacyInputKey:moduleKey(businessContract?.source||null),common,previous:previous.find(m=>m.id===id)};
 });
 const ids=new Set(plans.map(m=>m.id)),changed=new Set(plans.filter(m=>m.inputKey!==m.previous?.inputKey&&m.legacyInputKey!==m.previous?.inputKey).map(m=>m.id));
 for(const m of plans)if(m.previous?.dependencies.some(id=>!ids.has(id)))changed.add(m.id);
 for(let i=0;!isolateChanges&&i<plans.length;i++){let added=false;for(const m of plans)if(!changed.has(m.id)&&m.previous?.dependencies.some(id=>changed.has(id)||!ids.has(id))){changed.add(m.id);added=true;}if(!added)break;}
 return plans.map(m=>({...m,changed:changed.has(m.id)}));
}

let active=0;const waiters:(()=>void)[]=[];
async function modelSlot<T>(run:()=>Promise<T>){
 if(waiters.length>=64)throw Error('原型生成任务较多，请稍后重试；已有原型保持可用。');
 if(active>=2)await new Promise<void>((resolve,reject)=>{
  const ready=()=>{clearTimeout(timer);resolve();};
  const timer=setTimeout(()=>{const index=waiters.indexOf(ready);if(index>=0)waiters.splice(index,1);reject(Error('原型任务排队超时，请稍后重试。'));},600000);
  waiters.push(ready);
 });else active++;
 try{return await run();}finally{const next=waiters.shift();if(next)next();else active--;}
}
const blankTimings=():DemoTimings=>({queueMs:0,generationMs:0,buildMs:0,checkMs:0,totalMs:0});
export async function buildModularDemo(p:Project,prior:DemoRevision|undefined,options:{guard:()=>Promise<void>;progress:(label:string)=>Promise<void>;generate?:typeof generateDemoCode;build?:typeof buildAndCheck;repairBindings?:typeof repairDemoBindings;previewFirst?:boolean;requestedCardId?:string;signal?:AbortSignal;resolvedContract?:DemoBusinessContract}):Promise<Pick<DemoRevision,'artifactId'|'modules'|'businessContract'|'viewport'|'summary'|'bindings'|'assumptions'|'checksPassed'|'sourceHash'|'verification'>&{modules:DemoModule[];timings:DemoTimings;reused:number}>{
 const start=performance.now();
 await options.guard();
 await options.progress('正在核对模块间业务数据');
 const optimistic=!!(options.previewFirst&&prior?.businessContract&&!options.resolvedContract);
 const contractStarted=performance.now();
 const contractProgress=async(characters:number)=>{await options.progress(`正在同步模块间数据 · ${characters?`已接收 ${characters.toLocaleString('zh-CN')} 字`:'等待模型响应'}`);};
 let businessContract=options.resolvedContract||(optimistic?{...prior!.businessContract!,inputKey:demoInputKey(p)}:(!options.generate||options.generate===generateDemoCode)?await modelSlot(()=>prepareBusinessContract(p,prior?.businessContract,options.signal,contractProgress)):prior?.businessContract);
 const contractMs=performance.now()-contractStarted;
 await options.guard();
 const plans=planDemoModules(p,prior?.modules,businessContract,!!options.previewFirst&&!!businessContract),viewport=preferredDemoViewport(p,prior?.viewport),generate=options.generate||generateDemoCode,build=options.build||(options.previewFirst?buildPreview:buildAndCheck);
 const groupAbort=new AbortController(),signal=options.signal?AbortSignal.any([options.signal,groupAbort.signal]):groupAbort.signal;
 const executionPlans=[...plans].sort((a,b)=>Number(b.cardIds.includes(options.requestedCardId||''))-Number(a.cardIds.includes(options.requestedCardId||'')));
 const modules:DemoModule[]=[],proposals=new Map<string,DemoCodeProposal>(),sources:Record<string,string>={},timings:DemoTimings={...blankTimings(),contractMs},additions:BusinessFieldAddition[]=[];let reused=0,reusedChecks=0;
 const runModule=async(plan:(typeof plans)[number])=>{
  await options.guard();let old=plan.previous;let previousFailure:string|undefined;
  if(!plan.changed&&old){
   try{const dir=artifactDir(p.id,old.artifactId),files=await readDemoSource(p.id,old),proposal=await readDemoProposal(p.id,old.artifactId),html=await readFile(path.join(dir,'output/index.html'),'utf8'),report=JSON.parse(await readFile(path.join(dir,'output/report.json'),'utf8').catch(error=>{if(!options.previewFirst)throw error;return readFile(path.join(dir,'output/preview-report.json'),'utf8');}));
    if(report.errors?.length)previousFailure=JSON.stringify({error:report.errors,checks:proposal.checks,instruction:'保留检查意图，只修复本次失败的交互或错误定位。'});
    if(digest(files)!==old.sourceHash||report.sourceHash!==old.sourceHash||digest(html)!==report.htmlHash||!report.build||report.errors.length||report.checks.some((c:{passed:boolean})=>!c.passed))throw Error('缓存产物校验失败');
    modules.push({...old,inputKey:plan.inputKey});proposals.set(plan.id,proposal);for(const [file,code]of Object.entries(files))sources[`modules/${plan.id}/${file}`]=code;reused++;reusedChecks+=report.checks.length;recordMetric('demo.module.cache_hit',0);return;}catch(error){previousFailure||=String(error);if(!options.previewFirst)old=undefined;}
  }
  const scoped={...p,cards:p.cards.filter(c=>plan.cardIds.includes(c.id)),materials:[],snapshots:[],deliveries:[],events:[],intakeBatches:[],generatedDemo:undefined};
  const moduleViewport={width:viewport.width,height:Math.max(320,viewport.height-44)},context:ModuleContext={businessContract,previewOnly:!!options.previewFirst,allowContractRequest:optimistic,signal,id:plan.id,name:plan.name,persona:prototypePersona,common:plan.common,catalog:plans.map(m=>({id:m.id,name:m.name})),dependencies:plans.filter(m=>m.id!==plan.id).map(m=>({id:m.id,name:m.name,requirements:demoInput(p).cards.filter(c=>m.cardIds.includes(c.id)).map(({id,title,fields})=>({id,title,fields}))})),viewport:moduleViewport};
  let files:Record<string,string>={};if(old)try{files=await readDemoSource(p.id,old);}catch{}
  if(options.previewFirst&&old)try{context.previousProposal=await readDemoProposal(p.id,old.artifactId);}catch{}
  // A legacy single-module application can be migrated without discarding its source.
  if(!old&&prior&&!prior.modules&&plans.length===1)files=await readDemoSource(p.id,prior).catch(()=>({}));
  const reusableSource=old&&digest(files)===old.sourceHash;
  files={...files,'src/prototype-state.ts':prototypeStateSource,...businessContract?{'src/prototype-business.ts':businessContract.source}:{}};let failure:string|undefined=previousFailure,candidate:Awaited<ReturnType<typeof generateDemoCode>>|undefined;
  if(old&&reusableSource&&context.previousProposal&&!failure&&generate===generateDemoCode
    && demoInput(scoped).cards.some(card=>recordedInterfaceTitles(card.fields.flow).length)){
   try{
    const previous=JSON.parse(await readFile(path.join(artifactDir(p.id,old.artifactId),'verification-context.json'),'utf8')) as {project:Project;common:unknown[]};
    if(digest(previous.common)===digest(plan.common)){
     const patch=prototypeTitlePatch(scoped,previous.project,files,context.previousProposal);
     if(patch)candidate=validateDemoProposal(patch,scoped,files,true);
    }
   }catch{/* Older artifacts can still go through the regular generation path. */}
  }
  const mt:DemoTimings={...blankTimings(),modelCalls:0,validationRepairs:0},moduleStart=performance.now();let attempts=0,bindingRepaired=false;
  context.onRepair=()=>{mt.validationRepairs!++;};
  while(attempts<3||candidate){
   await options.guard();
   await options.progress(`${plan.name} · ${attempts?'正在修复交互':'正在生成模块'}（${modules.length+1}/${plans.length}）`);
   if(!candidate){attempts++;bindingRepaired=false;}
   const queuedAt=performance.now();const result=candidate||await modelSlot(async()=>{await options.guard();const generatedAt=performance.now();mt.queueMs=(mt.queueMs||0)+generatedAt-queuedAt;try{return await generate(scoped,files,failure,async characters=>{if(!characters)mt.modelCalls!++;await options.progress(`${plan.name} · ${characters?`已接收 ${characters.toLocaleString('zh-CN')} 字`:'等待模型响应'}`);},context);}finally{mt.generationMs+=performance.now()-generatedAt;}});candidate=undefined;files=result.files;await options.guard();
   if(result.businessFieldAdditions){additions.push(...result.businessFieldAdditions);context.businessContract=result.businessContract;}
   const artifactId=randomUUID();await options.progress(`${plan.name} · ${options.previewFirst?'正在准备可操作预览':'正在构建并检查'}`);
   const builtAt=performance.now();
   try{
    const report=await build(p.id,artifactId,files,result.proposal);mt.buildMs+=report.timings?.buildMs??performance.now()-builtAt;mt.checkMs+=report.timings?.checkMs||0;
    if(options.previewFirst&&generate===generateDemoCode){
     const input=demoInput(scoped);const validationProject={...scoped,cards:scoped.cards.map(c=>({...c,fields:input.cards.find(v=>v.id===c.id)!.fields,messages:[],suggestion:undefined,history:[],confirmations:[],approvals:{},provenance:{},sources:[],assessments:[],followUps:[]}))};
     await writeFile(path.join(artifactDir(p.id,artifactId),'verification-context.json'),JSON.stringify({project:validationProject,common:plan.common}));
    }
    await options.guard();mt.totalMs=performance.now()-moduleStart;
    const module:DemoModule={id:plan.id,name:plan.name,cardIds:plan.cardIds,inputKey:plan.inputKey,artifactId,dependencies:result.proposal.dependencies||[],summary:result.proposal.summary,viewport:moduleViewport,timings:mt,sourceHash:digest(files)};
    modules.push(module);proposals.set(plan.id,result.proposal);for(const [file,code]of Object.entries(files))sources[`modules/${plan.id}/${file}`]=code;break;
   }catch(error){
    await options.guard();mt.buildMs+=performance.now()-builtAt;
    if(options.previewFirst)context.previousProposal=result.proposal;
    if(error instanceof DemoBindingCheckError&&!bindingRepaired){
     await options.progress(`${plan.name} · 正在修复需求定位`);const queued=performance.now();
     candidate=await modelSlot(async()=>{await options.guard();const at=performance.now();mt.queueMs=(mt.queueMs||0)+at-queued;try{return await (options.repairBindings||repairDemoBindings)(scoped,files,result.proposal,{message:error.message,bindingIndex:error.bindingIndex});}finally{mt.generationMs+=performance.now()-at;}});bindingRepaired=true;
    }else{
     if(attempts===3)throw error;
     failure=JSON.stringify({error:error instanceof Error?error.message:'模块检查失败',bindings:result.proposal.bindings,checks:result.proposal.checks,inputLengths:result.proposal.checks.flatMap((c,check)=>c.steps.flatMap((s,step)=>s.action==='fill'?[{check,step,testId:s.testId,length:s.value!.length}]:[])),instruction:'保留原有业务检查意图与有效需求定位，修复失败场景。核对输入实际长度，边界输入采用 textLengthSamples 的单字符 value 加 repeat，不要把未超上限的文本当超限。提交成功清空表单后再次提交必须重填全部必填项。'});
    }
   }
  }
  timings.queueMs=(timings.queueMs||0)+(mt.queueMs||0);timings.generationMs+=mt.generationMs;timings.buildMs+=mt.buildMs;timings.checkMs+=mt.checkMs;timings.modelCalls=(timings.modelCalls||0)+(mt.modelCalls||0);timings.validationRepairs=(timings.validationRepairs||0)+(mt.validationRepairs||0);recordMetric('demo.module.queue',mt.queueMs||0);recordMetric('demo.module.generate',mt.generationMs);recordMetric('demo.module.build',mt.buildMs);recordMetric('demo.module.check',mt.checkMs);
 };
 let next=0,failure:unknown;
 const workers=await Promise.allSettled(Array.from({length:Math.min(2,plans.length)},async()=>{
  while(next<plans.length&&!failure){const plan=executionPlans[next++];try{await runModule(plan);}catch(error){if(!failure||error instanceof BusinessContractChangeRequired)failure=error;if(error instanceof BusinessContractChangeRequired)groupAbort.abort(error);throw error;}}
 }));
 if(failure instanceof BusinessContractChangeRequired&&optimistic){
  await options.guard();await options.progress('本次涉及数据字段变化，正在同步相关模块');
  const fallbackStarted=performance.now();
  const resolvedContract=await modelSlot(()=>prepareBusinessContract(p,prior?.businessContract,options.signal,contractProgress));
  const fallbackContractMs=performance.now()-fallbackStarted;
  const result=await buildModularDemo(p,prior,{...options,resolvedContract});
  result.timings.contractMs=(result.timings.contractMs||0)+contractMs+fallbackContractMs;
  result.timings.totalMs=performance.now()-start;return result;
 }
 if(failure)throw failure;for(const worker of workers)if(worker.status==='rejected')throw worker.reason;
 if(additions.length&&businessContract)businessContract=extendBusinessFields(businessContract,additions);
 modules.sort((a,b)=>plans.findIndex(p=>p.id===a.id)-plans.findIndex(p=>p.id===b.id));
 await options.guard();const artifactId=randomUUID(),dir=artifactDir(p.id,artifactId);await mkdir(path.join(dir,'output'),{recursive:true});
 const links=modules.map(m=>({id:m.id,name:m.name,cardIds:m.cardIds,url:`/api/projects/${p.id}/demo/artifacts/${m.artifactId}/index.html`}));
 await writeFile(path.join(dir,'output/index.html'),moduleShell(p.id,links));await writeFile(path.join(dir,'sources.json'),JSON.stringify(sources));
 const all=[...proposals.values()],checks=all.flatMap(p=>p.checks),bindings=all.flatMap(p=>p.bindings),assumptions=[...new Set(all.flatMap(p=>p.assumptions))];
 const summary=`更新 ${modules.length-reused} 个业务模块，复用 ${reused} 个模块。`+modules.filter(m=>plans.find(p=>p.id===m.id)?.changed).map(m=>m.summary).join(' ');
 await writeFile(path.join(dir,'proposal.json'),JSON.stringify({summary,viewport,files:[],deletePaths:[],bindings,checks,assumptions}));
 timings.totalMs=performance.now()-start;await writeFile(path.join(dir,options.previewFirst?'output/preview-report.json':'output/report.json'),JSON.stringify({build:true,checks:options.previewFirst?[]:checks.map(c=>({name:c.name,passed:true})),errors:[],modules,timings,reused}));
 recordMetric('demo.project.total',timings.totalMs);
 return {artifactId,modules,businessContract,viewport,summary,bindings,assumptions,verification:options.previewFirst?{status:'pending' as const,total:checks.length,passed:reusedChecks,startedAt:new Date().toISOString(),errors:[] as string[]}:undefined,checksPassed:options.previewFirst?reusedChecks:checks.length,sourceHash:digest(sources),timings,reused};
}
