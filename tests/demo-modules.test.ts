import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createCRMExperience} from '../server/experience';
import {config} from '../server/config';
import {planDemoModules,buildModularDemo} from '../server/demo-modules';
import {artifactDir,DemoBindingCheckError} from '../server/demo-builder';
import {demoBasisKey,demoInputKey,validateDemoProposal,digest} from '../server/demo-schema';
import {prototypeStateSource,moduleShell} from '../shared/prototype-shell';
import type {DemoRevision} from '../shared/generated-demo';
import type {generateDemoCode} from '../server/demo-generator';
import type {buildAndCheck} from '../server/demo-builder';

test('未分组需求共享一个完整原型，避免把一张卡误当成一个页面',()=>{
 const p=createCRMExperience();p.cards=p.cards.filter(c=>c.included);p.cards.forEach(c=>c.organization={module:'未分组',priority:'正常沟通',reason:'尚未分类'});
 const plans=planDemoModules(p);assert.equal(plans.length,1);assert.equal(plans[0].name,p.name);assert.deepEqual(plans[0].cardIds,p.cards.map(c=>c.id));
});

test('业务契约变化会使全部模块重新生成，避免新旧数据接口混用',()=>{
 const p=createCRMExperience();p.cards=p.cards.filter(c=>c.included);p.cards.forEach((c,i)=>c.organization={module:`模块${i}`,priority:'正常沟通',reason:'联动业务'});
 const a={inputKey:'old',summary:'共享单据',source:'export type BusinessState = {orders:unknown[]}'},b={...a,inputKey:'new',source:'export type BusinessState = {orders:unknown[];receipts:unknown[]}'};
 const first=planDemoModules(p,[],a),second=planDemoModules(p,[],b);
 assert.equal(first.length,2);assert.ok(first.every((m,i)=>m.inputKey!==second[i].inputKey));
 assert.deepEqual(planDemoModules(p,[],{...a,inputKey:'text-only'}).map(m=>m.inputKey),first.map(m=>m.inputKey),'文本更新但数据接口不变时保留模块复用机会');
});

test('模块构建期间需求过期时停止，避免再次请求模型修复旧版本',async()=>{
 const p=createCRMExperience();p.cards=p.cards.filter(c=>c.included).slice(0,1);let stale=false,calls=0;
 await assert.rejects(()=>buildModularDemo(p,undefined,{guard:async()=>{if(stale)throw Error('需求已有更新');},progress:async()=>{},generate:async scoped=>{calls++;return validateDemoProposal({summary:'合成交互',files:[{path:'src/App.tsx',content:'export default function App(){return <button>提交</button>}'},{path:'src/styles.css',content:'body{color:blue}'}],bindings:[{cardId:scoped.cards[0].id,field:'flow',testId:'action'}],checks:[{name:'提交',cardIds:[scoped.cards[0].id],steps:[{action:'click',testId:'action'},{action:'expectText',testId:'action',value:'完成'}]}],assumptions:[]},scoped);},build:async()=>{stale=true;return {build:true,checks:[],errors:[]};}}),/需求已有更新/);
 assert.equal(calls,1);
});

test('初始需求定位失败只修复绑定，保留已生成源码和交互检查重新构建',async()=>{
 const oldDir=config.dataDir;config.dataDir=await mkdtemp(path.join(tmpdir(),'req-binding-repair-'));
 try{
  const p=createCRMExperience();p.cards=p.cards.filter(c=>c.included).slice(0,1);let generated=0,repaired=0,built=0;let baseline:unknown;
  const result=await buildModularDemo(p,undefined,{guard:async()=>{},progress:async()=>{},generate:async(scoped,previous)=>{
   generated++;return validateDemoProposal({summary:'提交结果',files:[{path:'src/App.tsx',content:'export default function App(){return <form data-testid="form"><button data-testid="submit">提交</button></form>}'},{path:'src/styles.css',content:'body{color:blue}'}],bindings:[{cardId:scoped.cards[0].id,field:'flow',testId:'submit-result'}],checks:[{name:'提交显示结果',cardIds:[scoped.cards[0].id],steps:[{action:'click',testId:'submit'},{action:'expectText',testId:'submit-result',value:'成功'}]}],assumptions:[]},scoped,previous);
  },repairBindings:async(scoped,files,proposal,failure)=>{
   repaired++;assert.equal(failure.bindingIndex,0);assert.equal(proposal.bindings[0].testId,'submit-result');assert.deepEqual({files,checks:proposal.checks},baseline);
   return validateDemoProposal({...proposal,files:[],edits:[],deletePaths:[],bindings:proposal.bindings.map(b=>({...b,testId:'form'}))},scoped,files);
  },build:async(_project,_id,files,proposal)=>{
   built++;if(built===1){baseline=structuredClone({files,checks:proposal.checks});throw new DemoBindingCheckError("getByTestId('submit-result') not visible",0);}
   assert.deepEqual({files,checks:proposal.checks},baseline);assert.equal(proposal.bindings[0].testId,'form');return {build:true,checks:[{name:'提交显示结果',passed:true}],errors:[]};
  }});
  assert.equal(generated,1);assert.equal(repaired,1);assert.equal(built,2);assert.equal(result.checksPassed,1);assert.equal(result.bindings[0].testId,'form');
 }finally{await rm(config.dataDir,{recursive:true,force:true});config.dataDir=oldDir;}
});

test('模块生成只读本模块源码，未变化模块复用，依赖变化联动重建',async()=>{
 const previousDir=config.dataDir;config.dataDir=await mkdtemp(path.join(tmpdir(),'req-modules-'));
 try{
  const p=createCRMExperience();p.cards=p.cards.filter(c=>c.included);p.cards.forEach((c,i)=>c.organization={module:`模块${i}`,priority:'正常沟通',reason:'fixture'});
  const plan=planDemoModules(p),calls:string[][]=[];let dependent=false;
  const generate:typeof generateDemoCode=async(scoped,previous,_failure,_progress,context)=>{
   assert.ok(context);assert.equal(scoped.cards.length,1);assert.deepEqual(Object.keys(previous),calls.length>=2?['src/prototype-state.ts','src/App.tsx','src/styles.css']:['src/prototype-state.ts']);calls.push(scoped.cards.map(c=>c.id));
   if(dependent&&context.id===plan[1].id){assert.ok(context.dependencies);assert.equal(context.dependencies.length,1);assert.equal(context.dependencies[0].id,plan[0].id);assert.deepEqual(context.dependencies[0].requirements.map(c=>c.id),[p.cards[0].id]);assert.ok(!JSON.stringify(context.dependencies).includes('src/App.tsx'));}
   return validateDemoProposal({summary:'模块交互',dependencies:dependent&&context.id===plan[1].id?[plan[0].id]:[],files:[{path:'src/App.tsx',content:'import React from "react";export default function App(){return <button data-testid="action">提交</button>}'},{path:'src/styles.css',content:'body{color:blue}'}],bindings:[{cardId:scoped.cards[0].id,field:'flow',testId:'action'}],checks:[{name:'提交',cardIds:[scoped.cards[0].id],steps:[{action:'click',testId:'action'},{action:'expectText',testId:'action',value:'完成'}]}],assumptions:[]},scoped,previous);
  };
  const build:typeof buildAndCheck=async(projectId,id,files,proposal)=>{const dir=artifactDir(projectId,id);await mkdir(path.join(dir,'output'),{recursive:true});await writeFile(path.join(dir,'sources.json'),JSON.stringify(files));await writeFile(path.join(dir,'proposal.json'),JSON.stringify(proposal));await writeFile(path.join(dir,'output/index.html'),'<html><body>module</body></html>');await writeFile(path.join(dir,'output/report.json'),JSON.stringify({build:true,checks:[{passed:true}],errors:[],sourceHash:digest(files),htmlHash:digest('<html><body>module</body></html>')}));return {build:true,checks:[{name:'提交',passed:true}],errors:[],timings:{buildMs:1,checkMs:2,totalMs:3}};};
  const options={guard:async()=>{},progress:async()=>{},generate,build};
  const first=await buildModularDemo(p,undefined,options);assert.equal(calls.length,2);assert.equal(first.reused,0);assert.ok(first.modules.every(m=>m.timings.checkMs===2));
  assert.deepEqual(first.modules.map(m=>m.name),p.cards.map(c=>c.organization!.module));
  const revision:DemoRevision={...first,id:'r1',number:1,createdAt:'now',inputKey:demoInputKey(p),basisKey:demoBasisKey(p),draft:false,cardIds:p.cards.map(c=>c.id),model:'fixture'};
  const repeat=await buildModularDemo(p,revision,options);assert.equal(repeat.reused,2);assert.equal(calls.length,2);assert.deepEqual(repeat.modules.map(m=>m.artifactId),first.modules.map(m=>m.artifactId));
  p.cards[0].fields.acceptance+=' changed';const updated=await buildModularDemo(p,revision,options);assert.equal(updated.reused,1);assert.equal(calls.length,3);assert.equal(updated.modules[1].artifactId,first.modules[1].artifactId);assert.notEqual(updated.modules[0].artifactId,first.modules[0].artifactId);
  const dependencyRevision={...revision,modules:first.modules.map((m,i)=>({...m,dependencies:i?[first.modules[0].id]:[]}))};assert.ok(planDemoModules(p,dependencyRevision.modules).every(m=>m.changed));
  dependent=true;const linked=await buildModularDemo(p,dependencyRevision,options);assert.equal(linked.reused,0);assert.equal(calls.length,5);assert.deepEqual(linked.modules[1].dependencies,[first.modules[0].id]);
  assert.ok(prototypeStateSource.includes('useSyncExternalStore'));assert.ok(moduleShell(p.id,[{id:'module-a',name:'</script><script>bad',url:'modules/a.html',cardIds:['a']}]).includes('\\u003c/script>'));
 }finally{await rm(config.dataDir,{recursive:true,force:true});config.dataDir=previousDir;}
});

test('定位修复不占业务修复次数，最后一轮仍可修复定位且总次数有界',async()=>{
 const oldDir=config.dataDir;config.dataDir=await mkdtemp(path.join(tmpdir(),'req-binding-budget-'));
 try{for(const alwaysFail of [false,true]){
  const p=createCRMExperience();p.cards=p.cards.filter(c=>c.included).slice(0,1);let generated=0,repaired=0,built=0;
  const run=()=>buildModularDemo(p,undefined,{guard:async()=>{},progress:async()=>{},generate:async(scoped,previous,failure)=>{
   generated++;if(generated>1){assert.equal(JSON.parse(failure!).inputLengths[0].length,197);assert.match(failure!,/保留原有业务检查意图与有效需求定位/);}
   return validateDemoProposal({summary:'边界检查',files:[{path:'src/App.tsx',content:'export default function App(){return <form data-testid="form"/>}'},{path:'src/styles.css',content:'body{color:blue}'}],bindings:[{cardId:scoped.cards[0].id,field:'flow',testId:'result'}],checks:[{name:'长度边界',cardIds:[scoped.cards[0].id],steps:[{action:'fill',testId:'desc',value:'测'.repeat(197)},{action:'expectVisible',testId:'error'}]}],assumptions:[]},scoped,previous);
  },repairBindings:async(scoped,files,proposal)=>{repaired++;return validateDemoProposal({...proposal,files:[],bindings:proposal.bindings.map(b=>({...b,testId:'form'}))},scoped,files);},build:async()=>{
   built++;if(built%2)throw new DemoBindingCheckError("getByTestId('result') not visible",0);
   if(alwaysFail||generated<3)throw Error('长度检查失败');return {build:true,checks:[{name:'长度边界',passed:true}],errors:[]};
  }});
  if(alwaysFail)await assert.rejects(run,/长度检查失败/);else assert.equal((await run()).checksPassed,1);
  assert.equal(generated,3);assert.equal(repaired,3);assert.equal(built,6);
 }}finally{await rm(config.dataDir,{recursive:true,force:true});config.dataDir=oldDir;}
});
