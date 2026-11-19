import test from 'node:test';
import assert from 'node:assert/strict';
import {FIELDS,type Fields,type Material} from '../shared/types';
import {recoverIntakeEvidence,repairSuggestionEvidence,retainVerifiedSuggestion,normalizeGeneratedSuggestion,validateSuggestionDraft} from '../server/ai';
import {createCRMExperience} from '../server/experience';
import {businessFieldAdditionsSchema,extendBusinessFields} from '../server/demo-business-fields';
import {hasUnresolvedContent} from '../shared/requirement-clarity';
import {waitingLabel} from '../shared/discussion';
import {getChatDisabledReason} from '../shared/chat-policy';
import {compactProject} from '../server/workspace-sync';
import {readConversationDraft,updateConversationDraft,clearSentDraft} from '../src/conversation-drafts';
import {validateDiscussion} from '../server/discussion';
import {DemoEntryFilesError,demoCodeSchema,mergeDemoPatch,validateDemoProposal} from '../server/demo-schema';
import {repairDemoEntryFiles} from '../server/demo-generator';

test('HCS-005：单次仍限8项，多个模块的12项字段合并且重复幂等、冲突拒绝',()=>{
 const fields=Array.from({length:12},(_,i)=>({entity:i<6?'Entry':'Case',name:'field'+i,type:'string' as const}));
 assert.equal(businessFieldAdditionsSchema.safeParse(fields).success,false);
 const contract={inputKey:'test',summary:'保险理赔',source:'export interface Entry{id:string}\nexport interface Case{id:string}\nexport const initial={entries:[],cases:[]};'};
 const result=extendBusinessFields(contract,[...fields,fields[0]]);
 assert.equal((result.source.match(/\?: string/g)||[]).length,12);
 assert.equal(extendBusinessFields(result,fields).source,result.source);
 assert.throws(()=>extendBusinessFields(contract,[fields[0],{...fields[0],type:'number'}]),/冲突/);
});

test('SK-002：概要一处引用错误保留其他卡片与有效字段，不自动确认或补造事实',()=>{
 const material:Material={id:'m',name:'会议纪要',kind:'text',location:'1',text:'提供大会议程查看。预约须对方同意。',status:'待整理',cardIds:[],createdAt:'now'};
 const fields=Object.fromEntries(FIELDS.map(([key])=>[key,'待明确：具体规则'])) as Fields;
 const card=(key:string)=>({key,title:key==='overview'?'大会范围':'预约洽谈',fields:{...fields,goal:'提供大会议程查看。'},sourceIds:['m'],assessment:'待澄清',issues:[],evidence:{goal:[{materialId:'m',quote:'提供大会议程查看。'}]},granularity:key==='overview'?'概要':'具体',origin:'材料要求',rationale:'会议明确要求',coverageGaps:[],...(key==='detail'?{parentKey:'overview'}:{})});
 const overview=card('overview');overview.fields.scope='允许所有人查看';Object.assign(overview.evidence,{scope:[{materialId:'m',quote:'允许所有人查看'}]});
 const result=recoverIntakeEvidence({cards:[overview,card('detail')]},[material],[]);
 assert.equal(result.length,2);assert.match(result[0].fields.scope,/待明确/);assert.equal(result[0].fields.goal,'提供大会议程查看。');assert.equal(result[0].evidence.scope,undefined);assert.equal(result[1].parentKey,'overview');assert.equal(result[0].assessment,'待澄清');assert(!('approvals' in result[0]));
});

test('SK-004：仅修复失真的引用，字段内容不改写，未采纳变更仍不得充当证据',async()=>{
 const p=createCRMExperience(),c=p.cards[0];c.messages=[{id:'human',role:'business',participantId:'business',text:'议程搜索最多输入20字。',createdAt:'now'},{id:'unaccepted',role:'business',text:'改成无限长度',kind:'change',accepted:false,createdAt:'now'}];
 const raw={summary:'缩短搜索长度，待人工采纳',issues:[],changes:[{field:'data',after:'议程搜索最多输入20字。',reason:'业务明确上限',evidence:[{messageId:'human',quote:'搜索限定二十字'}]}]};
 const repaired=await repairSuggestionEvidence(raw,c,[],async()=>JSON.stringify({references:[{id:'change:0',evidence:[{messageId:'human',quote:'议程搜索最多输入20字。'}]}]}));
 assert.equal(validateSuggestionDraft(repaired,c,[]).changes[0].after,raw.changes[0].after);assert.notEqual(c.fields.data,raw.changes[0].after);
 await assert.rejects(()=>repairSuggestionEvidence(raw,c,[],async()=>JSON.stringify({references:[{id:'change:0',evidence:[{messageId:'unaccepted',quote:'改成无限长度'}]}]})),/引用无效/);
});

test('SK-005：预约状态的自然表述可确认，未定规则仍阻止确认',()=>{
 for(const text of ['发起人可取消待确认预约','待确认、被拒绝、取消以及取消已同意预约后，双方页面均不再显示对方号码','查看待确认的申请'])assert.equal(hasUnresolvedContent(text),false,text);
 for(const text of ['时限待确认','范围待确认，已安排会议','允许取消待确认预约，但取消后的费用待确认。'])assert.equal(hasUnresolvedContent(text),true,text);
});

test('HCS-003：等待提示与最终业务确认权限一致',()=>{
 const p=createCRMExperience(),c=p.cards[0];c.blockers=[];c.issues=[];c.fields=Object.fromEntries(FIELDS.map(([k])=>[k,'规则明确'])) as Fields;c.suggestion=undefined;
 c.approvals={pm:{id:'a',role:'pm',revision:c.revision,round:c.round,result:'通过',comment:'核对完成',createdAt:'now'}};
 assert.equal(waitingLabel(c,'business','business-sales'),'等业务确认');
 assert.match(getChatDisabledReason('businessConfirm',{project:p,card:c,role:'business',participantId:'business-sales'}),/业务负责人/);
 assert.equal(waitingLabel(c,'business','business'),'等你确认');
});

test('SK-003：按项目、卡片、身份保留文字和附件，迟到的发送结果不清除新草稿',()=>{
 const a='p1:c1:pm',b='p1:c2:pm',other='p1:c1:business',file=new File(['说明'],'补充.txt');
 updateConversationDraft(a,{text:'尚未发送的规则',replyTo:'q1',files:[file]});const sent=readConversationDraft(a);
 updateConversationDraft(b,{text:'另一张卡'});assert.equal(readConversationDraft(a).text,'尚未发送的规则');assert.equal(readConversationDraft(a).files[0],file);assert.equal(readConversationDraft(other).text,'');
 updateConversationDraft(a,{text:'发送期间继续编辑'});clearSentDraft(a,sent);assert.equal(readConversationDraft(a).text,'发送期间继续编辑');
 clearSentDraft(a,readConversationDraft(a));assert.equal(readConversationDraft(a).files.length,0);assert.equal(readConversationDraft(b).text,'另一张卡');
});

test('SK-008：承诺可采纳草稿必须触发结构化建议，不能只留下聊天',()=>{
 const p=createCRMExperience(),c=p.cards[0];c.followUps=[];c.messages=[{id:'human',role:'pm',text:'@Agent 请把搜索长度改为20字并生成字段修改建议',createdAt:'now'}];
 const result=validateDiscussion({reply:'以下是可采纳字段修改草稿：将搜索限制改为20字。',answer:null,question:null,summarize:false},c);
 assert.equal(result.summarize,true);assert.deepEqual(c.approvals,{});
});

test('SK-001：精简工作台保留真实字数，全文仍单独读取',()=>{
 const p=createCRMExperience();p.materials[0].text='理赔📄\n申请';const m=compactProject(p).materials[0];
 assert.equal(m.text,'');assert.equal(m.textLength,6);assert.equal(m.textAvailable,true);
});

test('建议引用无法修复时保留独立有效修改，相关依赖与问题解决不冒充通过',()=>{
 const p=createCRMExperience(),c=p.cards[0];c.messages=[{id:'b',role:'business',text:'只显示本人案件。电话最多11位。',createdAt:'now'}];
 const change=(field:string,quote:string)=>({field,after:field==='permission'?'只显示本人案件。':'电话最多11位。',reason:'补充规则',evidence:[{messageId:'b',quote}]});
 const result=retainVerifiedSuggestion({summary:'本轮修改',issues:[],changes:[change('permission','只显示本人案件。'),change('data','无限制电话号码')],dependencies:[]},c,[]);
 assert.deepEqual(result.changes.map(x=>x.field),['permission']);assert.match(result.issues[0],/依据尚未核实/);assert.equal(c.approvals.business,undefined);
});

test('问题解决建议强制关联原问题字段，不能因模型漏列而跳过该字段的人审',()=>{
 const c=createCRMExperience().cards[0];c.blockers=[{id:'scope-conflict',field:'scope',reason:'本期预约还是预留',resolved:false,createdAt:'now'}];
 const raw={summary:'明确预约',issues:[],changes:[],problemResolutions:[{blockerId:'scope-conflict',resolution:'本期实现简化预约',evidence:[],requiredFields:['flow','flow'],requiredRoles:['business','pm']}]};
 const normalized=normalizeGeneratedSuggestion(raw,c) as typeof raw;
 assert.deepEqual(normalized.problemResolutions[0].requiredFields,['scope','flow']);assert.deepEqual(normalized.problemResolutions[0].requiredRoles,['business','pm']);assert.equal(c.blockers[0].resolved,false);assert.deepEqual(c.approvals,{});
 assert.deepEqual(raw.problemResolutions[0].requiredFields,['flow','flow']);
});

test('入口缺失只补齐缺少文件，保留已生成页面而非第二轮丢掉它',async()=>{
 const p=createCRMExperience();p.cards=p.cards.filter(c=>c.included).slice(0,1);
 const raw={summary:'录入',files:[{path:'src/App.tsx',content:'export default function App(){return <div data-testid="form">录入</div>}'}],bindings:[{cardId:p.cards[0].id,field:'flow',testId:'form'}],checks:[],assumptions:[]};
 let missing:DemoEntryFilesError|undefined;try{validateDemoProposal(raw,p,{},true);}catch(e){assert(e instanceof DemoEntryFilesError);missing=e;}
 assert(missing);const repaired=await repairDemoEntryFiles(raw,missing,async()=>JSON.stringify({files:[{path:'src/styles.css',content:'body{color:blue}'}]}));
 const result=validateDemoProposal(repaired,p,{},true);assert.equal(result.files['src/App.tsx'],raw.files[0].content);assert.equal(result.files['src/styles.css'],'body{color:blue}');
});

test('多轮原型更新保留超过12条既有检查，每次新增仍有独立数量限制',()=>{
 const p=createCRMExperience();p.cards=p.cards.filter(c=>c.included).slice(0,1);const id=p.cards[0].id;
 const check=(i:number)=>({name:`交互${i}`,cardIds:[id],steps:[{action:'click',testId:'form'},{action:'expectVisible',testId:'form'}]});
 const initial={summary:'录入',files:[{path:'src/App.tsx',content:'export default function App(){return <button data-testid="form">录入</button>}'},{path:'src/styles.css',content:'body{margin:0}'}],bindings:[{cardId:id,field:'flow',testId:'form'}],checks:Array.from({length:12},(_,i)=>check(i)),assumptions:[]};
 const before=validateDemoProposal(initial,p);
 const merged=mergeDemoPatch({summary:'补充边界',files:[],addedChecks:[check(12),check(13)]},before.proposal);
 const result=validateDemoProposal(merged,p,before.files);assert.equal(result.proposal.checks.length,14);assert.deepEqual(result.proposal.checks.slice(0,12),before.proposal.checks);
 assert.equal(demoCodeSchema.safeParse({...initial,checks:result.proposal.checks}).success,false);
 assert.throws(()=>mergeDemoPatch({summary:'过多新增',files:[],addedChecks:Array.from({length:13},(_,i)=>check(i))},before.proposal));
 assert.throws(()=>validateDemoProposal({...merged,checks:Array.from({length:65},(_,i)=>check(i))},p,before.files));
});
