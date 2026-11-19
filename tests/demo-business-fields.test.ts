import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {extendBusinessFields,businessRuntimeKey} from '../server/demo-business-fields';
import {buildModularDemo,planDemoModules} from '../server/demo-modules';
import {demoInputKey,demoBasisKey,digest,validateDemoProposal} from '../server/demo-schema';
import {artifactDir} from '../server/demo-builder';
import {config} from '../server/config';
import {createCRMExperience} from '../server/experience';
import type {DemoRevision,DemoBusinessContract} from '../shared/generated-demo';
import type {generateDemoCode} from '../server/demo-generator';

const contract:DemoBusinessContract={inputKey:'before',summary:'共享记录',source:`import {usePrototypeState} from './prototype-state';
export interface Entry {id:string;status:'draft'|'submitted'}
export type Settings={label:string};
export interface BusinessState {entries:Entry[];settings:Settings}
export const initialBusinessState:BusinessState={entries:[{id:'old',status:'draft'}],settings:{label:'原值'}};
export function useBusinessState(){return usePrototypeState<BusinessState>('shared.business',initialBusinessState)};`};

test('新增文本、数字与布尔字段只扩展已有类型，保留初始记录与运行标识',()=>{
 const extended=extendBusinessFields(contract,[{entity:'Entry',name:'reference',type:'string'},{entity:'Entry',name:'cost',type:'number'},{entity:'Settings',name:'enabled',type:'boolean'}]);
 assert.match(extended.source,/reference\?: string/);assert.match(extended.source,/cost\?: number/);assert.match(extended.source,/enabled\?: boolean/);
 assert.equal(extended.runtimeKey,businessRuntimeKey(contract));assert(extended.source.includes("entries:[{id:'old',status:'draft'}]"));
 assert.equal(extendBusinessFields(extended,[{entity:'Entry',name:'reference',type:'string'}]).source,extended.source,'幂等合并不会重复字段');
 assert(!contract.source.includes('reference'),'原有定义不可变');
});

test('新增字段不能覆盖状态、改名、造新实体、注入代码或产生冲突类型',()=>{
 for(const value of [
  [{entity:'Entry',name:'status',type:'string'}],
  [{entity:'Missing',name:'value',type:'string'}],
  [{entity:'Entry',name:'__proto__',type:'string'}],
  [{entity:'Entry',name:'x; run()',type:'string'}],
  [{entity:'Entry',name:'value',type:'Date'}],
  [{entity:'Entry',name:'newField',type:'string'},{entity:'Entry',name:'newField',type:'number'}],
 ])assert.throws(()=>extendBusinessFields(contract,value));
 const unsuitable={...contract,source:contract.source+"\nexport type Choice='a'|'b'"};
 assert.throws(()=>extendBusinessFields(unsuitable,[{entity:'Choice',name:'x',type:'string'}]),/整体更新/);
});

test('可选字段不使未变模块失效；运行定义变更仍必须使全部模块失效',()=>{
 const p=createCRMExperience();p.cards=p.cards.filter(c=>c.included);p.cards.forEach((c,i)=>c.organization={module:'模块'+i,priority:'正常沟通',reason:''});
 const old=planDemoModules(p,[],contract).map(m=>({...m,artifactId:'old',dependencies:[],summary:'',viewport:{width:1280,height:800},sourceHash:'hash',timings:{generationMs:0,buildMs:0,checkMs:0,totalMs:0}}));
 const extended=extendBusinessFields(contract,[{entity:'Entry',name:'reference',type:'string'}]);
 p.cards[0].fields.data+='新增引用号';assert.deepEqual(planDemoModules(p,old,extended,true).map(m=>m.changed),[true,false]);
 const runtimeChanged={...contract,source:contract.source.replace("label:'原值'","label:'新值'")};
 assert.ok(planDemoModules(p,old,runtimeChanged,true).every(m=>m.changed));
 // Legacy hashes include source text rather than its stable runtime key.
 const plans=planDemoModules(p,old,contract,true),plan=plans[1];
 assert.equal(plan.changed,false);
 assert.notEqual(plan.inputKey,plan.legacyInputKey);
 assert.equal(planDemoModules(p,old.map((m,i)=>i===1?{...m,inputKey:plan.legacyInputKey}:m),contract,true)[1].changed,false);
});

test('新增字段与页面一次生成，复用其他模块，后续同内容更新无需重新生成',async()=>{
 const previousDir=config.dataDir;config.dataDir=await mkdtemp(path.join(tmpdir(),'business-fields-'));
 try{
  const p=createCRMExperience();p.cards=p.cards.filter(c=>c.included);p.cards.forEach((c,i)=>c.organization={module:'模块'+i,priority:'正常沟通',reason:''});
  let adding=false,calls=0;
  const generate:typeof generateDemoCode=async(scoped,previous,_failure,_progress,context)=>{
   calls++;const fields=adding?[{entity:'Entry',name:'reference',type:'string' as const}]:[];
   const next=extendBusinessFields(context!.businessContract!,fields);
   const value=validateDemoProposal({summary:'更新记录',files:[{path:'src/App.tsx',content:"import React from 'react'; export default function App(){return <form data-testid='form'>记录</form>}"},{path:'src/styles.css',content:'body{color:blue}'}],bindings:[{cardId:scoped.cards[0].id,field:'data',testId:'form'}],checks:[],assumptions:[]},scoped,{...previous,'src/prototype-business.ts':next.source},true);
   return {...value,businessFieldAdditions:fields,businessContract:next};
  };
  const build=async(projectId:string,id:string,files:Record<string,string>,proposal:unknown)=>{
   const dir=artifactDir(projectId,id);await mkdir(path.join(dir,'output'),{recursive:true});await writeFile(path.join(dir,'sources.json'),JSON.stringify(files));await writeFile(path.join(dir,'proposal.json'),JSON.stringify(proposal));await writeFile(path.join(dir,'output/index.html'),'<html>records</html>');
   const report={build:true,checks:[],errors:[],sourceHash:digest(files),htmlHash:digest('<html>records</html>')};await writeFile(path.join(dir,'output/preview-report.json'),JSON.stringify(report));return report;
  };
  const options={previewFirst:true,guard:async()=>{},progress:async()=>{},generate,build};
  const first=await buildModularDemo(p,undefined,{...options,resolvedContract:contract});
  const revision=(r:typeof first):DemoRevision=>({...r,id:'r1',number:1,createdAt:'now',inputKey:demoInputKey(p),basisKey:demoBasisKey(p),draft:true,cardIds:p.cards.map(c=>c.id),model:'fixture'});
  adding=true;calls=0;p.cards[0].fields.data+='新增引用号';const second=await buildModularDemo(p,revision(first),options);
  assert.equal(calls,1);assert.equal(second.reused,1);assert.equal(second.modules[1].artifactId,first.modules[1].artifactId);assert.equal(second.businessContract!.runtimeKey,businessRuntimeKey(contract));assert.match(second.businessContract!.source,/reference\?: string/);assert.equal(second.verification!.status,'pending');
  const repeated=await buildModularDemo(p,revision(second),options);assert.equal(calls,1);assert.equal(repeated.reused,2);
 }finally{await rm(config.dataDir,{recursive:true,force:true});config.dataDir=previousDir;}
});

test('HCSWP3 两模块各追加6项，项目汇总12项仍发布成功且不修改运行定义',async()=>{
 const old=config.dataDir;config.dataDir=await mkdtemp(path.join(tmpdir(),'hcs-fields-'));
 try{
  const p=createCRMExperience();p.cards=p.cards.filter(c=>c.included);p.cards.forEach((c,i)=>c.organization={module:i?'案件查阅':'报案',priority:'正常沟通',reason:''});
  const result=await buildModularDemo(p,undefined,{resolvedContract:contract,previewFirst:true,guard:async()=>{},progress:async()=>{},generate:async(scoped,previous,_failure,_progress,context)=>{
   const additions=Array.from({length:6},(_,i)=>({entity:'Entry',name:(context!.name==='报案'?'entry':'case')+i,type:'string' as const}));
   const extended=extendBusinessFields(context!.businessContract!,additions);
   return {...validateDemoProposal({summary:'补充业务字段',files:[{path:'src/App.tsx',content:'export default function App(){return <div data-testid="form"/>}'},{path:'src/styles.css',content:'body{color:blue}'}],bindings:[{cardId:scoped.cards[0].id,field:'data',testId:'form'}],checks:[],assumptions:[]},scoped,previous,true),businessFieldAdditions:additions,businessContract:extended};
  },build:async()=>({build:true,checks:[],errors:[]})});
  assert.equal(result.modules.length,2);assert.equal((result.businessContract!.source.match(/\?: string/g)||[]).length,12);assert.equal(result.businessContract!.runtimeKey,businessRuntimeKey(contract));assert.equal(p.cards.some(c=>c.approvals.business),false);
 }finally{const temporary=config.dataDir;config.dataDir=old;await rm(temporary,{recursive:true,force:true});}
});
