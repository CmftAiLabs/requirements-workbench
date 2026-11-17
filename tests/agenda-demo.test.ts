import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {unzipSync,strFromU8} from 'fflate';
import {agendaBehavior} from '../shared/agenda-demo.ts';
import {conferenceModel} from '../shared/conference-demo.ts';
import {buildDemoHTML} from '../shared/project-demo.ts';
import {FIELDS,type Fields,type Project} from '../shared/types.ts';
import {createProject,addExtractedCards,attachSuggestion,applyAction} from '../server/domain.ts';
import {demoZip,workspacePRD} from '../server/workspace-export.ts';

const after={
 flow:'输入关键词筛选议程。无匹配时提供“清空搜索”按钮，点击后显示当日全部议程，不自动清空搜索。加载失败时提供“重试”按钮，重试后保留关键词。',
 exception:'无结果时提示暂无匹配议程，提供清空搜索按钮。加载失败时提供重试按钮，保留关键词，重试成功后按原关键词展示。',
 acceptance:'无结果时能点击清空搜索按钮回到全部；失败时可点击重试按钮，成功后按原关键词展示。',
};
function setup(draft=true){
 const p=createProject('议程自动更新测试');p.cards=[];
 const fields=Object.fromEntries(FIELDS.map(([key])=>[key,'待明确：实际业务规则'])) as Fields;
 fields.flow='进入议程并输入关键词筛选';
 addExtractedCards(p,[{title:'大会议程展示与检索',fields,sourceIds:['crm-kickoff'],assessment:'待澄清',issues:[],evidence:{}}],['crm-kickoff']);
 p.demo={kind:'conference',title:'议程演示',date:'2026年11月27日',preparedAt:'2026-11-06T08:00:00Z',appointments:'excluded',payment:'pending',assumptions:[]};
 const c=p.cards[0];
 if(draft)attachSuggestion(p,c.id,{summary:'讨论后补充清空与重试',issues:[],changes:Object.entries(after).map(([key,value])=>({field:key as keyof typeof after,before:c.fields[key as keyof Fields],after:value,reason:'演练意见',evidence:[]}))},c.revision,c.messages.length);
 return {p,c};
}

/** Execute the real exported script, keeping only a minimal DOM boundary in the test. */
function runtime(p:Project,html=buildDemoHTML(p,p.cards[0])){
 const listeners:Record<string,(event:any)=>void>={},nodes=new Map<string,any>(),timers:{fn:()=>void;ms:number}[]=[];
 const node=()=>({innerHTML:'',textContent:'',value:'',dataset:{},scrollTop:0,classList:{add(){},remove(){}},showModal(){},close(){},focus(){}});
 for(const id of ['top-title','page-label','login-status','content','trace-label','toast','dialog-title','dialog-body','dialog'])nodes.set(id,node());
 let content='';
 Object.defineProperty(nodes.get('content'),'innerHTML',{get:()=>content,set:(html:string)=>{
  content=html;nodes.delete('search');nodes.delete('results');
  if(html.includes('id="search"')){const input=node();input.value=html.match(/id="search"[^>]*value="([^"]*)"/)?.[1]||'';nodes.set('search',input);}
  if(html.includes('id="results"')){const results=node();results.innerHTML=html.match(/<div id="results">([\s\S]*)<\/div><p class="hint">/)?.[1]||'';nodes.set('results',results);}
 }});
 const document={getElementById:(id:string)=>nodes.get(id)||null,querySelectorAll:()=>[],addEventListener:(name:string,fn:any)=>{listeners[name]=fn;}};
 runInNewContext(html.match(/<script>([\s\S]*)<\/script>/)![1],{document,window:{setTimeout(fn:()=>void,ms:number){timers.push({fn,ms});return timers.length;}},Blob,URL});
 return {
  click:(action:string)=>listeners.click({target:{closest:()=>({dataset:{action}})}}),
  search:(value:string)=>{const input=nodes.get('search');assert.ok(input,'议程搜索框应保留');input.value=value;input.oninput();},
  finishRetry:()=>{for(const timer of timers.splice(0))if(timer.ms===450)timer.fn();},
  locate:()=>listeners['workbench-locate']({detail:{cardId:p.cards[0].id,field:'exception'}}),
  results:()=>nodes.get('results')?.innerHTML||'',keyword:()=>nodes.get('search')?.value,
  content:()=>nodes.get('content').innerHTML,
 };
}

test('只有明确的清空与重试规则才变成操作，未知或否定口径不会被误启用',()=>{
 const {c}=setup(false);assert.deepEqual(agendaBehavior(c.fields),{clearSearch:false,retryLoad:false,keepKeywordOnRetry:true});
 const fields={...c.fields,...after};assert.equal(agendaBehavior(fields).clearSearch,true);assert.equal(agendaBehavior(fields).retryLoad,true);
 assert.equal(agendaBehavior({...fields,exception:'本期不提供清空搜索按钮，不提供重试按钮。'}).clearSearch,false);
 assert.equal(agendaBehavior({...fields,exception:'移除重试按钮。'}).retryLoad,false);
 assert.equal(agendaBehavior({...c.fields,exception:'是否提供重试按钮仍待确认；清空搜索入口是否需要待明确。'}).retryLoad,false);
 assert.equal(agendaBehavior({...c.fields,exception:'清空搜索入口是否需要待明确。'}).clearSearch,false);
 assert.equal(agendaBehavior({...c.fields,exception:'加载失败时只显示“请稍后重试”。'}).retryLoad,false);
 assert.equal(agendaBehavior({...fields,exception:'提供重试按钮，重试成功后清空关键词。'}).keepKeywordOnRetry,false);
 assert.equal(agendaBehavior({...fields,exception:'提供重试按钮，重试后不清空关键词。'}).keepKeywordOnRetry,true);
});

test('最新建议直接更新可交互草稿，PRD、修订和确认仍保持人工边界',()=>{
 const {p,c}=setup(),before=structuredClone(p);
 assert.equal(conferenceModel(p,c).agenda?.clearSearch,true);assert.equal(conferenceModel(p,c).agenda?.retryLoad,true);
 const r=runtime(p);r.search('不存在');assert.match(r.results(),/清空搜索/);assert.match(r.results(),/暂无匹配议程/);assert.equal(r.keyword(),'不存在');
 r.click('agenda-clear');assert.equal(r.keyword(),'');assert.equal((r.results().match(/class="agenda-row"/g)||[]).length,5);
 assert.equal(c.revision,1);assert.deepEqual(c.approvals,{});assert.ok(workspacePRD(p).markdown.includes(c.fields.flow));assert.ok(!workspacePRD(p).markdown.includes(after.flow));
 assert.deepEqual(p,before,'渲染和操作都不能写入项目');
});

test('加载失败可重试，成功保留关键词，持续失败可再次重试且不会重复请求',()=>{
 const {p}=setup(),r=runtime(p);r.search('人工智能');assert.match(r.results(),/人工智能与场景创新/);
 r.click('fail');assert.equal(r.keyword(),'人工智能');assert.match(r.results(),/加载失败，请重试/);assert.match(r.results(),/agenda-retry/);
 r.click('agenda-retry');r.click('agenda-retry');assert.match(r.results(),/aria-busy="true"/);assert.match(r.results(),/button disabled/);
 r.finishRetry();assert.equal(r.keyword(),'人工智能');assert.equal((r.results().match(/class="agenda-row"/g)||[]).length,1);assert.doesNotMatch(r.results(),/加载失败/);
 r.click('agenda-fail-again');r.click('agenda-retry');r.finishRetry();assert.match(r.results(),/加载失败，请重试/);assert.equal(r.keyword(),'人工智能');
 r.click('agenda-retry');r.finishRetry();assert.match(r.results(),/agenda-retry/);assert.equal(r.keyword(),'人工智能');
 r.click('fail');r.click('agenda-retry');r.finishRetry();assert.match(r.results(),/人工智能与场景创新/);
});

test('零匹配重试仍保持零匹配，定位不丢搜索条件，离开页面丢弃旧重试回调',()=>{
 const {p}=setup(),r=runtime(p);r.search('不存在');r.locate();assert.equal(r.keyword(),'不存在');assert.match(r.results(),/暂无匹配议程/);
 r.click('fail');r.locate();assert.match(r.results(),/agenda-retry/);r.click('agenda-retry');r.finishRetry();assert.match(r.results(),/暂无匹配议程/);assert.equal(r.keyword(),'不存在');
 r.click('agenda-clear');r.search('人工智能');r.click('fail');r.click('agenda-retry');r.click('go:home');const home=r.content();r.finishRetry();assert.equal(r.content(),home);assert.match(home,/欢迎参会/);
});

test('建议过期会撤下草稿按钮，产品采纳或人工否决后按实际保存字段重新渲染',()=>{
 const {p,c}=setup();applyAction(p,{type:'message',cardId:c.id,text:'新意见需要进一步核对'},'business');
 assert.equal(conferenceModel(p,c).agenda?.clearSearch,false);const stale=runtime(p);stale.search('不存在');assert.doesNotMatch(stale.results(),/agenda-clear/);stale.click('fail');assert.doesNotMatch(stale.results(),/agenda-retry/);
 const saved=setup();applyAction(saved.p,{type:'applySuggestion',cardId:saved.c.id,suggestionId:saved.c.suggestion!.id,decisions:{flow:'采纳',exception:'采纳',acceptance:'采纳'}},'pm');
 assert.equal(conferenceModel(saved.p,saved.c).agenda?.retryLoad,true);assert.equal(saved.c.revision,2);assert.deepEqual(saved.c.approvals,{});
 applyAction(saved.p,{type:'editCard',cardId:saved.c.id,title:saved.c.title,fields:{...saved.c.fields,exception:'本期不提供清空搜索按钮，不提供重试按钮。'},reason:'人工调整本期范围'},'pm');
 assert.equal(conferenceModel(saved.p,saved.c).agenda?.clearSearch,false);assert.equal(conferenceModel(saved.p,saved.c).agenda?.retryLoad,false);
});

test('导出 ZIP 与预览具备相同清空和重试操作，不包含真实网络请求',()=>{
 const {p}=setup(),files=unzipSync(demoZip(p,p.cards[0].id)),html=strFromU8(files['index.html']);assert.equal(html,buildDemoHTML(p,p.cards[0]));
 const r=runtime(p,html);r.search('无匹配');r.click('agenda-clear');assert.equal(r.keyword(),'');r.search('人工智能');r.click('fail');r.click('agenda-retry');r.finishRetry();assert.match(r.results(),/人工智能与场景创新/);
 assert.match(html,/connect-src 'none'/);assert.doesNotMatch(html,/fetch\(|XMLHttpRequest/);
});
