import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {unzipSync,strFromU8} from 'fflate';
import {createProject,addExtractedCards,attachSuggestion,applyAction} from '../server/domain.ts';
import {buildDemoHTML} from '../shared/project-demo.ts';
import {conferenceModel,canEnterConference,nextAppointmentStatus} from '../shared/conference-demo.ts';
import {workspacePRD,demoZip} from '../server/workspace-export.ts';
import {FIELDS,type Fields} from '../shared/types.ts';

function setup(){
 const p=createProject('大会测试项目');p.cards=[];
 const fields=Object.fromEntries(FIELDS.map(([k])=>[k,'待明确：实际业务规则'])) as Fields;
 addExtractedCards(p,['大会基础信息与嘉宾展示','大会报名、支付与准入','个人报名资料与参会凭证','大会议程展示与检索','参会企业展示与检索','预约洽谈与手机号交换','晚宴桌号查询','热门资讯展示与公众号跳转'].map(title=>({title,fields:{...fields},sourceIds:['crm-kickoff'],assessment:'待澄清' as const,issues:[],evidence:{}})),['crm-kickoff']);
 p.demo={kind:'conference',title:'招蛇大会',date:'2026年11月27日',preparedAt:'2026-11-06T08:00:00Z',appointments:'preview',payment:'pending',assumptions:['预约先演示，支付规则待确认']};
 return p;
}
test('大会演示从项目配置选择，与 CRM 演示隔离且一一映射当前需求',()=>{
 const p=setup(),model=conferenceModel(p,p.cards[3]),html=buildDemoHTML(p,p.cards[3]);
 assert.equal(model.initialPage,'agenda');assert.equal(model.cards[3].chapter,'4.4');
 assert.match(html,/招蛇大会/);assert.doesNotMatch(html,/NOVA CRM|星河科技/);
 delete p.demo;assert.match(buildDemoHTML(p,p.cards[0]),/NOVA CRM/);
});
test('未报名、待审核和驳回状态不能查看受保护详情，手机号只能同意后交换',()=>{
 for(const status of ['guest','pending','rejected'])for(const page of ['agenda','companies','appointments','dinner','news'] as const)assert.equal(canEnterConference(status,page),false);
 assert.equal(canEnterConference('approved','companies'),true);
 assert.equal(canEnterConference('pending','profile'),true);
 assert.equal(nextAppointmentStatus('待确认','exchange'),'待确认');
 assert.equal(nextAppointmentStatus('待确认','accept'),'已同意');
 assert.equal(nextAppointmentStatus('已同意','exchange'),'已交换');
 assert.equal(nextAppointmentStatus('已交换','accept'),'已交换');
});
test('导出的实际脚本可启动并完成报名、预约、同意和交换，不修改项目确认',()=>{
 const p=setup(),before=structuredClone(p),html=buildDemoHTML(p,p.cards[0]);
 const listeners:Record<string,(event:any)=>void>={};
 const nodes=new Map<string,any>();
 for(const id of ['top-title','page-label','login-status','content','trace-label','toast','dialog-title','dialog-body','dialog'])nodes.set(id,{innerHTML:'',textContent:'',classList:{add(){},remove(){}},showModal(){},close(){}});
 const document={getElementById:(id:string)=>nodes.get(id)||null,querySelectorAll:()=>[],addEventListener:(name:string,fn:any)=>{listeners[name]=fn;}};
 runInNewContext(html.match(/<script>([\s\S]*)<\/script>/)![1],{document,window:{setTimeout(){}},Blob,URL});
 const click=(action:string)=>listeners.click({target:{closest:()=>({dataset:{action}})}});
 assert.match(nodes.get('content').innerHTML,/欢迎来到招蛇大会/);
 nodes.set('registration',{reportValidity:()=>true});
 click('go:agenda');assert.match(nodes.get('content').innerHTML,/报名参会/);
 for(const [id,value] of Object.entries({name:'演示甲',company:'示例单位',phone:'19900000001',identity:'企业代表',membership:'external'}))nodes.set(id,{value});
 nodes.get('registration').onsubmit({preventDefault(){}});assert.match(nodes.get('content').innerHTML,/报名审核中/);
 click('go:companies');assert.match(nodes.get('content').innerHTML,/报名审核中/);
 click('approve');click('go:companies');assert.match(nodes.get('content').innerHTML,/招商公路/);
 click('invite:招商公路');nodes.set('slot',{value:'14:00—14:30'});click('submit-invite:招商公路');
 assert.match(nodes.get('content').innerHTML,/待确认/);assert.doesNotMatch(nodes.get('content').innerHTML,/199 0000 0002/);
 click('exchange:1');assert.doesNotMatch(nodes.get('content').innerHTML,/199 0000 0002/);
 click('accept:1');assert.match(nodes.get('content').innerHTML,/已同意/);
 click('exchange:1');assert.match(nodes.get('content').innerHTML,/199 0000 0002/);
 click('go:dinner');assert.match(nodes.get('content').innerHTML,/07/);click('unassign');assert.match(nodes.get('content').innerHTML,/桌号尚未分配/);
 click('fail');assert.match(nodes.get('content').innerHTML,/无法加载/);click('retry');assert.match(nodes.get('content').innerHTML,/桌号尚未分配/);
 assert.deepEqual(p,before);
});
test('源数据中的脚本闭合字符不能执行，导出不包含真实网络调用',()=>{
 const p=setup();p.demo!.title='</script><script>evil()</script>';p.cards[0].fields.goal='<img src=x onerror=evil()>';
 const html=buildDemoHTML(p,p.cards[0]);
 assert.equal((html.match(/<script>/g)||[]).length,1);assert.ok(!html.includes('</script><script>evil'));
 assert.match(html,/connect-src 'none'/);assert.doesNotMatch(html,/fetch\(|XMLHttpRequest/);
});
test('大会 ZIP 与界面同源并包含章节关系和同修订 PRD，正式评审状态不会被伪造',()=>{
 const p=setup(),files=unzipSync(demoZip(p,p.cards[0].id));
 assert.equal(strFromU8(files['index.html']),buildDemoHTML(p,p.cards[0]));
 assert.equal(strFromU8(files['PRD.md']),workspacePRD(p).markdown);
 const meta=JSON.parse(strFromU8(files['requirements.json']));assert.equal(meta.cards.length,8);assert.equal(meta.cards[0].kind,'conference');assert.equal(meta.cards[5].page,'appointments');
 const prd=workspacePRD(p);assert.equal(prd.formal,false);assert.match(prd.markdown,/尚未完成业务确认/);assert.match(prd.markdown,/支付与邀请码尚未明确/);assert.ok(p.cards.every(c=>!c.approvals.business));
});
test('新项目材料的真实证据可用于旧卡建议，采纳后才补入卡片来源',()=>{
 const p=setup(),c=p.cards[3],initial=[...c.sources];
 p.materials.push({id:'new-source',name:'追加会议纪要',kind:'文字',location:'会议原文',text:'名单外报名者须审核通过后查看大会议程。',status:'待整理',cardIds:[],createdAt:new Date().toISOString()});
 const draft={summary:'结合追加材料补充准入',issues:[],changes:[{field:'permission' as const,before:c.fields.permission,after:'名单外报名者须审核通过后查看大会议程。',reason:'原材料的明确要求',evidence:[{materialId:'new-source',quote:'名单外报名者须审核通过后查看大会议程。'}]}]};
 attachSuggestion(p,c.id,draft,c.revision,c.messages.length);assert.deepEqual(c.sources,initial);
 applyAction(p,{type:'applySuggestion',cardId:c.id,suggestionId:c.suggestion!.id,decisions:{permission:'采纳'}},'pm');
 assert.ok(c.sources.includes('new-source'));assert.equal(c.provenance.permission[0].materialId,'new-source');assert.deepEqual(c.approvals,{});
 assert.match(workspacePRD(p).markdown,/追加会议纪要/);
 const invalid={...draft,changes:[{...draft.changes[0],before:c.fields.permission,evidence:[{materialId:'other-project-source',quote:'不存在'}]}]};
 assert.throws(()=>attachSuggestion(p,c.id,invalid,c.revision,c.messages.length),/来源/);
});
