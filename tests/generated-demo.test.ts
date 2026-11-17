import test from 'node:test';
import assert from 'node:assert/strict';
import {createCRMExperience} from '../server/experience.ts';
import {applyAction,attachSuggestion} from '../server/domain.ts';
import {validateDemoProposal,demoInputKey,demoBasisKey,usableDemo,digest,DemoFileOperationConflictError} from '../server/demo-schema.ts';
import {appendDemo,reconcileDemo} from '../server/demo-jobs.ts';
import {workspacePRD} from '../server/workspace-export.ts';
import type {DemoRevision} from '../shared/generated-demo.ts';
function fixture(){const p=createCRMExperience();const proposal={summary:'根据业务需求生成',files:[{path:'src/App.tsx',content:'export default function App(){return <button data-testid="action">提交</button>}'},{path:'src/styles.css',content:'button{color:blue}'}],deletePaths:[],bindings:p.cards.filter(c=>c.included).map(c=>({cardId:c.id,testId:'action',field:'flow'})),checks:[{name:'提交产生结果',cardIds:[p.cards[0].id],steps:[{action:'click',testId:'action'},{action:'expectText',testId:'action',value:'已提交'}]}],assumptions:['演示数据']};return {p,proposal};}
function revision(p:ReturnType<typeof createCRMExperience>,draft=false):DemoRevision{return {id:'revision-1',artifactId:'artifact-1',number:1,createdAt:new Date().toISOString(),inputKey:demoInputKey(p),basisKey:demoBasisKey(p),draft,summary:'测试演示',cardIds:p.cards.filter(c=>c.included).map(c=>c.id),bindings:[],assumptions:[],checksPassed:2,sourceHash:'fixture',model:'test'};}
test('生成代码文件限定项目 src，防止路径穿越、配置改写和虚假定位',()=>{
 const {p,proposal}=fixture();assert.ok(validateDemoProposal(proposal,p).files['src/App.tsx']);
 for(const bad of ['../.env','src/../../server.ts','src/App.tsx/../x.ts','package.json','vite.config.ts','src/a.mjs','/tmp/a.ts'])assert.throws(()=>validateDemoProposal({...proposal,files:[...proposal.files,{path:bad,content:'x'}]},p));
 assert.throws(()=>validateDemoProposal({...proposal,bindings:[{cardId:'other-project',testId:'x',field:'flow'}]},p));
 assert.throws(()=>validateDemoProposal({...proposal,bindings:proposal.bindings.slice(1)},p));
 assert.throws(()=>validateDemoProposal({...proposal,deletePaths:['src/App.tsx']},p));
});
test('生成原型的视口尺寸有界并兼容旧版本，不能用异常尺寸撑开预览',()=>{
 const {p,proposal}=fixture();
 assert.equal(validateDemoProposal(proposal,p).proposal.viewport,undefined);
 assert.deepEqual(validateDemoProposal({...proposal,viewport:{width:390,height:844}},p).proposal.viewport,{width:390,height:844});
 assert.deepEqual(validateDemoProposal({...proposal,viewport:{width:1280,height:800}},p).proposal.viewport,{width:1280,height:800});
 for(const viewport of [{width:-390,height:844},{width:100000,height:800},{width:2560,height:320},{width:390,height:844,scale:100}])assert.throws(()=>validateDemoProposal({...proposal,viewport},p));
});
test('增量更新保留无关文件，交互检查必须有操作和结果',()=>{
 const {p,proposal}=fixture();const prior={'src/App.tsx':'old','src/styles.css':'old','src/other.ts':'export const x=1;'};
 const result=validateDemoProposal({...proposal,files:[proposal.files[0]]},p,prior);assert.equal(result.files['src/other.ts'],prior['src/other.ts']);assert.equal(result.files['src/styles.css'],'old');
 assert.throws(()=>validateDemoProposal({...proposal,checks:[{name:'伪检查',cardIds:[p.cards[0].id],steps:[{action:'expectText',testId:'action',value:'提交'},{action:'expectVisible',testId:'action'}]}]},p));
 assert.throws(()=>validateDemoProposal({...proposal,checks:[{name:'漏结果',cardIds:[p.cards[0].id],steps:[{action:'click',testId:'action'},{action:'click',testId:'action'}]}]},p));
});
test('Demo 草稿与正式 PRD 分离，全采纳可复用代码但不自动业务确认',()=>{
 const {p}=fixture(),c=p.cards[0],before=workspacePRD(p).markdown;
 attachSuggestion(p,c.id,{summary:'增加新的业务交互',issues:[],changes:[{field:'flow',before:c.fields.flow,after:c.fields.flow+' 增加结果撤回操作。',reason:'演练',evidence:[]}]},c.revision,c.messages.length);
 const r=revision(p,true);appendDemo(p,r);assert.equal(workspacePRD(p).markdown.includes('增加结果撤回操作'),false);assert.equal(c.approvals.business,undefined);
 applyAction(p,{type:'applySuggestion',cardId:c.id,suggestionId:c.suggestion!.id,decisions:{flow:'采纳'}},'pm');assert.equal(reconcileDemo(p),true);
 const promoted=p.generatedDemo!.revisions.at(-1)!;assert.equal(promoted.artifactId,r.artifactId);assert.equal(promoted.draft,false);assert.notEqual(promoted.id,r.id);assert.equal(r.draft,true);assert.equal(c.approvals.business,undefined);assert.notEqual(workspacePRD(p).markdown,before);
});
test('部分采纳不能复用包含被拒功能的 Demo；讨论过期不伪装最新',()=>{
 const {p}=fixture(),c=p.cards[0];const baseline=revision(p);appendDemo(p,baseline);
 attachSuggestion(p,c.id,{summary:'两个调整',issues:[],changes:[{field:'flow',before:c.fields.flow,after:c.fields.flow+' 新增撤回。',reason:'演练',evidence:[]},{field:'exception',before:c.fields.exception,after:c.fields.exception+' 新增重试。',reason:'演练',evidence:[]}]},c.revision,c.messages.length);
 const draft={...revision(p,true),id:'draft',number:2};appendDemo(p,draft);
 const stale=structuredClone(p);applyAction(stale,{type:'message',cardId:c.id,text:'这两个方案仍需要再讨论'},'business');assert.equal(usableDemo(stale)?.id,baseline.id);
 applyAction(p,{type:'applySuggestion',cardId:c.id,suggestionId:c.suggestion!.id,decisions:{flow:'采纳',exception:'不采纳'}},'pm');assert.equal(reconcileDemo(p),false);assert.notEqual(demoInputKey(p),draft.inputKey);assert.equal(c.approvals.business,undefined);
});

test('Agent 局部代码修改必须唯一匹配原文，不能错改其他文件',()=>{
 const {p,proposal}=fixture();const previous={'src/App.tsx':'export const limit=100;','src/styles.css':'body{color:blue}'};
 const result=validateDemoProposal({...proposal,files:[],edits:[{path:'src/App.tsx',search:'limit=100',replace:'limit=200'}]},p,previous);assert.equal(result.files['src/App.tsx'],'export const limit=200;');assert.equal(result.files['src/styles.css'],previous['src/styles.css']);
 assert.throws(()=>validateDemoProposal({...proposal,files:[],edits:[{path:'src/App.tsx',search:'not-present',replace:'x'}]},p,previous),/唯一匹配/);
 assert.throws(()=>validateDemoProposal({...proposal,edits:[{path:'src/App.tsx',search:'limit=100',replace:'x'}]},p,previous),/不能同时/);
});

test('文件方案提前列出全部互斥操作，失败不会部分修改原文件',()=>{
 const {p,proposal}=fixture(),previous={'src/App.tsx':'old app','src/styles.css':'old css','src/old.ts':'old'};
 const before=structuredClone(previous),edit={path:'src/App.tsx',search:'old app',replace:'new app'};
 for(const extra of [{edits:[edit]},{deletePaths:['src/App.tsx']},{deletePaths:['src/App.tsx'],edits:[edit]}]){
  assert.throws(()=>validateDemoProposal({...proposal,...extra},p,previous),error=>error instanceof DemoFileOperationConflictError&&error.conflicts[0].path==='src/App.tsx');
  assert.deepEqual(previous,before);
 }
 assert.throws(()=>validateDemoProposal({...proposal,files:[],deletePaths:['src/old.ts'],edits:[{path:'src/old.ts',search:'old',replace:'new'}]},p,previous),error=>error instanceof DemoFileOperationConflictError&&error.conflicts[0].operations.join(',')==='delete,edit');
 assert.throws(()=>validateDemoProposal({...proposal,edits:[edit,{path:'src/styles.css',search:'old css',replace:'new css'}]},p,previous),error=>error instanceof DemoFileOperationConflictError&&error.conflicts.length===2);
 assert.deepEqual(previous,before);
});

test('同文件多个顺序局部修改仍合法，不同文件可分别替换和删除',()=>{
 const {p,proposal}=fixture(),previous={'src/App.tsx':'const a=1;const b=2;','src/styles.css':'old css','src/old.ts':'old'};
 const result=validateDemoProposal({...proposal,files:[proposal.files[1]],deletePaths:['src/old.ts'],edits:[{path:'src/App.tsx',search:'a=1',replace:'a=3'},{path:'src/App.tsx',search:'a=3;const b=2',replace:'a=3;const b=4'}]},p,previous);
 assert.equal(result.files['src/App.tsx'],'const a=3;const b=4;');assert.equal(result.files['src/styles.css'],proposal.files[1].content);assert.equal(result.files['src/old.ts'],undefined);
});

test('内容签名不受 PostgreSQL JSON 字段顺序影响',()=>{assert.equal(digest({fields:{goal:'目标',flow:'流程'},list:[1,2]}),digest({list:[1,2],fields:{flow:'流程',goal:'目标'}}));assert.notEqual(digest({list:[1,2]}),digest({list:[2,1]}));});

test('长度边界输入在校验时精确展开 repeat，执行端只收到普通步骤',()=>{
 const {p,proposal}=fixture();
 const checks=[{name:'201字输入保留',cardIds:[p.cards[0].id],steps:[{action:'fill',testId:'description',value:'测',repeat:201},{action:'expectValue',testId:'description',value:'测',repeat:201}]}];
 const raw={...proposal,checks},before=structuredClone(raw),result=validateDemoProposal(raw,p);
 for(const step of result.proposal.checks[0].steps){assert.equal(step.value!.length,201);assert.equal(step.value,'测'.repeat(201));assert.equal('repeat' in step,false);}
 assert.deepEqual(raw,before);
 for(const invalid of [{action:'click',value:'测',repeat:201},{action:'fill',value:'重复词',repeat:201},{action:'fill',value:'测',repeat:0},{action:'fill',value:'测',repeat:1001},{action:'fill',value:'测',repeat:1.5}])assert.throws(()=>validateDemoProposal({...proposal,checks:[{...checks[0],steps:[{testId:'description',...invalid},checks[0].steps[1]]}]},p));
});
