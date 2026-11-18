import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createCRMExperience} from '../server/experience';
import {demoBasisKey,demoInputKey,mergeDemoPatch,validateDemoProposal,digest} from '../server/demo-schema';
import {buildModularDemo,planDemoModules} from '../server/demo-modules';
import {verifyModularDemo,applyDemoVerification} from '../server/demo-verification';
import {artifactDir} from '../server/demo-builder';
import {config} from '../server/config';
import {appendDemo,reconcileDemo} from '../server/demo-jobs';
import {applyAction} from '../server/domain';
import {workspacePRD} from '../server/workspace-export';
import type {DemoCodeProposal,DemoRevision} from '../shared/generated-demo';

const proposal=(id:string):DemoCodeProposal=>({summary:'调整提交规则',files:[{path:'src/App.tsx',content:'export default function App(){return <button data-testid="submit">提交</button>}'},{path:'src/styles.css',content:'body{color:blue}'}],deletePaths:[],bindings:[{cardId:id,field:'flow',testId:'submit'}],checks:[{name:'提交',cardIds:[id],steps:[{action:'click',testId:'submit'},{action:'expectText',testId:'submit',value:'完成'}]},{name:'旧边界',cardIds:[id],steps:[{action:'click',testId:'submit'},{action:'expectVisible',testId:'submit'}]}],assumptions:['内存数据']});

test('局部更新保留旧检查，按索引替换受影响场景，禁止错误或重复索引',()=>{
 const old=proposal('a'),raw={summary:'改边界',files:[],checkUpdates:[{index:1,check:{...old.checks[1],name:'新边界'}}]};
 const result=mergeDemoPatch({...raw,addedChecks:[],addedBindings:[]},old);
 assert.deepEqual(result.checks[0],old.checks[0]);assert.equal(result.checks[1].name,'新边界');assert.deepEqual(result.bindings,old.bindings);assert.deepEqual(result.assumptions,old.assumptions);
 assert.throws(()=>mergeDemoPatch({...raw,checkUpdates:[{...raw.checkUpdates[0],index:3}]},old),/索引/);
 assert.throws(()=>mergeDemoPatch({...raw,checkUpdates:[raw.checkUpdates[0],raw.checkUpdates[0]]},old),/索引/);
 assert.equal(old.checks[1].name,'旧边界');
});

test('普通聊天不废弃同内容原型；新建议、实际规则和建议过期仍废弃候选',()=>{
 const p=createCRMExperience(),c=p.cards.find(c=>c.included)!;delete c.suggestion;
 const before=demoBasisKey(p);c.messages.push({id:'thanks',role:'business',text:'收到，谢谢',createdAt:'now'});assert.equal(demoBasisKey(p),before);
 c.suggestion={id:'proposal',baseRevision:c.revision,messageCount:c.messages.length,status:'待决定',createdAt:'now',summary:'改动',issues:[],changes:[{field:'flow',before:c.fields.flow,after:c.fields.flow+'新流程',reason:'讨论',evidence:[]}]};
 const candidate=demoBasisKey(p);assert.notEqual(candidate,before);
 c.messages.push({id:'clarify',role:'business',text:'规则还需补充',createdAt:'now'});assert.equal(demoBasisKey(p),before,'过期建议不得继续渲染');
 c.fields.flow+='已采纳规则';assert.notEqual(demoBasisKey(p),before);
});

test('共享数据接口未变时只更新自身模块；接口变化会更新全部模块',()=>{
 const p=createCRMExperience();p.cards=p.cards.filter(c=>c.included);p.cards.forEach((c,i)=>c.organization={module:`功能${i}`,priority:'正常沟通',reason:''});
 const contract={inputKey:'a',summary:'数据',source:'export type BusinessState={value:number}'};
 const plans=planDemoModules(p,[],contract),old=plans.map((m,i)=>({...m,artifactId:'a'+i,dependencies:i?[plans[0].id]:[],summary:'',viewport:{width:1280,height:800},timings:{generationMs:0,buildMs:0,checkMs:0,totalMs:0},sourceHash:'x'}));
 p.cards[0].fields.flow+='仅规则变化';assert.deepEqual(planDemoModules(p,old,contract,true).map(p=>p.changed),[true,false]);
 assert.ok(planDemoModules(p,old,{...contract,source:contract.source+';export const newField=1'},true).every(p=>p.changed));
});

test('可操作预览先返回，后台失败只标注原版本，不能确认需求或覆盖新原型',async()=>{
 const oldDir=config.dataDir;config.dataDir=await mkdtemp(path.join(tmpdir(),'preview-first-'));
 try{
 const p=createCRMExperience();p.cards=p.cards.filter(c=>c.included).slice(0,1);const original=structuredClone(p),prd=workspacePRD(p).markdown;
 const result=await buildModularDemo(p,undefined,{previewFirst:true,guard:async()=>{},progress:async()=>{},generate:async(scoped,previous)=>validateDemoProposal(proposal(scoped.cards[0].id),scoped,previous),build:async(projectId,id,files,proposal)=>{
  const dir=artifactDir(projectId,id);await mkdir(path.join(dir,'output'),{recursive:true});await writeFile(path.join(dir,'sources.json'),JSON.stringify(files));await writeFile(path.join(dir,'proposal.json'),JSON.stringify(proposal));await writeFile(path.join(dir,'output/index.html'),'<html>usable</html>');return {build:true,checks:[],errors:[]};
 }});
 assert.equal(result.verification?.status,'pending');assert.equal(result.checksPassed,0);assert.equal(result.verification?.total,2);
 let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);let complete=false;
 const checking=verifyModularDemo(p.id,result,async()=>{await gate;return {build:true,checks:[{name:'提交',passed:true},{name:'旧边界',passed:false}],errors:['业务边界待核对']};}).then(result=>{complete=true;return result;});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(complete,false,'预览可用时完整检查尚未结束');release();const verification=await checking;
 assert.equal(verification.status,'needs-attention');assert.equal(verification.passed,1);
 const first:DemoRevision={...result,id:'r1',number:1,createdAt:'now',inputKey:demoInputKey(p),basisKey:demoBasisKey(p),draft:true,cardIds:[p.cards[0].id],model:'fixture'};
 const adopted={...first,id:'r2',draft:false,adoptedFrom:first.id},newer={...first,id:'r3',artifactId:'newer-artifact',sourceHash:'new'};
 applyDemoVerification([first,adopted,newer],first,verification);
 assert.equal(first.verification?.status,'needs-attention');assert.equal(adopted.verification?.status,'needs-attention');assert.equal(newer.verification?.status,'pending');
 assert.deepEqual(p,original);assert.equal(workspacePRD(p).markdown,prd,'后台检查不得写入正式需求或确认');
 }finally{await rm(config.dataDir,{recursive:true,force:true});config.dataDir=oldDir;}
});


test('多卡逐一采纳复用相同原型，剩余建议仍为草稿且后台状态不变',()=>{
 const p=createCRMExperience();p.cards=p.cards.filter(c=>c.included);
 for(const c of p.cards)c.suggestion={id:'s-'+c.id,baseRevision:c.revision,messageCount:c.messages.length,status:'待决定',createdAt:'now',summary:'更新',issues:[],changes:[{field:'flow',before:c.fields.flow,after:c.fields.flow+'新增本轮步骤',reason:'讨论',evidence:[]}]};
 const revision:DemoRevision={id:'r1',artifactId:'candidate',sourceHash:'hash',number:1,createdAt:'now',inputKey:demoInputKey(p),basisKey:demoBasisKey(p),draft:true,summary:'草稿',cardIds:p.cards.map(c=>c.id),bindings:[],assumptions:[],checksPassed:0,model:'fixture',verification:{status:'pending',total:2,passed:0,startedAt:'now',errors:[]}};
 appendDemo(p,revision);
 const c=p.cards[0];applyAction(p,{type:'applySuggestion',cardId:c.id,suggestionId:c.suggestion!.id,decisions:{flow:'采纳'}},'pm');
 assert.equal(reconcileDemo(p),true);const next=p.generatedDemo!.revisions.at(-1)!;assert.equal(next.artifactId,'candidate');assert.equal(next.draft,true);assert.equal(next.verification?.status,'pending');assert.equal(c.approvals.business,undefined);
});


test('预览阶段可以暂不生成检查，普通全量提案仍必须有业务检查',()=>{
 const p=createCRMExperience();p.cards=p.cards.filter(c=>c.included).slice(0,1);const raw={...proposal(p.cards[0].id),checks:[]};
 assert.throws(()=>validateDemoProposal(raw,p));assert.equal(validateDemoProposal(raw,p,{},true).proposal.checks.length,0);
});


test('不采纳后恢复历史中同内容原型，无需重新生成且保留准确检查状态',()=>{
 const p=createCRMExperience();p.cards=p.cards.filter(c=>c.included).slice(0,1);const c=p.cards[0];delete c.suggestion;
 const original:DemoRevision={id:'r1',artifactId:'accepted',sourceHash:'hash',number:1,createdAt:'now',inputKey:demoInputKey(p),basisKey:demoBasisKey(p),draft:false,summary:'原规则',cardIds:[c.id],bindings:[],assumptions:[],checksPassed:2,model:'fixture'};appendDemo(p,original);
 c.suggestion={id:'change',baseRevision:c.revision,messageCount:c.messages.length,status:'待决定',createdAt:'now',summary:'变更',issues:[],changes:[{field:'flow',before:c.fields.flow,after:c.fields.flow+'新增步骤',reason:'讨论',evidence:[]}]};
 appendDemo(p,{...original,id:'r2',artifactId:'draft',number:2,inputKey:demoInputKey(p),basisKey:demoBasisKey(p),draft:true});
 applyAction(p,{type:'applySuggestion',cardId:c.id,suggestionId:'change',decisions:{flow:'不采纳'}},'pm');assert.equal(reconcileDemo(p),true);
 const restored=p.generatedDemo!.revisions.at(-1)!;assert.equal(restored.number,3);assert.equal(restored.artifactId,'accepted');assert.equal(restored.draft,false);assert.equal(restored.checksPassed,2);
});
