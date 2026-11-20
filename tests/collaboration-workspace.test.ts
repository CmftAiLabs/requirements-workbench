import test from 'node:test';
import assert from 'node:assert/strict';
import {unzipSync,strFromU8} from 'fflate';
import mammoth from 'mammoth';
import {createCRMExperience} from '../server/experience.ts';
import {applyAction,attachSuggestion,beginDelivery,recordDeliveryResult} from '../server/domain.ts';
import {workspacePRD,prdWord,demoZip} from '../server/workspace-export.ts';
import {demoAccess,demoModel,liveSuggestion,previewFields} from '../shared/crm-demo.ts';
import {buildDemoHTML} from '../shared/project-demo.ts';
import {cardStatus,type SuggestionDraft,type Project} from '../shared/types.ts';
import {participantById,type ParticipantId} from '../shared/participants';
import {discussionReplayProject} from './fixtures/discussion-replay';
function proposed(){
 const p=createCRMExperience(),c=p.cards[0];
 const evidence=c.messages.filter(m=>m.role==='business'||m.role==='reviewer').map(m=>({messageId:m.id,quote:m.text}));
 const draft:SuggestionDraft={summary:'立即撤权，联动更新验收。',issues:[],changes:[{field:'permission',before:c.fields.permission,after:'销售主管可转交本部门客户；交接成功后立即撤销原负责人所有权限，新负责人获得编辑权限。',reason:'业务与评审已明确',evidence},{field:'acceptance',before:c.fields.acceptance,after:'交接成功后原负责人旧链接无权访问，新负责人可编辑；失败全部回滚。',reason:'联动验收',evidence}],problemResolutions:[{blockerId:c.blockers[0].id,resolution:'本期立即撤权，无临时只读例外。',requiredFields:['permission','acceptance'],requiredRoles:['business','reviewer'],evidence}]};
 attachSuggestion(p,c.id,draft,c.revision,c.messages.length);
 const action={type:'adoptConclusion' as const,cardId:c.id,suggestionId:c.suggestion!.id,decisions:{permission:'采纳' as const,acceptance:'采纳' as const},resolvedBlockerIds:[c.blockers[0].id]};
 return {p,c,action};
}
function confirmed(){const {p,action}=proposed();applyAction(p,action,'pm');for(const c of p.cards.filter(c=>c.included)){if(!c.approvals.pm)applyAction(p,{type:'pmConfirm',cardId:c.id},'pm');applyAction(p,{type:'businessConfirm',cardId:c.id,result:'通过',comment:'体验当前方案后确认'},'business');}return p;}

test('CRM 体验项目保留争议供人讨论，不预先确认任何需求',()=>{
 const p=createCRMExperience();assert.equal(p.cards.length,3);assert.ok(p.cards[0].blockers.some(b=>!b.resolved));assert.ok(p.cards[0].messages.some(m=>m.role==='reviewer'));assert.equal(p.cards[2].included,false);assert.ok(p.cards.every(c=>!c.approvals.pm&&!c.approvals.business));
});
test('一次采纳保存结论、解决有依据的问题并发起确认，业务仍须独立确认',()=>{
 const {p,c,action}=proposed();applyAction(p,action,'pm');const saved=p.cards[0];assert.equal(saved.revision,2);assert.equal(saved.blockers[0].resolved,true);assert.equal(saved.approvals.pm?.result,'通过');assert.equal(saved.approvals.business,undefined);assert.equal(cardStatus(saved),'可确认');assert.match(saved.fields.permission,/立即撤销/);
 applyAction(p,{type:'businessConfirm',cardId:saved.id,result:'通过',comment:'业务核对通过'},'business');assert.equal(cardStatus(p.cards[0]),'已确认');
});
test('沟通群在采纳和确认按钮处标出当前负责人，处理完成后移除待办提醒',async()=>{
 const {createElement}=await import('react');
 const {renderToStaticMarkup}=await import('react-dom/server');
 const {registerHooks}=await import('node:module');
 const cssHook=registerHooks({load(url,context,next){return url.endsWith('.css')?{format:'module',source:'export {};',shortCircuit:true}:next(url,context);}});
 const {CollaborationWorkspace}=await import('../src/collaboration-workspace').finally(()=>cssHook.deregister());
 const renderMentions=(project:Project,participantId:ParticipantId)=>{
  const html=renderToStaticMarkup(createElement(CollaborationWorkspace,{
   project,card:project.cards[0],role:participantById(participantId)!.role,participantId,busy:false,jobs:[],modelConfigured:true,
   setCard:()=>{},mutate:async()=>true,suggest:async()=>true,generateDemo:async()=>true,organize:async()=>true,
   sendMaterials:async()=>true,resumeDiscussion:async()=>true,goMaterials:()=>{},onManage:()=>{},
  }));
  return Array.from(html.matchAll(/class="co-action-mention"[^>]*>(@[^<]+)/g),match=>match[1]);
 };

 for(const proposer of ['business-operations','pm'] as const){
  const {p,c}=discussionReplayProject();
  assert.deepEqual(renderMentions(p,'business-operations'),['@林舟']);
  applyAction(p,{type:'message',cardId:c.id,text:'建议提交成功后显示申请编号，方便员工查询。'},participantById(proposer)!.role,proposer);
  const message=c.messages[0];
  attachSuggestion(p,c.id,{summary:'提交成功后显示申请编号。',issues:[],changes:[{
   field:'flow',before:c.fields.flow,after:c.fields.flow+' 成功后显示申请编号。',reason:'方便查询',
   evidence:[{messageId:message.id,quote:message.text}],
  }]},c.revision,c.messages.length);
  assert.deepEqual(renderMentions(p,proposer),['@林舟']);
  applyAction(p,{type:'adoptConclusion',cardId:c.id,suggestionId:c.suggestion!.id,decisions:{flow:'采纳'}},'pm','pm');
  assert.deepEqual(renderMentions(p,'pm'),['@陈敏']);
  assert.deepEqual(renderMentions(p,'business-operations'),['@陈敏']);
  assert.deepEqual(renderMentions(p,'business'),['@陈敏']);
  applyAction(p,{type:'businessConfirm',cardId:c.id,result:'通过',comment:''},'business','business');
  assert.deepEqual(renderMentions(p,'business'),[]);
 }
});

test('不完整采纳只保存结论，不越过问题或九字段门槛',()=>{
 const {p,action}=proposed();applyAction(p,{...action,resolvedBlockerIds:[]},'pm');assert.equal(p.cards[0].approvals.pm,undefined);assert.equal(cardStatus(p.cards[0]),'待澄清');
 const next=proposed();next.p.cards[0].fields.quality='待明确';applyAction(next.p,next.action,'pm');assert.equal(next.p.cards[0].approvals.pm,undefined);
});
test('全部拒绝修改建议只保留原需求，不擅自发起产品确认',()=>{
 const p=createCRMExperience(),c=p.cards[1],before=structuredClone(c);
 attachSuggestion(p,c.id,{summary:'可选新行为',issues:[],changes:[{field:'flow',before:c.fields.flow,after:c.fields.flow+' 增加批量处理。',reason:'可选',evidence:[]}]},c.revision,c.messages.length);
 applyAction(p,{type:'adoptConclusion',cardId:c.id,suggestionId:c.suggestion!.id,decisions:{flow:'不采纳'}},'pm');
 assert.deepEqual(p.cards[1].fields,before.fields);assert.deepEqual(p.cards[1].approvals,before.approvals);assert.deepEqual(p.cards[1].confirmations,before.confirmations);assert.equal(p.cards[1].revision,before.revision);assert.equal(p.cards[1].suggestion?.status,'已写入');
});
test('错误角色、未完整选择和过期结论均不产生部分写入',()=>{
 for(const kind of ['role','incomplete','stale'] as const){const {p,c,action}=proposed();if(kind==='stale')applyAction(p,{type:'message',cardId:c.id,text:'补充讨论'},'business');const before=structuredClone(p);assert.throws(()=>applyAction(p,kind==='incomplete'?{...action,decisions:{permission:'采纳'}}:action,kind==='role'?'business':'pm'));assert.deepEqual(p,before);}
});
test('已明确后的再次采纳回退阶段，保留其他卡确认及历史版本',()=>{
 const p=confirmed();applyAction(p,{type:'submitReview'},'pm');applyAction(p,{type:'review',result:'通过',comment:'整体已评审'},'reviewer');const other=structuredClone(p.cards[1].approvals),history=structuredClone(p.snapshots),c=p.cards[0];attachSuggestion(p,c.id,{summary:'补充完整验收',issues:[],changes:[{field:'acceptance',before:c.fields.acceptance,after:c.fields.acceptance+' 并检查站内通知摘要。',reason:'联动核对',evidence:[]}]},c.revision,c.messages.length);applyAction(p,{type:'adoptConclusion',cardId:c.id,suggestionId:c.suggestion!.id,decisions:{acceptance:'采纳'}},'pm');assert.equal(p.phase,'可讨论');assert.equal(p.cards[0].approvals.business,undefined);assert.equal(p.cards[0].approvals.pm?.revision,p.cards[0].revision);assert.deepEqual(p.cards[1].approvals,other);assert.deepEqual(p.snapshots,history);
});
test('演示草稿与正式正文区分；讨论变化后立即回到已保存版本',()=>{
 const {p,c}=proposed();assert.equal(demoAccess(c.fields),'readonly30');assert.equal(demoModel(p,c).access,'immediate');assert.ok(demoModel(p,c).draft);assert.match(workspacePRD(p).markdown,/原负责人保留 30 天只读/);assert.ok(workspacePRD(p).markdown.includes('尚未采纳'));
 applyAction(p,{type:'message',cardId:c.id,text:'新意见，需要进一步核对'},'reviewer');assert.equal(liveSuggestion(c),undefined);assert.equal(previewFields(c),c.fields);assert.equal(demoModel(p,c).access,'readonly30');
});
test('未覆盖权限规则不擅自推断；通知演示关联交接卡',()=>{
 const p=createCRMExperience(),f=p.cards[0].fields;assert.equal(demoAccess({...f,permission:'撤权规则待明确'}),'unspecified');assert.equal(demoAccess({...f,permission:'原负责人不立即撤销权限'}),'unspecified');assert.equal(demoAccess({...f,permission:'不保留 30 天只读，其他处理待确认'}),'unspecified');assert.equal(demoAccess({...f,permission:'交接成功后原负责人立即撤销读取、编辑权限'}),'immediate');const m=demoModel(p,p.cards[1]);assert.equal(m.kind,'notification');assert.equal(m.relatedCardId,p.cards[0].id);assert.equal(m.access,'readonly30');
});
test('导出 ZIP 与当前预览一致，包含来源修订和可离线运行文件',()=>{
 const {p,c}=proposed(),files=unzipSync(demoZip(p,c.id)),meta=JSON.parse(strFromU8(files['requirements.json']));assert.equal(strFromU8(files['index.html']),buildDemoHTML(p,c));assert.equal(meta.initialCardId,c.id);assert.equal(meta.cards[0].suggestionId,c.suggestion!.id);assert.equal(meta.cards[0].draft,true);assert.ok(files['demo-2.html']);assert.match(strFromU8(files['README.md']),/双击 index.html/);
 c.fields.goal='</script><script>fetch("https://bad.invalid")</script>';c.suggestion=undefined;const html=buildDemoHTML(p,c);assert.ok(!html.includes('</script><script>fetch'));assert.match(html,/connect-src 'none'/);assert.match(html,/\\u003c\/script>/);
});
test('PRD Word 能被标准文档解析，保留未确认状态、范围和来源',async()=>{
 const p=createCRMExperience();const raw=await mammoth.extractRawText({buffer:await prdWord(p)});assert.match(raw.value,/产品需求文档（草稿）/);assert.match(raw.value,/客户交接与权限/);assert.match(raw.value,/尚未确认当前修订/);assert.match(raw.value,/跨部门批量导出/);assert.match(raw.value,/来源/);
});
test('正式 PRD 导出严格取冻结快照；讨论和交付不会污染已评审正文',()=>{
 const p=confirmed();applyAction(p,{type:'submitReview'},'pm');applyAction(p,{type:'review',result:'通过',comment:'通过'},'reviewer');const original=p.snapshots.at(-1)!.markdown;applyAction(p,{type:'message',cardId:p.cards[0].id,text:'下一期另行讨论'},'business');assert.equal(workspacePRD(p).markdown,original);assert.equal(workspacePRD(p).formal,true);const delivery=beginDelivery(p,'pm','local');for(const key of ['knowledge','teammate'] as const)recordDeliveryResult(p,delivery.id,key,{ok:true,receipt:'local-test'});assert.equal(workspacePRD(p).markdown,p.snapshots.at(-1)!.markdown);assert.equal(p.phase,'已交付');
});

test('预置 CRM 演练有明确来源，只生成建议且不适用于真实项目或已改版卡片',async()=>{
 const {applyCRMExampleConclusion}=await import('../server/experience.ts');const p=createCRMExperience();applyCRMExampleConclusion(p,p.cards[0].id,'business');assert.equal(p.cards[0].suggestion?.origin,'example');assert.deepEqual(p.cards[0].approvals,{});assert.equal(p.cards[0].revision,1);assert.match(p.cards[0].suggestion!.summary,/未调用模型/);
 const original=structuredClone(p);delete p.example;assert.throws(()=>applyCRMExampleConclusion(p,p.cards[0].id,'pm'),/预置结论/);p.example='crm';p.cards[0].revision=2;assert.throws(()=>applyCRMExampleConclusion(p,p.cards[0].id,'pm'),/预置结论/);assert.equal(original.cards[0].suggestion!.status,'待决定');
});
