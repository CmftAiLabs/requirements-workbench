import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createCRMExperience} from '../server/experience';
import {applyAction} from '../server/domain';
import {textMaterial} from '../server/materials';
import {appendMaterialMessage} from '../server/chat-messages';
import {attachConversationRoute,validateConversationRoute} from '../server/chat-routing';
import {attachmentWarnings,conversationMaterials,pendingAttachmentMessages} from '../shared/chat-attachments';
import {discussionBasis,discussionRequest} from '../shared/discussion';
import {FIELDS,type Fields,type IntakeCandidate} from '../shared/types';

const formal=(p:ReturnType<typeof createCRMExperience>,index=1)=>structuredClone({fields:p.cards[index].fields,revision:p.cards[index].revision,approvals:p.cards[index].approvals,blockers:p.cards[index].blockers,phase:p.phase,version:p.version,cards:p.cards.length});
const newCard=(materialId:string):IntakeCandidate=>({key:'arrival',title:'企业到达信息登记',granularity:'具体',origin:'材料要求',rationale:'独立登记参会企业到达意向',coverageGaps:[],fields:{...Object.fromEntries(FIELDS.map(([key])=>[key,'待明确：需业务补充'])) as Fields,goal:'支持企业提交到达时间'},sourceIds:[materialId],assessment:'待澄清',issues:[],evidence:{goal:[{materialId,quote:'支持企业提交到达时间'}]}});

test('业务成员可发送附件，保留作者及材料来源；重试不重复发消息且不撤销确认',()=>{
 const p=createCRMExperience(),c=p.cards[1];
 applyAction(p,{type:'pmConfirm',cardId:c.id},'pm','pm');
 applyAction(p,{type:'businessConfirm',cardId:c.id,result:'通过',comment:''},'business','business');
 const before=formal(p),material=textMaterial('会务补充.md','支持企业提交到达时间'),input={text:'请结合这份材料分析。',clientMessageId:randomUUID()};
 const sent=appendMaterialMessage(p,c.id,'business-operations',input,[material]);
 assert.equal(sent.message.participantId,'business-operations');assert.deepEqual(sent.message.materialIds,[material.id]);
 assert.equal(material.sourceConversation?.messageId,sent.message.id);assert.match(material.location,/赵凯/);
 assert.deepEqual(formal(p),before);assert.equal(discussionRequest(p,c),undefined);
 const count=c.messages.length,materials=p.materials.length;
 assert.equal(appendMaterialMessage(p,c.id,'business-operations',input,[textMaterial('再传.md','重复的传输')]).created,false);
 assert.equal(c.messages.length,count);assert.equal(p.materials.length,materials);
 assert.throws(()=>appendMaterialMessage(p,c.id,'business-sales',input,[]),/其他参与人员/);
});

test('纯回答不产生正式需求，独立新需求只进入可编辑草稿，澄清建议必须有依据',()=>{
 const p=createCRMExperience(),c=p.cards[1],material=textMaterial('会务补充.md','支持企业提交到达时间。提醒失败不影响记录。');
 const sent=appendMaterialMessage(p,c.id,'business-operations',{text:'分析附件',clientMessageId:randomUUID()},[material]);
 const before=formal(p);
 assert.throws(()=>validateConversationRoute({reply:'修改当前需求',clarifiesCurrent:true,evidence:[],cards:[]},p,c,[material],true),/真实依据/);
 assert.throws(()=>validateConversationRoute({reply:'据材料回答',clarifiesCurrent:false,evidence:[{materialId:material.id,quote:'伪造的规定'}],cards:[]},p,c,[material],true),/原文/);
 const answer=validateConversationRoute({reply:'到达时间是企业提供的到场意向，不代表场地预订。',clarifiesCurrent:false,evidence:[],cards:[]},p,c,[material],true);
 assert.equal(attachConversationRoute(p,c.id,answer,discussionBasis(p,c),[sent.message.id],[material.id],[]),true);
 assert.deepEqual(formal(p),before);assert.equal(pendingAttachmentMessages(c).length,0);assert.equal(p.intakeBatches?.length||0,0);
 const draft=validateConversationRoute({reply:'附件另有企业到达信息登记诉求，建议先核对新卡草稿。',clarifiesCurrent:false,evidence:[{materialId:material.id,quote:'支持企业提交到达时间'}],cards:[newCard(material.id)]},p,c,[material],true);
 assert.equal(attachConversationRoute(p,c.id,draft,discussionBasis(p,c),[],[material.id],[]),true);
 assert.equal(p.intakeBatches?.at(-1)?.drafts.length,1);assert.equal(p.intakeBatches?.at(-1)?.drafts[0].poolCardId,undefined);
 assert.deepEqual(formal(p),before);
});

test('新卡不重复已有需求，不使用其他项目的材料，不凭普通聊天强造新卡',()=>{
 const p=createCRMExperience(),c=p.cards[1],material=textMaterial('会务补充.md','支持企业提交到达时间');
 const output={reply:'建议独立需求',clarifiesCurrent:false,evidence:[],cards:[newCard(material.id)]};
 assert.throws(()=>validateConversationRoute(output,p,c,[material],false),/没有新附件/);
 assert.throws(()=>validateConversationRoute({...output,cards:[{...newCard(material.id),title:c.title}]},p,c,[material],true),/不能重复/);
 assert.throws(()=>validateConversationRoute({...output,cards:[newCard('other-project-material')]},p,c,[material],true),/材料/);
 assert.throws(()=>validateConversationRoute({...output,relatedCardIds:['not-in-project'],cards:[]},p,c,[material],true),/真实存在/);
});

test('新发言或人工决定使材料分析过期，旧结果不覆盖，ZIP 子文件与失败记录可追溯',()=>{
 const p=createCRMExperience(),c=p.cards[1],parent=textMaterial('资料.zip','压缩包'),child=textMaterial('补充.md','支持企业提交到达时间');
 parent.text='';parent.status='已展开';parent.archiveEntries=[{path:'补充.md',materialId:child.id},{path:'录音.mp3',error:'请先转写文字'}];
 child.sourceArchive={id:parent.id,name:parent.name,path:'补充.md'};
 const sent=appendMaterialMessage(p,c.id,'business',{text:'分析资料',clientMessageId:randomUUID()},[parent]);p.materials.push(child,textMaterial('无关.md','不要混入本轮'));
 const materials=conversationMaterials(p,[parent.id]);assert.deepEqual(materials.map(m=>m.id),[parent.id,child.id]);
 assert.deepEqual(attachmentWarnings(materials),['资料.zip / 录音.mp3：请先转写文字']);
 const basis=discussionBasis(p,c),result={reply:'已读取',clarifiesCurrent:false,evidence:[],relatedCardIds:[],cards:[]};
 applyAction(p,{type:'message',cardId:c.id,text:'这份材料只解释术语，先不要提新需求。'},'pm','pm');
 const snapshot=structuredClone(p);
 assert.equal(attachConversationRoute(p,c.id,result,basis,[sent.message.id],[child.id],[]),false);
 assert.deepEqual(p,snapshot);
});
