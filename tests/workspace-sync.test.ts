import test from 'node:test';
import assert from 'node:assert/strict';
import {createCRMExperience} from '../server/experience';
import {compactProject,createWorkspaceSync} from '../server/workspace-sync';
import {stateDiff,applyStatePatches} from '../shared/workspace-sync';
import {liveSuggestion} from '../shared/crm-demo';
import type {Bootstrap} from '../shared/types';

function fixture():Bootstrap{return {project:createCRMExperience(),projects:[],participantId:'pm',role:'pm',jobs:[],config:{model:'fixture',modelConfigured:false,knowledgeConfigured:false,teammateConfigured:false,localOnly:true}};}
test('增量补丁重建相同状态，保留未变化分支并拒绝危险路径',()=>{
 const before={cards:[{id:'a',text:'before',messages:[{id:'m1'}]},{id:'b',text:'stable'}],removed:true};
 const after={cards:[{id:'a',text:'after',messages:[{id:'m1'},{id:'m2'}]},{id:'b',text:'stable'}]};
 const patches=stateDiff(before,after),result=applyStatePatches(before,patches);assert.deepEqual(result,after);assert.equal(result.cards[1],before.cards[1]);assert.notEqual(result.cards[0],before.cards[0]);assert.ok(patches.some(p=>p.op==='append'));
 assert.throws(()=>applyStatePatches(before,[{op:'set',path:['__proto__','polluted'],value:true}]),/非法/);assert.equal(({} as {polluted?:boolean}).polluted,undefined);
 assert.throws(()=>applyStatePatches(before,[{op:'set',path:['cards','999','id'],value:'x'}]),/越界/);
});
test('游标复用、缺失重建、角色隔离和过期回退不丢失新状态',async()=>{
 const sync=createWorkspaceSync(1024*1024,2),value=fixture();let loads=0;const load=async()=>{loads++;return structuredClone(value);};
 const initial=await sync('p:pm','v1',undefined,load);assert.equal(initial.kind,'snapshot');
 const other=await sync('p:pm','v1',undefined,load);assert.equal(other.cursor,initial.cursor);assert.equal(loads,1);
 assert.equal((await sync('p:pm','v1',initial.cursor,load)).kind,'unchanged');
 value.project.stamp++;value.project.cards[0].messages.push({id:'new',role:'business',text:'new discussion',createdAt:'2026-11-13'});
 const changed=await sync('p:pm','v2',initial.cursor,load);assert.equal(changed.kind,'delta');if(changed.kind==='delta'&&initial.kind==='snapshot')assert.deepEqual(applyStatePatches(initial.value,changed.patches),value);
 const role=await sync('p:business','v2',initial.cursor,async()=>({...value,role:'business',participantId:'business'}));assert.equal(role.kind,'snapshot');
 assert.equal((await sync('p:pm','v2',initial.cursor,load)).kind,'snapshot');
 const restarted=createWorkspaceSync();assert.equal((await restarted('p:pm','v2',changed.cursor,load)).kind,'snapshot');
});
test('紧凑读模型按需保留正文、讨论与版本，并保持建议和变更判断',()=>{
 const p=createCRMExperience(),c=p.cards[0];c.messages=Array.from({length:200},(_,i)=>({id:`m-${i}`,role:'business',text:`message ${i}`,createdAt:String(i)}));
 c.messages[0].kind='change';c.messages[0].accepted=false;c.suggestion={id:'s',baseRevision:c.revision,messageCount:200,summary:'fixture',issues:[],changes:[{field:'flow',before:c.fields.flow,after:c.fields.flow+' 新流程',reason:'业务补充',evidence:[]}],status:'待决定',createdAt:'now'};
 const before=structuredClone(p),view=compactProject(p),card=view.cards[0];assert.equal(card.messageCount,200);assert.equal(card.messages.length,5);assert.ok(card.messages.some(m=>m.id==='m-0'));assert.ok(liveSuggestion(card));assert.equal(view.materials[0].text,'');assert.equal(view.materials[0].textAvailable,true);assert.deepEqual(p,before);
 card.messageCount=201;assert.equal(liveSuggestion(card),undefined);
});
test('并发客户端共享同一版本快照，避免重复加载和过早挤出游标',async()=>{
 const sync=createWorkspaceSync();let loads=0;const value=fixture();
 const replies=await Promise.all(Array.from({length:20},()=>sync('p:pm','v1',undefined,async()=>{loads++;await new Promise(r=>setTimeout(r,5));return value;})));
 assert.equal(loads,1);assert.equal(new Set(replies.map(r=>r.cursor)).size,1);
});
