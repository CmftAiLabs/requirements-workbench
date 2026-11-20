import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { parse } from 'dotenv';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { addExtractedCards, applyAction, attachIntakeBatch, attachSuggestion, beginDelivery, createProject, recordDeliveryResult } from '../server/domain.ts';
import type { Fields, Job, Project, Role, Action, IntakeCandidate } from '../shared/types.ts';

const completeFields: Fields = {
  goal: '交接后责任明确', scope: '同部门单个客户转交，不含批量与跨部门', flow: '主管填写原因并选择接收人后提交',
  permission: '原负责人立即撤权，新负责人有编辑权限', exception: '失败全部回滚，重复提交只执行一次',
  data: '保存客户与交接记录一年', constraint: '依赖员工目录和权限服务', quality: '负责人和权限在同一事务更新',
  acceptance: '主管可转交，其他人不能操作，原负责人交接后不能再读写',
};
function readyProject(name: string) {
  const project = createProject(name);
  addExtractedCards(project, [{title: '单个客户转交', fields: {...completeFields}, sourceIds: ['crm-kickoff'], assessment: '可确认', issues: [], evidence: {}}], ['crm-kickoff']);
  return project;
}
function confirmAndReview(project: Project) {
  const cardId = project.cards[0].id;
  applyAction(project, {type: 'pmConfirm', cardId}, 'pm');
  applyAction(project, {type: 'businessConfirm', cardId, result: '通过', comment: '业务确认'}, 'business');
  applyAction(project, {type: 'submitReview'}, 'pm');
  applyAction(project, {type: 'review', result: '通过', comment: '边界与验收已核对'}, 'reviewer');
}

function storedZip(files:Record<string,Buffer>) {
  const local:Buffer[]=[], central:Buffer[]=[];let offset=0;
  for(const [filename,body] of Object.entries(files)){
    const name=Buffer.from(filename),crc=crc32(body),header=Buffer.alloc(30),entry=Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt16LE(0x800,6);header.writeUInt32LE(crc,14);
    header.writeUInt32LE(body.length,18);header.writeUInt32LE(body.length,22);header.writeUInt16LE(name.length,26);
    entry.writeUInt32LE(0x02014b50);entry.writeUInt16LE(20,4);entry.writeUInt16LE(20,6);entry.writeUInt16LE(0x800,8);entry.writeUInt32LE(crc,16);
    entry.writeUInt32LE(body.length,20);entry.writeUInt32LE(body.length,24);entry.writeUInt16LE(name.length,28);entry.writeUInt32LE(offset,42);
    local.push(header,name,body);central.push(entry,name);offset+=header.length+name.length+body.length;
  }
  const directory=Buffer.concat(central),end=Buffer.alloc(22),count=Object.keys(files).length;
  end.writeUInt32LE(0x06054b50);end.writeUInt16LE(count,8);end.writeUInt16LE(count,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...local,directory,end]);
}

test('独立临时 PostgreSQL 数据库中的 API、交付与重启集成', {timeout: 45000}, async t => {
  let sourceURL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
  if (!sourceURL) {
    try { sourceURL = parse(await readFile(new URL('../.env', import.meta.url))).DATABASE_URL; } catch { /* No local database is a documented skip. */ }
  }
  if (!sourceURL) { t.skip('未配置本地 PostgreSQL，集成测试跳过；不会操作默认项目'); return; }
  const dbName = `requirements_test_${process.pid}_${randomUUID().slice(0, 8)}`;
  const admin = new pg.Pool({connectionString: sourceURL, connectionTimeoutMillis: 3000});
  const testURL = new URL(sourceURL); testURL.pathname = `/${dbName}`;
  let created = false;
  let app: FastifyInstance | undefined;
  let store: typeof import('../server/store.js') | undefined;
  let receiver: ReturnType<typeof createServer> | undefined;
  let dataDir: string | undefined;
  try {
    await admin.query(`CREATE DATABASE "${dbName}"`); created = true;
    process.env.DATABASE_URL = testURL.toString();
    process.env.SESSION_SECRET = 'integration-test-session-secret-must-be-long-enough';
    process.env.MODEL_API_KEY = ''; // No integration test is permitted to call the paid model.
    process.env.KNOWLEDGE_DELIVERY_URL = ''; process.env.TEAMMATE_DELIVERY_URL = '';
    process.env.KNOWLEDGE_DELIVERY_TOKEN = ''; process.env.TEAMMATE_DELIVERY_TOKEN = '';
    const {config} = await import('../server/config.js');
    dataDir = await mkdtemp(path.join(tmpdir(), 'requirements-integration-'));
    config.dataDir = dataDir;
    for (const directory of ['materials', 'receipts/knowledge', 'receipts/teammate']) await mkdir(path.join(dataDir, directory), {recursive: true});
    store = await import('../server/store.js');
    const db = store;
    const {buildApp} = await import('../server/app.js');
    await db.initStore();
    app = await buildApp();
    const cookies = {} as Record<Role, string>;
    for (const role of ['pm', 'business'] as const) {
      const response: LightMyRequestResponse = await app.inject({method: 'POST', url: '/api/session', headers: {host: '127.0.0.1', origin: 'http://127.0.0.1'}, payload: {role}});
      assert.equal(response.statusCode, 200);
      const setCookie = response.headers['set-cookie'];
      cookies[role] = (Array.isArray(setCookie) ? setCookie[0] : setCookie!).split(';')[0];
    }
    const request = (url: string, payload: unknown, role: Role = 'pm') => app!.inject({method: 'POST', url, headers: {host: '127.0.0.1', origin: 'http://127.0.0.1', cookie: cookies[role]}, payload: payload as object});
    const act = (project: Project, action: object, role: Role = 'pm') => request(`/api/projects/${project.id}/actions`, {stamp: project.stamp, action}, role);
    const waitJob = async (projectId: string, jobId: string) => {
      for (let index = 0; index < 100; index++) {
        const job = (await db.listJobs(projectId)).find(item => item.id === jobId);
        if (job && ['succeeded', 'failed'].includes(job.status)) return job;
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      throw new Error('独立集成测试后台任务未结束');
    };

    await t.test('HTTPS 公网会话、跨站保护和入口令牌校验',async()=>{
      const saved={publicOrigin:config.publicOrigin,proxyAccessToken:config.proxyAccessToken};
      try{
        config.publicOrigin='https://prototype.ai-native-lab.com';config.proxyAccessToken='integration-gateway-secret-only-for-testing';
        const headers={host:'prototype.ai-native-lab.com',origin:config.publicOrigin,'x-workbench-token':config.proxyAccessToken};
        assert.equal((await app!.inject({url:'/api/health',headers:{host:headers.host}})).statusCode,401);
        assert.equal((await app!.inject({url:'/api/health',headers:{...headers,host:'evil.test'}})).statusCode,403);
        assert.equal((await app!.inject({method:'POST',url:'/api/session',headers:{...headers,origin:'https://evil.test'},payload:{role:'pm'}})).statusCode,403);
        const response=await app!.inject({method:'POST',url:'/api/session',headers,payload:{role:'pm'}});
        assert.equal(response.statusCode,200);
        const cookies=response.headers['set-cookie'];
        for(const cookie of Array.isArray(cookies)?cookies:[cookies!]){assert.match(cookie,/; Secure/);assert.match(cookie,/; HttpOnly/);assert.match(cookie,/; SameSite=Strict/i);}
        assert.equal((await app!.inject({url:'/api/bootstrap',headers})).json().config.localOnly,false);
      }finally{Object.assign(config,saved);}
    });

    await t.test('模型目录、角色权限、活动任务保护和持久化选择',async()=>{
      const {currentModel,setSelectedModel}=await import('../server/model-settings');
      const original=currentModel();
      const catalog=(await app!.inject({url:'/api/models'})).json();
      assert.ok(catalog.options.includes('CMFT-glm-5.3-flash'));assert.equal(catalog.options.length>=7,true);
      assert.equal((await request('/api/models',{model:'glm-5.3'},'business')).statusCode,403);
      assert.equal((await request('/api/models',{model:'unknown'})).statusCode,400);
      assert.equal((await request('/api/models',{model:'glm-5.3'})).statusCode,200);
      assert.equal(currentModel(),'glm-5.3');setSelectedModel(undefined);await db.initStore();assert.equal(currentModel(),'glm-5.3');
      const p=readyProject('模型切换保护');await db.insertProject(p);const job=await db.newJob(p.id,'listen','测试运行中任务',p.cards[0].id);
      assert.equal((await request('/api/models',{model:'qwen3.8-max'})).statusCode,409);assert.equal(currentModel(),'glm-5.3');
      job.status='succeeded';await db.putJob(job);
      await db.pool.query("DELETE FROM app_settings WHERE key='model'");setSelectedModel(undefined);assert.equal(currentModel(),original);
    });

    await t.test('模型等待期间数据库空闲连接被关闭后可重新连接',async()=>{
      const pid=(await db.pool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      let timer:ReturnType<typeof setTimeout>|undefined;const disconnected=new Promise<void>((resolve,reject)=>{db.pool.once('error',()=>{if(timer)clearTimeout(timer);resolve();});timer=setTimeout(()=>reject(Error('未收到空闲连接断开事件')),3000);});
      try{await admin.query('SELECT pg_terminate_backend($1)',[pid]);await disconnected;assert.equal((await db.pool.query('SELECT 1 AS ok')).rows[0].ok,1);}finally{if(timer)clearTimeout(timer);}
    });

    await t.test('独立业务会话保留发言身份，评审角色不能再登录，贡献者不能确认',async()=>{
      const headers={host:'127.0.0.1',origin:'http://127.0.0.1'};
      const retired=await app!.inject({method:'POST',url:'/api/session',headers,payload:{role:'reviewer'}});
      assert.equal(retired.statusCode,400);
      const p=readyProject('多业务会话');await db.insertProject(p);
      const original=structuredClone(p.cards[0].fields);
      for(const participantId of ['business-sales','business-operations']){
        const session=await app!.inject({method:'POST',url:'/api/session',headers,payload:{participantId}});
        assert.equal(session.statusCode,200);assert.equal(session.json().role,'business');
        const cookies=session.headers['set-cookie'];const cookie=(Array.isArray(cookies)?cookies:[cookies!]).map(v=>v.split(';')[0]).join('; ');
        const current=await db.getProject(p.id);
        const response=await app!.inject({method:'POST',url:`/api/projects/${p.id}/actions`,headers:{...headers,cookie},payload:{stamp:current.stamp,action:{type:'message',cardId:p.cards[0].id,text:'补充当前业务的限制。',participantId:'pm',role:'pm'}}});
        assert.equal(response.statusCode,200);
        const updated=await db.getProject(p.id);assert.equal(updated.cards[0].messages.at(-1)?.participantId,participantId);assert.equal(updated.cards[0].messages.at(-1)?.role,'business');
        const rejected=await app!.inject({method:'POST',url:`/api/projects/${p.id}/actions`,headers:{...headers,cookie},payload:{stamp:updated.stamp,action:{type:'businessConfirm',cardId:p.cards[0].id,result:'通过',comment:'确认'}}});
        assert.equal(rejected.statusCode,400);assert.match(rejected.json().error,/业务负责人/);
      }
      assert.deepEqual((await db.getProject(p.id)).cards[0].fields,original);
    });

    await t.test('紧凑首屏、增量同步和按需历史读取保持原文与身份边界',async()=>{
      const {applyStatePatches}=await import('../shared/workspace-sync');
      const p=readyProject('增量 API 验收'),c=p.cards[0];p.materials[0].text='完整材料正文'.repeat(5000);
      for(let i=0;i<3;i++)applyAction(p,{type:'editCard',cardId:c.id,title:c.title,fields:{...c.fields,quality:c.fields.quality+` 合成修订 ${i}`},reason:`合成历史 ${i}`},'pm');
      c.messages=Array.from({length:120},(_,i)=>({id:`page-${i}`,role:'business',text:`合成讨论 ${i}`,createdAt:new Date(1700000000000+i*1000).toISOString()}));await db.insertProject(p);
      const url=`/api/workspace/sync?projectId=${p.id}`,first=await app!.inject({url,headers:{host:'127.0.0.1',cookie:cookies.pm}}),snapshot=first.json();assert.equal(snapshot.kind,'snapshot');assert.equal(snapshot.value.project.materials[0].text,'');assert.equal(snapshot.value.project.cards[0].messageCount,120);assert.equal(snapshot.value.project.cards[0].messages.length,4);assert.ok(first.headers['server-timing']);
      const same=await app!.inject({url:url+'&cursor='+snapshot.cursor,headers:{host:'127.0.0.1',cookie:cookies.pm}});assert.equal(same.json().kind,'unchanged');assert.ok(same.payload.length<150);
      const pageHTML=(await app!.inject({url:'/',headers:{host:'127.0.0.1'}})).body;
      const clientEntry=pageHTML.match(/src="(\/assets\/index-[^"]+\.js)"/)?.[1];
      assert.equal(snapshot.clientEntry,clientEntry);
      assert.equal(same.json().clientEntry,clientEntry);
      assert.equal(snapshot.value.project.cards[0].history.length,2);assert.equal(snapshot.value.project.cards[0].historyCount,c.history.length);
      const history=await app!.inject({url:`/api/projects/${p.id}/cards/${c.id}/history`,headers:{host:'127.0.0.1'}});assert.deepEqual(history.json().history,c.history);
      const page=await app!.inject({url:`/api/projects/${p.id}/cards/${c.id}/messages?limit=40`,headers:{host:'127.0.0.1'}});assert.equal(page.json().messages.length,40);assert.equal(page.json().messages[0].id,'page-80');const older=await app!.inject({url:`/api/projects/${p.id}/cards/${c.id}/messages?limit=40&before=${page.json().nextBefore}`,headers:{host:'127.0.0.1'}});assert.equal(older.json().messages.at(-1).id,'page-79');
      assert.equal((await app!.inject({url:`/api/projects/${p.id}/materials/${p.materials[0].id}/text`,headers:{host:'127.0.0.1'}})).json().text,p.materials[0].text);
      await db.mutateProject(p.id,next=>applyAction(next,{type:'message',cardId:c.id,text:'新讨论消息用于验证增量'},'business'));
      const changed=(await app!.inject({url:url+'&cursor='+snapshot.cursor,headers:{host:'127.0.0.1',cookie:cookies.pm}})).json();assert.equal(changed.kind,'delta');const reconstructed=applyStatePatches(snapshot.value,changed.patches) as typeof snapshot.value;assert.equal(reconstructed.project.cards[0].messageCount,121);assert.ok(reconstructed.project.cards[0].messages.some((m:{text:string})=>m.text==='新讨论消息用于验证增量'));assert.ok(JSON.stringify(changed).length<first.payload.length);
      const otherRole=(await app!.inject({url:url+'&cursor='+snapshot.cursor,headers:{host:'127.0.0.1',cookie:cookies.business}})).json();assert.equal(otherRole.kind,'snapshot');assert.equal(otherRole.value.role,'business');
      assert.equal((await app!.inject({url:'/api/metrics',headers:{host:'127.0.0.1',cookie:cookies.business}})).statusCode,403);const metrics=await app!.inject({url:'/api/metrics',headers:{host:'127.0.0.1',cookie:cookies.pm}});assert.equal(metrics.statusCode,200);assert.ok(metrics.json().series.some((s:{name:string})=>s.name==='sync.delta'));
    });

    await t.test('顶栏待办按身份跨项目同步，回答、采纳和确认后随当前状态更新',async()=>{
      const {attachDiscussion}=await import('../server/discussion');
      const {discussionBasis}=await import('../shared/discussion');
      const {applyStatePatches}=await import('../shared/workspace-sync');
      const viewing=createProject('待办验收 · 当前项目');
      const proposed=readyProject('待办验收 · 另一项目'),proposedCard=proposed.cards[0];
      attachSuggestion(proposed,proposedCard.id,{summary:'补充采购信息',issues:[],changes:[
        {field:'flow',before:proposedCard.fields.flow,after:proposedCard.fields.flow+' 保存后提示单号。',reason:'便于核对',evidence:[]},
      ]},proposedCard.revision,0);
      const questioned=readyProject('待办验收 · 指定业务回复'),questionedCard=questioned.cards[0];
      applyAction(questioned,{type:'message',cardId:questionedCard.id,text:'场地变更是否需要向申请人说明？'},'pm','pm');
      attachDiscussion(questioned,questionedCard.id,{answer:null,summarize:false,question:{
        field:'flow',question:'赵凯，场地变更时是否通知申请人？',options:['发站内通知','联系申请人'],role:'business',participantId:'business-operations',
      }},discussionBasis(questioned,questionedCard));
      const questionId=questionedCard.followUps![0].id;
      for(const project of [viewing,proposed,questioned])await db.insertProject(project);
      const ids=new Set([proposed.id,questioned.id]);
      const forProjects=(value:import('../shared/types').Bootstrap)=>value.reminders!.filter(item=>ids.has(item.projectId));
      const syncURL='/api/workspace/sync?projectId='+viewing.id;
      const sync=async(cookie:string,cursor?:string)=>{
        const response=await app!.inject({url:syncURL+(cursor?'&cursor='+cursor:''),headers:{host:'127.0.0.1',cookie}});
        assert.equal(response.statusCode,200,response.body);
        return response.json();
      };
      const session=async(participantId:string)=>{
        const response=await app!.inject({method:'POST',url:'/api/session',headers:{host:'127.0.0.1',origin:'http://127.0.0.1'},payload:{participantId}});
        assert.equal(response.statusCode,200);
        return ([] as string[]).concat(response.headers['set-cookie']!).map(cookie=>cookie.split(';')[0]).join('; ');
      };
      const operations=await session('business-operations'),sales=await session('business-sales');
      const pmStart=await sync(cookies.pm);
      assert.equal(pmStart.value.project.id,viewing.id);
      assert.deepEqual(forProjects(pmStart.value).map(item=>[item.projectId,item.kind,item.anchorId]),
        [[proposed.id,'adopt','suggestion-'+proposedCard.suggestion!.id]]);
      const opsStart=await sync(operations,pmStart.cursor);
      assert.equal(opsStart.kind,'snapshot');
      assert.deepEqual(forProjects(opsStart.value).map(item=>[item.projectId,item.kind,item.anchorId]),
        [[questioned.id,'reply','question-'+questionId]]);
      assert.deepEqual(forProjects((await sync(sales)).value),[]);
      const businessStart=await sync(cookies.business);
      assert.deepEqual(forProjects(businessStart.value),[]);
      assert.equal((await sync(cookies.pm,pmStart.cursor)).kind,'unchanged');

      const saved=await act(proposed,{type:'adoptConclusion',cardId:proposedCard.id,suggestionId:proposedCard.suggestion!.id,decisions:{flow:'采纳'}});
      assert.equal(saved.statusCode,200,saved.body);
      const update=await sync(cookies.business,businessStart.cursor);
      assert.equal(update.kind,'delta');
      const businessAfter=applyStatePatches(businessStart.value,update.patches);
      assert.deepEqual(forProjects(businessAfter).map(item=>[item.projectId,item.kind,item.anchorId]),
        [[proposed.id,'confirm','confirmation-'+proposedCard.id]]);
      assert.deepEqual(forProjects((await sync(cookies.pm)).value),[]);
      const confirmed=await act(saved.json(),{type:'businessConfirm',cardId:proposedCard.id,result:'通过',comment:'人工核对通过'},'business');
      assert.equal(confirmed.statusCode,200,confirmed.body);
      assert.deepEqual(forProjects((await sync(cookies.business)).value),[]);

      await db.mutateProject(questioned.id,current=>{
        const answer='场地变更时发站内通知给申请人。';
        applyAction(current,{type:'message',cardId:questionedCard.id,text:answer,replyTo:questionId},'business','business-operations');
        const card=current.cards[0];
        attachDiscussion(current,card.id,{question:null,summarize:false,answer:{questionId,messageId:card.messages.at(-1)!.id,quote:answer}},discussionBasis(current,card));
        assert.equal(card.followUps![0].status,'answered');
      });
      const opsAfter=await sync(operations,opsStart.cursor);
      assert.equal(opsAfter.kind,'delta');
      assert.deepEqual(forProjects(applyStatePatches(opsStart.value,opsAfter.patches)),[]);
    });

    await t.test('讨论热写入保持确认与正文，重启后可读，后续领域写入原子合并历史',async()=>{
      const p=readyProject('热讨论持久化'),c=p.cards[0];applyAction(p,{type:'pmConfirm',cardId:c.id},'pm');applyAction(p,{type:'businessConfirm',cardId:c.id,result:'通过',comment:'合成确认'},'business');attachSuggestion(p,c.id,{summary:'待决定建议',issues:[],changes:[{field:'flow',before:c.fields.flow,after:c.fields.flow+' 补充方案',reason:'合成',evidence:[]}]},c.revision,c.messages.length);await db.insertProject(p);
      const original=structuredClone({fields:c.fields,approvals:c.approvals,phase:p.phase,version:p.version});
      const response=await app!.inject({method:'POST',url:`/api/projects/${p.id}/actions`,headers:{host:'127.0.0.1',origin:'http://127.0.0.1',cookie:cookies.business,prefer:'return=minimal'},payload:{stamp:p.stamp,action:{type:'message',cardId:c.id,text:'合成热写消息，不代表确认新方案'}}});assert.equal(response.statusCode,204);
      let current=await db.getProject(p.id);assert.equal(current.cards[0].messages.at(-1)?.text,'合成热写消息，不代表确认新方案');assert.equal(current.cards[0].suggestion?.status,'已失效');assert.deepEqual({fields:current.cards[0].fields,approvals:current.cards[0].approvals,phase:current.phase,version:current.version},original);
      assert.equal((await request(`/api/projects/${p.id}/actions`,{stamp:p.stamp,action:{type:'message',cardId:c.id,text:'过期消息'}},'business')).statusCode,409);
      await db.initStore();current=await db.getProject(p.id);assert.equal(current.cards[0].messages.length,1);
      await db.mutateProject(p.id,next=>applyAction(next,{type:'editCard',cardId:c.id,title:c.title,fields:{...c.fields,flow:c.fields.flow+' 明确一项业务规则'},reason:'合成核对'},'pm'),current.stamp);
      current=await db.getProject(p.id);assert.equal(current.cards[0].messages.length,1);assert.equal((await db.pool.query('SELECT count(*) AS n FROM discussion_appends WHERE project_id=$1',[p.id])).rows[0].n,'0');assert.equal((await db.messagePage(p.id,c.id,undefined,40)).messages.length,1);
    });

    await t.test('并发发言按卡片修订追加，消息幂等重试，正文更新仍拒绝过期发送',async()=>{
      const p=readyProject('并发幂等讨论'),c=p.cards[0];await db.insertProject(p);
      const headers={host:'127.0.0.1',origin:'http://127.0.0.1',cookie:cookies.business,prefer:'return=minimal'},messages=Array.from({length:12},(_,i)=>({type:'message',cardId:c.id,text:`并发发言 ${i}`,baseRevision:c.revision,baseRound:c.round,clientMessageId:randomUUID()}));
      const post=(action:object)=>app!.inject({method:'POST',url:`/api/projects/${p.id}/actions`,headers,payload:{stamp:p.stamp,action}});
      const responses=await Promise.all(messages.map(post));assert.ok(responses.every(r=>r.statusCode===204));assert.equal((await post(messages[0])).statusCode,204);assert.equal((await db.getProject(p.id)).cards[0].messages.length,12);
      assert.equal((await post({...messages[0],text:'重复标识但改动内容'})).statusCode,409);
      await db.mutateProject(p.id,next=>applyAction(next,{type:'editCard',cardId:c.id,title:c.title,fields:{...c.fields,quality:c.fields.quality+' 检查新规则'},reason:'合成修订'},'pm'));
      assert.equal((await post(messages[0])).statusCode,204);assert.equal((await post({...messages[1],clientMessageId:randomUUID()})).statusCode,409);assert.equal((await db.getProject(p.id)).cards[0].messages.length,12);
    });

    await t.test('多轮队列持久化：短答结束、深入评估撤回、重开后重新答复',async()=>{
      const {discussionReplayProject}=await import('./fixtures/discussion-replay');
      const {createDiscussionQueue}=await import('../server/discussion-jobs');
      const {validateDiscussion}=await import('../server/discussion');
      const {latestHumanMessage,waitingQuestion}=await import('../shared/discussion');
      const {p,c}=discussionReplayProject('隔离多轮生命周期');await db.insertProject(p);
      const queue=createDiscussionQueue({enabled:true,delayMs:1,analyze:async card=>{
        const last=latestHumanMessage(card)!;
        return validateDiscussion(last.text.includes('撤回')?{handling:{mode:'deep',trigger:'explicit',reason:'评估撤回的影响'},answer:null,question:null,summarize:false}:card.followUps?.length?{handling:{mode:'quiet',trigger:'none',reason:''},answer:null,question:null,summarize:false}:{answer:null,question:{field:'scope',question:'本期是否纳入购买平台占位按钮？',options:['本期纳入','本期不纳入'],role:'pm',participantId:'pm'},summarize:false},card);
      },evaluate:async(_p,card)=>{
        const last=latestHumanMessage(card)!;
        return {report:{conclusion:'原答复已撤回，重新等待产品决定。',perspectives:[],alternatives:[],evidence:[],unresolved:[],coverage:'当前讨论。'},discussion:{reopenQuestion:{questionId:card.followUps![0].id,messageId:last.id,quote:last.text},answer:null,question:null,summarize:false}};
      }});
      try{
        const turn=async(text:string,role:'pm'|'business',replyTo?:string)=>{
          await db.mutateProject(p.id,next=>applyAction(next,{type:'message',cardId:c.id,text,...(replyTo?{replyTo}:{})},role));
          const job=await queue.enqueue(p.id,c.id);assert.ok(job);assert.equal((await waitJob(p.id,job.id)).status,'succeeded');return (await db.getProject(p.id)).cards[0];
        };
        let card=await turn('@Agent 想加购买平台按钮','business');const id=waitingQuestion(card)!.id;
        card=await turn('@Agent 不要加入','pm');assert.equal(card.followUps![0].status,'answered');const old=card.followUps![0].answerMessageId;
        card=await turn('@Agent 我撤回刚才不加入的决定，暂时没想好','pm',id);assert.equal(waitingQuestion(card)?.id,id);assert.equal(card.followUps![0].answerHistory?.[0].messageId,old);
        card=await turn('@Agent 第一个','pm');assert.equal(waitingQuestion(card),undefined);assert.equal(card.followUps![0].status,'answered');assert.notEqual(card.followUps![0].answerMessageId,old);assert.deepEqual(card.fields,c.fields);assert.deepEqual(card.approvals,{});
      }finally{queue.close();}
    });

    await t.test('Demo 任务去重、失败保留旧版、过期结果丢弃且不代替确认',async()=>{
      const {createDemoQueue}=await import('../server/demo-jobs.ts');
      const {validateDemoProposal,demoBasisKey}=await import('../server/demo-schema.ts');
      const {artifactDir,demoView,generatedDemoZip}=await import('../server/demo-builder.ts');
      const {writeFile}=await import('node:fs/promises');
      const p=readyProject('通用 Demo 队列测试');await db.insertProject(p);const original=structuredClone(p.cards);
      const code=(project:Project)=>validateDemoProposal({summary:'生成可交互应用',files:[{path:'src/App.tsx',content:'export default function App(){return <button>提交</button>}'},{path:'src/styles.css',content:'body{color:blue}'}],deletePaths:[],bindings:[{cardId:project.cards[0].id,testId:'submit',field:'flow'}],checks:[{name:'提交产生结果',cardIds:[project.cards[0].id],steps:[{action:'click',testId:'submit'},{action:'expectText',testId:'result',value:'完成'}]}],assumptions:[]},project);
      const build=async(projectId:string,artifactId:string,files:Record<string,string>)=>{const dir=artifactDir(projectId,artifactId);await mkdir(path.join(dir,'output'),{recursive:true});await writeFile(path.join(dir,'sources.json'),JSON.stringify(files));await writeFile(path.join(dir,'output/index.html'),'<html><body><button>提交</button></body></html>');return {build:true,checks:[{name:'提交产生结果',passed:true}],errors:[]};};
      const queue=createDemoQueue({enabled:true,generate:async project=>code(project),build});
      try{const job=await queue.enqueue(p.id);assert.equal((await queue.enqueue(p.id))?.id,job!.id);assert.equal((await waitJob(p.id,job!.id)).status,'succeeded');}finally{queue.close();}
      let current=await db.getProject(p.id);assert.deepEqual(current.cards,original);assert.equal(current.generatedDemo!.revisions.length,1);assert.equal((await demoView(current)).stale,false);assert.ok((await generatedDemoZip(current)).length>0);
      const html=await app!.inject({url:`/api/projects/${p.id}/demo`,headers:{host:'127.0.0.1'}});assert.match(String(html.headers['content-security-policy']),/sandbox allow-scripts/);
      const view=await app!.inject({url:`/api/projects/${p.id}/demo/view`,headers:{host:'127.0.0.1'}});assert.equal(view.json().revision.sourceHash,current.generatedDemo!.revisions[0].sourceHash);
      const metadata=await app!.inject({url:`/api/projects/${p.id}/demo/view?metadata=1`,headers:{host:'127.0.0.1'}});assert.equal(metadata.json().html,'');const artifact=await app!.inject({url:metadata.json().url,headers:{host:'127.0.0.1'}});assert.equal(artifact.statusCode,200);assert.match(String(artifact.headers['cache-control']),/private.*immutable/);assert.equal(artifact.headers['x-frame-options'],undefined);assert.equal((await app!.inject({url:metadata.json().url,headers:{host:'127.0.0.1','if-none-match':artifact.headers.etag!}})).statusCode,304);assert.equal((await app!.inject({url:`/api/projects/${p.id}/demo/artifacts/foreign/index.html`,headers:{host:'127.0.0.1'}})).statusCode,404);
      const stableId=current.generatedDemo!.currentId;
      const failed=createDemoQueue({enabled:true,generate:async project=>code(project),build:async()=>{throw new Error('交互没有产生预期结果');}});
      try{const job=await failed.enqueue(p.id,undefined,true);assert.equal((await waitJob(p.id,job!.id)).status,'failed');assert.equal((await db.getProject(p.id)).generatedDemo!.currentId,stableId);}finally{failed.close();}
      let release!:()=>void,entered!:()=>void,calls=0;const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
      const changed=createDemoQueue({enabled:true,generate:async project=>{if(++calls===1){entered();await gate;}return code(project);},build});
      try{
        const job=await changed.enqueue(p.id,undefined,true);await started;
        await db.mutateProject(p.id,next=>applyAction(next,{type:'editCard',cardId:next.cards[0].id,title:next.cards[0].title,fields:{...next.cards[0].fields,flow:next.cards[0].fields.flow+' 可撤回提交。'},reason:'验收变更'},'pm'));release();
        assert.equal((await waitJob(p.id,job!.id)).status,'failed');
        for(let i=0;i<100;i++){current=await db.getProject(p.id);if(current.generatedDemo!.currentId!==stableId)break;await new Promise(r=>setTimeout(r,30));}
        assert.equal(current.generatedDemo!.revisions.length,2);assert.equal(current.generatedDemo!.revisions.at(-1)!.basisKey,demoBasisKey(current));assert.equal(current.cards[0].approvals.business,undefined);
        applyAction(current,{type:'editCard',cardId:current.cards[0].id,title:current.cards[0].title,fields:{...current.cards[0].fields,flow:'新的未同步规则'},reason:'验收'},'pm');assert.equal((await demoView(current)).stale,true);await assert.rejects(()=>generatedDemoZip(current),/尚未同步/);
      }finally{changed.close();}
      // The same effective proposal can be adopted while its code is building.
      // Metadata changes must not cancel the build or bypass business approval.
      let resume!:()=>void,notify!:()=>void;const hold=new Promise<void>(r=>{resume=r;}),began=new Promise<void>(r=>{notify=r;});let generated=0;
      await db.mutateProject(p.id,next=>{const c=next.cards[0];attachSuggestion(next,c.id,{summary:'补充保存结果',issues:[],changes:[{field:'flow',before:c.fields.flow,after:c.fields.flow+' 保存后显示记录编号。',reason:'明确反馈',evidence:[]}]},c.revision,c.messages.length);});
      const adoptedWhileBuilding=createDemoQueue({enabled:true,generate:async project=>{generated++;notify();await hold;return code(project);},build});
      try{
        const job=await adoptedWhileBuilding.enqueue(p.id,undefined,true);await began;
        await db.mutateProject(p.id,next=>{const c=next.cards[0];applyAction(next,{type:'applySuggestion',cardId:c.id,suggestionId:c.suggestion!.id,decisions:{flow:'采纳'}},'pm');});resume();
        assert.equal((await waitJob(p.id,job!.id)).status,'succeeded');assert.equal(generated,1);
        const after=await db.getProject(p.id),latest=after.generatedDemo!.revisions.at(-1)!;
        assert.equal(latest.draft,false);assert.equal(latest.basisKey,demoBasisKey(after));assert.equal(after.cards[0].approvals.business,undefined);
      }finally{adoptedWhileBuilding.close();}
    });

    await t.test('@Agent 队列合并连续提问、丢弃旧分析，回答后只生成待采纳建议',async()=>{
      const {createDiscussionQueue}=await import('../server/discussion-jobs.ts');
      const p=readyProject('自动追问 API 测试'),c=p.cards[0];
      applyAction(p,{type:'message',cardId:c.id,text:'@Agent 交接后原负责人访问规则仍有不确定的地方。'},'pm');await db.insertProject(p);
      let release!:()=>void,started!:()=>void,calls=0;
      const gate=new Promise<void>(resolve=>{release=resolve;}),entered=new Promise<void>(resolve=>{started=resolve;});
      const queue=createDiscussionQueue({enabled:true,delayMs:1,analyze:async card=>{
        calls++;const last=card.messages.at(-1)!;
        if(calls===1){started();await gate;}
        const pending=card.followUps?.find(q=>q.status==='waiting');
        if(pending)return {answer:{questionId:pending.id,messageId:last.id,quote:last.text},question:null,summarize:true};
        return {answer:null,question:{field:'permission',question:calls===1?'这条旧问题必须被丢弃，是否需要保留权限？':'本期交接后，原负责人是否立即撤销所有访问权限？',role:'business',options:['交接后立即撤权','保留30天只读']},summarize:false};
      },suggest:async card=>({summary:'按最新讨论形成权限建议，待产品采纳。',issues:[],changes:[{field:'permission',before:card.fields.permission,after:'原负责人立即撤销访问权限，包括旧链接。',reason:'业务回答',evidence:[{messageId:card.messages.at(-1)!.id,quote:card.messages.at(-1)!.text}]}]})});
      try{
        const job=await queue.enqueue(p.id,c.id);await entered;
        await db.mutateProject(p.id,current=>applyAction(current,{type:'message',cardId:c.id,text:'@Agent 再补充：旧链接能否继续访问，也一起明确。'},'reviewer'));
        assert.equal((await queue.enqueue(p.id,c.id))?.id,job!.id);release();
        assert.equal((await waitJob(p.id,job!.id)).status,'succeeded');
        let current=await db.getProject(p.id);assert.equal(current.cards[0].followUps?.length,1);assert.doesNotMatch(current.cards[0].followUps![0].question,/旧问题/);assert.equal(calls,2);
        const question=current.cards[0].followUps![0];
        const response=await act(current,{type:'message',cardId:c.id,text:'@Agent 交接后立即撤权，旧链接也不能继续访问。',replyTo:question.id},'business');assert.equal(response.statusCode,200);
        const second=await queue.enqueue(p.id,c.id);assert.equal((await waitJob(p.id,second!.id)).status,'succeeded');
        current=await db.getProject(p.id);assert.equal(current.cards[0].followUps![0].status,'answered');assert.equal(current.cards[0].suggestion?.status,'待决定');assert.deepEqual(current.cards[0].fields,c.fields);assert.deepEqual(current.cards[0].approvals,{});assert.equal(current.phase,p.phase);assert.equal(await queue.enqueue(p.id,c.id),undefined);
      }finally{release();queue.close();}
    });

    await t.test('普通短答只入群，带 @Agent 的短答可结束原追问',async()=>{
      const {createDiscussionQueue}=await import('../server/discussion-jobs'),{attachDiscussion}=await import('../server/discussion'),{discussionBasis,waitingQuestion}=await import('../shared/discussion');
      for(const text of ['不要加入','@Agent 不要加入']){
       const p=readyProject('否定短答 '+text),c=p.cards[0];applyAction(p,{type:'message',cardId:c.id,text:'能不能增加购买平台按钮？'},'business','business-operations');
       attachDiscussion(p,c.id,{answer:null,question:{field:'scope',question:'本期是否纳入购买平台占位按钮？',options:['本期纳入占位按钮','本期不纳入，暂不添加该按钮'],role:'pm',participantId:'pm'},summarize:false},discussionBasis(p,c));const questionId=waitingQuestion(c)!.id;
       applyAction(p,{type:'message',cardId:c.id,text},'pm','pm');const answerId=c.messages.at(-1)!.id;await db.insertProject(p);let calls=0;
       const queue=createDiscussionQueue({enabled:true,delayMs:1,analyze:async()=>{calls++;return {handling:{mode:'quiet',trigger:'none',reason:''},answer:null,question:null,summarize:false};}});
       try{const job=await queue.enqueue(p.id,c.id);
        if(text==='不要加入'){
         assert.equal(job,undefined);assert.equal((await db.listJobs(p.id)).length,0);assert.equal(calls,0);
         assert.equal(waitingQuestion((await db.getProject(p.id)).cards[0])?.id,questionId);continue;
        }
        assert.ok(job);assert.equal((await waitJob(p.id,job.id)).status,'succeeded');const after=(await db.getProject(p.id)).cards[0];const q=after.followUps!.find(q=>q.id===questionId)!;assert.equal(q.status,'answered');assert.equal(q.answerMessageId,answerId);assert.equal(waitingQuestion(after),undefined);assert.match(after.messages.at(-1)!.text,/不纳入/);assert.deepEqual(after.fields,c.fields);assert.deepEqual(after.approvals,c.approvals);assert.equal(calls,1);
       }finally{queue.close();}
      }
    });

    await t.test('讨论校验失败不泄露内部诊断，显式重试后恢复正式追问',async()=>{
      const {createDiscussionQueue}=await import('../server/discussion-jobs'),{SafeAIError}=await import('../server/ai');
      const p=readyProject('追问失败友好提示'),c=p.cards[0];applyAction(p,{type:'message',cardId:c.id,text:'@Agent 能不能加一个购买平台的按钮'},'business','business-operations');await db.insertProject(p);let calls=0;
      const queue=createDiscussionQueue({enabled:true,delayMs:1,analyze:async()=>{if(++calls===1)throw new SafeAIError('需要真人回答时必须生成对象一致的正式追问，不能只在文字中点名。');return {replyRequest:{participantId:'business-operations',purpose:'usage'},answer:null,question:{field:'flow',question:'购买平台按钮点击后希望做什么？',options:['跳转购买网站','记录平台名称'],role:'business',participantId:'business-operations'},summarize:false};}});
      try{const first=await queue.enqueue(p.id,c.id);const failed=await waitJob(p.id,first!.id);assert.equal(failed.status,'failed');assert.match(failed.error!,/讨论内容已保留/);assert.doesNotMatch(failed.error!,/对象一致|校验|replyRequest/);
       const retry=await queue.enqueue(p.id,c.id,true);assert.equal((await waitJob(p.id,retry!.id)).status,'succeeded');const updated=(await db.getProject(p.id)).cards[0];assert.equal(updated.followUps?.at(-1)?.participantId,'business-operations');assert.deepEqual(updated.fields,c.fields);assert.equal(calls,2);
      }finally{queue.close();}
    });

    await t.test('已读讨论后建议失败仍可显式重试，正常监听不会重复分析',async()=>{
      const {createDiscussionQueue}=await import('../server/discussion-jobs'),{SafeAIError}=await import('../server/ai');
      const p=readyProject('失败讨论重试'),c=p.cards[0];applyAction(p,{type:'message',cardId:c.id,text:'@Agent 交接时需要把权限变化提示得更明确。'},'business');await db.insertProject(p);let calls=0;
      const queue=createDiscussionQueue({enabled:true,delayMs:1,analyze:async()=>({answer:null,question:null,summarize:true}),suggest:async card=>{if(++calls===1)throw new SafeAIError('合成字段依赖结构错误');return {summary:'合成重试成功',issues:[],changes:[{field:'quality',before:card.fields.quality,after:card.fields.quality+' 合成调整',reason:'合成',evidence:[]}]};}});
      try{const first=await queue.enqueue(p.id,c.id);assert.equal((await waitJob(p.id,first!.id)).status,'failed');assert.equal((await db.getProject(p.id)).cards[0].assistantCursor,c.messages.at(-1)!.id);assert.equal(await queue.enqueue(p.id,c.id),undefined);const second=await queue.enqueue(p.id,c.id,true);assert.ok(second);assert.equal((await waitJob(p.id,second.id)).status,'succeeded');assert.equal(calls,2);const after=await db.getProject(p.id);assert.equal(after.cards[0].suggestion?.status,'待决定');assert.deepEqual(after.cards[0].fields,c.fields);}finally{queue.close();}
    });

    await t.test('轻量回应不调用专家评估，深评先保存卡片并丢弃并发旧结果',async()=>{
      const {createDiscussionQueue}=await import('../server/discussion-jobs');
      const p=readyProject('直接与深评'),c=p.cards[0];applyAction(p,{type:'message',cardId:c.id,text:'@Agent 请解释当前交接规则的含义。'},'business');await db.insertProject(p);
      let evaluations=0;
      const light=createDiscussionQueue({enabled:true,delayMs:1,analyze:async()=>({handling:{mode:'direct',trigger:'none',reason:''},reply:'交接规则用于说明负责人变化后的访问权限。',answer:null,question:null,summarize:false}),evaluate:async()=>{evaluations++;throw Error('简单回复不得深评');}});
      try{const job=await light.enqueue(p.id,c.id);assert.equal((await waitJob(p.id,job!.id)).status,'succeeded');assert.equal(evaluations,0);assert.equal((await db.getProject(p.id)).cards[0].assessments,undefined);}finally{light.close();}
      await db.mutateProject(p.id,next=>applyAction(next,{type:'message',cardId:c.id,text:'@Agent 交接后继续访问与立即撤权有冲突，需要评估。'},'business'));
      let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>{release=r;}),started=new Promise<void>(r=>{entered=r;});
      const queue=createDiscussionQueue({enabled:true,delayMs:1,classifyInterruption:async()=> 'related',analyze:async()=>({handling:{mode:'deep',trigger:'conflict',reason:'交接与访问规则相互冲突'},answer:null,question:null,summarize:false}),evaluate:async(_p,card)=>{
        evaluations++;if(evaluations===1){entered();await gate;}
        return {report:{conclusion:evaluations===1?'这条旧结果不应写入':'已结合新讨论，建议明确旧链接的范围。',perspectives:[],alternatives:[],evidence:[],unresolved:[],coverage:'当前需求和提供的讨论。'},discussion:{answer:null,question:null,summarize:false}};
      }});
      try{
        const job=await queue.enqueue(p.id,c.id);await started;
        const during=await db.getProject(p.id);assert.equal(during.cards[0].assessments?.[0].status,'running');assert.equal(during.cards[0].assessments?.[0].report,undefined);assert.deepEqual(during.cards[0].fields,c.fields);
        await db.mutateProject(p.id,next=>applyAction(next,{type:'message',cardId:c.id,text:'@Agent 还要把旧链接的有效期纳入一起评估。'},'business'));release();
        assert.equal((await waitJob(p.id,job!.id)).status,'succeeded');
        const after=await db.getProject(p.id),assessments=after.cards[0].assessments!;assert.equal(evaluations,2);assert.equal(assessments.length,1);assert.equal(assessments[0].id,job!.id);assert.equal(assessments[0].status,'completed');assert.doesNotMatch(JSON.stringify(assessments),/旧结果不应/);assert.deepEqual(after.cards[0].approvals,{});
      }finally{release();queue.close();}
    });

    await t.test('闲聊不重跑评估，明确取消不落报告；分类期间的新业务消息仍使旧结果失效',async()=>{
      const {createDiscussionQueue}=await import('../server/discussion-jobs');
      for(const mode of ['irrelevant','cancel','race'] as const){
        const p=readyProject(`评估中断-${mode}`),c=p.cards[0];
        applyAction(p,{type:'message',cardId:c.id,text:'@Agent 请评估交接后的访问权限。'},'business');await db.insertProject(p);
        let release!:()=>void,enter!:()=>void,evaluations=0,checks=0;
        const gate=new Promise<void>(r=>{release=r;}),started=new Promise<void>(r=>{enter=r;});
        const queue=createDiscussionQueue({enabled:true,delayMs:1,
          analyze:async()=>({handling:{mode:'deep',trigger:'explicit',reason:'评估访问权限'},answer:null,question:null,summarize:false}),
          evaluate:async()=>{evaluations++;if(evaluations===1){enter();await gate;}return {report:{conclusion:evaluations===1?'原评估结论':'已结合业务变化',perspectives:[],alternatives:[],evidence:[],unresolved:[],coverage:'当前讨论'},discussion:{answer:null,question:null,summarize:false}};},
          classifyInterruption:async(_p,_c,_reason,messages)=>{
            checks++;
            if(mode==='race'&&checks===1)await db.mutateProject(p.id,next=>applyAction(next,{type:'message',cardId:c.id,text:'@Agent 业务补充：旧链接必须立即失效。'},'business'));
            return mode==='cancel'?'cancel':messages.some(m=>m.text.includes('业务补充'))?'related':'irrelevant';
          },
        });
        try{
          const job=await queue.enqueue(p.id,c.id);await started;
          await db.mutateProject(p.id,next=>applyAction(next,{type:'message',cardId:c.id,text:mode==='cancel'?'@Agent 取消本次评估':mode==='race'?'@Agent 评估做到哪一步？':'今天天气怎么样，晚上吃点啥？'},'business'));
          release();assert.equal((await waitJob(p.id,job!.id)).status,'succeeded');
          const current=(await db.getProject(p.id)).cards[0],assessment=current.assessments![0];
          assert.equal(current.assessments!.length,1);assert.equal(evaluations,mode==='race'?2:1);
          assert.equal(assessment.status,mode==='cancel'?'cancelled':'completed');
          assert.equal(assessment.report?.conclusion,mode==='cancel'?undefined:mode==='race'?'已结合业务变化':'原评估结论');
          if(mode==='irrelevant')assert.equal(assessment.sourceMessageId,c.messages.at(-1)!.id);
          assert.deepEqual(current.fields,c.fields);assert.deepEqual(current.approvals,c.approvals);
          assert.equal(await queue.enqueue(p.id,c.id),undefined);
          if(mode==='cancel'){
            const resumed=await queue.resume(p.id,c.id,assessment.id);
            assert.equal((await waitJob(p.id,resumed!.id)).status,'succeeded');
            const restored=(await db.getProject(p.id)).cards[0].assessments!.at(-1)!;
            assert.equal(restored.status,'completed');assert.equal(restored.sourceMessageId,c.messages.at(-1)!.id);
          }
        }finally{release();queue.close();}
      }
    });

    await t.test('专家评估失败可重试，重启恢复未完成卡片',async()=>{
      const {createDiscussionQueue}=await import('../server/discussion-jobs'),{SafeAIError}=await import('../server/ai');
      const {beginAssessment,assessmentBasis}=await import('../server/requirement-assessment');
      const p=readyProject('评估失败重试'),c=p.cards[0];applyAction(p,{type:'message',cardId:c.id,text:'@Agent 请多角度评估权限与流程的影响。'},'business');await db.insertProject(p);let calls=0;
      const queue=createDiscussionQueue({enabled:true,delayMs:1,analyze:async()=>({handling:{mode:'deep',trigger:'explicit',reason:'用户要求多角度评估权限与流程'},answer:null,question:null,summarize:false}),evaluate:async()=>{
        if(++calls===1)throw new SafeAIError('评估服务暂不可用');
        return {report:{conclusion:'目前没有发现新的规则冲突。',perspectives:[],alternatives:[],evidence:[],unresolved:[],coverage:'仅参考提供的需求与讨论。'},discussion:{answer:null,question:null,summarize:false}};
      }});
      try{
        const first=await queue.enqueue(p.id,c.id);assert.equal((await waitJob(p.id,first!.id)).status,'failed');assert.equal((await db.getProject(p.id)).cards[0].assessments![0].status,'failed');
        const second=await queue.enqueue(p.id,c.id,true);assert.equal((await waitJob(p.id,second!.id)).status,'succeeded');assert.equal(calls,2);
        await db.mutateProject(p.id,next=>{const card=next.cards[0];beginAssessment(next,card,'interrupted','模拟中断评估',assessmentBasis(next,card));});
        await db.initStore();const after=await db.getProject(p.id);assert.equal(after.cards[0].assessments!.find(a=>a.id==='interrupted')!.status,'failed');assert.deepEqual(after.cards[0].fields,c.fields);
      }finally{queue.close();}
    });

    await t.test('@Agent 与普通聊天共用深评链，追问只存一份',async()=>{
      const {createDiscussionQueue}=await import('../server/discussion-jobs');
      const p=readyProject('直接请求专家'),c=p.cards[0];applyAction(p,{type:'message',cardId:c.id,text:'@Agent 请从多个视角评估权限冲突。'},'business');await db.insertProject(p);
      const queue=createDiscussionQueue({enabled:true,delayMs:1,route:async()=>{throw Error('无附件不得绕过讨论生命周期');},analyze:async()=>({handling:{mode:'deep',trigger:'explicit',reason:'用户明确要求检查权限冲突'},answer:null,question:null,summarize:false}),evaluate:async()=>({report:{conclusion:'建议明确交接后的权限边界。',perspectives:[],alternatives:[],evidence:[],unresolved:['旧链接权限'],coverage:'当前卡片。'},discussion:{answer:null,question:{field:'permission',question:'交接后旧链接是否立即失效？',role:'business',options:['立即失效','保留只读']},summarize:false}})});
      try{const job=await queue.enqueue(p.id,c.id);assert.equal((await waitJob(p.id,job!.id)).status,'succeeded');const card=(await db.getProject(p.id)).cards[0];assert.equal(card.assessments?.length,1);assert.equal(card.followUps?.length,1);assert.equal(card.assessments![0].questionId,card.followUps![0].id);assert.equal(card.assessments![0].sourceMessageId,c.messages.at(-1)!.id);assert.equal(card.assessments![0].report?.conclusion,'建议明确交接后的权限边界。');}finally{queue.close();}
    });

    await t.test('复杂附件评估后仍处理独立需求草稿，普通定向问题复用等待机制',async()=>{
      const {createDiscussionQueue}=await import('../server/discussion-jobs');
      const {appendMaterialMessage}=await import('../server/chat-messages');
      const {textMaterial}=await import('../server/materials');
      const p=readyProject('复杂附件保留草稿'),c=p.cards[0],material=textMaterial('附件独立需求','需要发送站内提醒。');
      appendMaterialMessage(p,c.id,'business',{text:'@Agent 请评估附件里的独立提醒需求与当前规则的关系。',clientMessageId:'assessment-material'},[material]);await db.insertProject(p);let routes=0;
      const queue=createDiscussionQueue({enabled:true,delayMs:1,route:async(_p,_c,materials,_ids,_warnings,assessed)=>{
        routes++;if(!assessed)return {handling:{mode:'deep',trigger:'coupled_rules',reason:'附件需求与现有流程关联'},reply:'',clarifiesCurrent:false,evidence:[],relatedCardIds:[],cards:[]};
        return {reply:'附件中的独立需求已形成草稿。',clarifiesCurrent:false,evidence:[],relatedCardIds:[],cards:[{key:'notice',title:'独立提醒',granularity:'具体',origin:'材料要求',rationale:'附件明确提出独立提醒',coverageGaps:[],fields:{...c.fields,goal:'需要发送站内提醒。'},sourceIds:[materials[0].id],assessment:'待澄清',issues:[],evidence:{goal:[{materialId:materials[0].id,quote:'需要发送站内提醒。'}]}}]};
      },evaluate:async()=>({report:{conclusion:'提醒可作为独立需求继续核对。',perspectives:[],alternatives:[],evidence:[],unresolved:[],coverage:'附件与当前卡片。'},discussion:{answer:null,question:null,summarize:false}})});
      try{const job=await queue.enqueue(p.id,c.id);assert.equal((await waitJob(p.id,job!.id)).status,'succeeded');const current=await db.getProject(p.id);assert.equal(routes,2);assert.equal(current.intakeBatches?.at(-1)?.drafts[0].title,'独立提醒');assert.ok(current.cards[0].assessments![0].materialReply?.intakeBatchId);assert.deepEqual(current.cards[0].fields,c.fields);}finally{queue.close();}
      const q=readyProject('直接定向问题'),qc=q.cards[0];applyAction(q,{type:'message',cardId:qc.id,text:'@Agent 当前权限只有一个地方需要业务补充。'},'business');await db.insertProject(q);
      const direct=createDiscussionQueue({enabled:true,delayMs:1,analyze:async()=>({reply:'只需补充一个权限边界。',answer:null,summarize:false,question:{field:'permission',question:'交接后旧链接是否立即失效？',role:'business',options:['立即失效','保留只读']}}),evaluate:async()=>{throw Error('单一缺口不得深评');}});
      try{const job=await direct.enqueue(q.id,qc.id);assert.equal((await waitJob(q.id,job!.id)).status,'succeeded');const after=(await db.getProject(q.id)).cards[0];assert.equal(after.followUps?.length,1);assert.equal(after.assessments,undefined);}finally{direct.close();}
    });

    await t.test('讨论流式进度发布任务状态，校验完成前不写入半成品建议',async()=>{
      const {createDiscussionQueue}=await import('../server/discussion-jobs');
      const p=readyProject('讨论进度'),c=p.cards[0];applyAction(p,{type:'message',cardId:c.id,text:'@Agent 请按讨论整理需求修改建议。'},'business');await db.insertProject(p);
      let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>{release=r;}),started=new Promise<void>(r=>{entered=r;});
      const queue=createDiscussionQueue({enabled:true,delayMs:1,suggest:async(card,_materials,_cards,progress)=>{await progress?.('正在整理需求建议 · 已接收 120 字');entered();await gate;return {summary:'合成待采纳建议',issues:[],changes:[{field:'quality',before:card.fields.quality,after:card.fields.quality+' 合成调整',reason:'合成',evidence:[]}]};}});
      try{const job=await queue.enqueue(p.id,c.id);await started;assert.equal((await db.listJobs(p.id)).find(j=>j.id===job!.id)!.label,'正在整理需求建议 · 已接收 120 字');const during=await db.getProject(p.id);assert.equal(during.cards[0].suggestion,undefined);assert.deepEqual(during.cards[0].fields,c.fields);release();assert.equal((await waitJob(p.id,job!.id)).status,'succeeded');assert.equal((await db.getProject(p.id)).cards[0].suggestion?.status,'待决定');}finally{release();queue.close();}
    });

    await t.test('聊天置顶按身份隔离，模块操作校验身份与并发版本',async()=>{
      const p=readyProject('聊天组织 API 测试');p.cards[0].organization={module:'客户',priority:'正常沟通',reason:'API验收'};await db.insertProject(p);
      let result=await act(p,{type:'pinChat',cardId:p.cards[0].id,pinned:true},'business');assert.equal(result.statusCode,200);
      let current=result.json<Project>();assert.deepEqual(current.chatPins?.business,[p.cards[0].id]);assert.equal(current.chatPins?.pm,undefined);assert.deepEqual(current.cards,p.cards);
      assert.equal((await act(p,{type:'pinChat',cardId:p.cards[0].id,pinned:false},'business')).statusCode,409);
      assert.equal((await act(current,{type:'renameModule',from:'客户',to:'客户管理'},'business')).statusCode,400);
      assert.equal((await request(`/api/projects/${p.id}/group`,{},'business')).statusCode,403);
      assert.equal((await request(`/api/projects/${p.id}/group`,{},'business')).statusCode,403);
      result=await act(current,{type:'renameModule',from:'客户',to:'客户管理'});assert.equal(result.statusCode,200);current=result.json<Project>();
      assert.equal(current.cards[0].organization?.module,'客户管理');assert.equal(current.cards[0].revision,1);
      result=await act(current,{type:'setPoolGrouping',mode:'flat'});assert.equal(result.statusCode,200);assert.equal(result.json<Project>().poolGrouping,'flat');
    });

    await t.test('CRM 体验创建及 Word、Markdown、Demo 导出具有权限与版本校验', async () => {
      assert.equal((await request('/api/examples/crm', {}, 'business')).statusCode, 403);
      const made = await request('/api/examples/crm', {});
      assert.equal(made.statusCode, 200); const project = made.json<Project>();
      assert.equal(project.cards.length, 3);
      for (const format of ['docx','md','demo']) {
        const result = await app!.inject({method:'GET',url:`/api/projects/${project.id}/exports/${format}?stamp=${project.stamp}&cardId=${project.cards[0].id}`,headers:{cookie:cookies.business}});
        assert.equal(result.statusCode,200);assert.ok(result.headers['content-disposition']);assert.ok(result.rawPayload.length>100);
        assert.match(String(result.headers['content-type']),format==='docx'?/wordprocessingml/:format==='md'?/markdown/:/zip/);
      }
      assert.equal((await app!.inject({method:'GET',url:`/api/projects/${project.id}/exports/md?stamp=${project.stamp+1}`})).statusCode,409);
      assert.equal((await app!.inject({method:'GET',url:`/api/projects/${project.id}/exports/invalid`})).statusCode,400);
      assert.equal((await app!.inject({method:'GET',url:`/api/projects/${project.id}/exports/demo?cardId=missing`})).statusCode,400);
      const preset=await request(`/api/projects/${project.id}/cards/${project.cards[0].id}/example-conclusion`,{stamp:project.stamp},'business');
      assert.equal(preset.statusCode,200);const proposed=preset.json<Project>();assert.equal(proposed.cards[0].suggestion?.origin,'example');assert.deepEqual(proposed.cards[0].approvals,{});
      assert.equal((await request(`/api/projects/${project.id}/cards/${project.cards[0].id}/example-conclusion`,{stamp:project.stamp})).statusCode,409);
      const saved=await act(proposed,{type:'adoptConclusion',cardId:proposed.cards[0].id,suggestionId:proposed.cards[0].suggestion!.id,decisions:{permission:'采纳',acceptance:'采纳'},resolvedBlockerIds:[proposed.cards[0].blockers[0].id]});
      assert.equal(saved.statusCode,200);assert.equal(saved.json<Project>().cards[0].approvals.pm?.result,'通过');assert.equal(saved.json<Project>().cards[0].approvals.business,undefined);

    });

    await t.test('过期 stamp 返回 409；并发提交仅一方生效', async () => {
      const project = await db.insertProject(readyProject('并发验证'));
      const action = {type: 'message', cardId: project.cards[0].id, text: '核对本期边界'};
      const responses = await Promise.all([act(project, action), act(project, {...action, text: '另一位成员的补充'})]);
      assert.deepEqual(responses.map(response => response.statusCode).sort(), [200, 409]);
      const persisted = await db.getProject(project.id);
      assert.equal(persisted.stamp, 1);
      assert.equal(persisted.cards[0].messages.length, 1);
    });

    await t.test('非法字段与角色越权均不改变数据库项目', async () => {
      const project = await db.insertProject(readyProject('权限与校验'));
      const before = await db.getProject(project.id);
      const invalid = await act(project, {type: 'editCard', cardId: project.cards[0].id, fields: {...completeFields, custom: '额外字段'}, title: '不应保存', reason: '非法字段'});
      assert.equal(invalid.statusCode, 400);
      const forbidden = await act(project, {type: 'pmConfirm', cardId: project.cards[0].id}, 'business');
      assert.ok([400, 403].includes(forbidden.statusCode));
      assert.match(forbidden.json().error, /权限/);
      assert.deepEqual(await db.getProject(project.id), before);
    });

    await t.test('沟通群后端执行解决权限与待决定建议确认门槛', async () => {
      const project = readyProject('沟通群确认验证'), card = project.cards[0];
      applyAction(project, {type: 'addBlocker', cardId: card.id, field: 'permission', reason: '权限范围需核对'}, 'reviewer');
      await db.insertProject(project);
      const rejectedResolve = await act(project, {type: 'resolveBlocker', cardId: card.id, blockerId: card.blockers[0].id, reason: '业务已经回答'}, 'business');
      assert.equal(rejectedResolve.statusCode, 400); assert.match(rejectedResolve.json().error, /产品经理/);
      assert.deepEqual(await db.getProject(project.id), project);
      const resolved = await act(project, {type: 'resolveBlocker', cardId: card.id, blockerId: card.blockers[0].id, reason: '产品核对业务回答与当前字段一致'}, 'pm');
      assert.equal(resolved.statusCode, 200);
      const confirmed = await act(resolved.json<Project>(), {type: 'pmConfirm', cardId: card.id}, 'pm');
      assert.equal(confirmed.statusCode, 200);
      await db.mutateProject(project.id, current => attachSuggestion(current, card.id, {summary: '待处理的规则建议', issues: [], changes: [{field: 'permission', before: card.fields.permission, after: '原负责人保留七天只读', reason: '业务提出修改', evidence: []}]}, card.revision, 0));
      const pending = await db.getProject(project.id);
      const blocked = await act(pending, {type: 'businessConfirm', cardId: card.id, result: '通过', comment: ''}, 'business');
      assert.equal(blocked.statusCode, 400); assert.match(blocked.json().error, /尚待决定/);
      assert.deepEqual(await db.getProject(project.id), pending);
      const returned = await act(pending, {type: 'businessConfirm', cardId: card.id, result: '要求修改', comment: '需要核对七天只读例外'}, 'business');
      assert.equal(returned.statusCode, 200); assert.deepEqual(returned.json<Project>().cards[0].approvals, {});
    });

    await t.test('字段采纳与问题解决通过 API 原子持久化；不选择不会自动关闭', async () => {
      for (const closeProblem of [false, true]) {
        const project = readyProject(`一起采纳验证 ${closeProblem}`), card = project.cards[0];
        applyAction(project, {type: 'addBlocker', cardId: card.id, field: 'permission', reason: '离职销售是否保留只读权限需澄清'}, 'reviewer');
        applyAction(project, {type: 'message', cardId: card.id, text: '业务确认离职销售同样立即撤权，不保留只读。'}, 'business');
        applyAction(project, {type: 'message', cardId: card.id, text: '评审确认离职销售立即撤权符合制度。'}, 'reviewer');
        const evidence = card.messages.map(message => ({messageId: message.id, quote: message.text}));
        attachSuggestion(project, card.id, {summary: '离职场景已讨论明确', issues: [], changes: [
          {field: 'permission', before: card.fields.permission, after: '在职和离职原负责人均立即撤权，新负责人有编辑权限', reason: '补充离职场景', evidence},
          {field: 'acceptance', before: card.fields.acceptance, after: '在职和离职原负责人均不能读写，新负责人可编辑', reason: '覆盖离职验收', evidence},
        ], problemResolutions: [{blockerId: card.blockers[0].id, resolution: '离职销售同样立即撤权，不保留只读', requiredFields: ['permission', 'acceptance'], requiredRoles: ['business', 'reviewer'], evidence}]}, card.revision, card.messages.length);
        await db.insertProject(project);
        const pending = await db.getProject(project.id);
        const baseAction = {type: 'applySuggestion', cardId: card.id, suggestionId: card.suggestion!.id, resolvedBlockerIds: [card.blockers[0].id]};
        const partial = await act(pending, {...baseAction, decisions: {permission: '采纳', acceptance: '不采纳'}});
        assert.equal(partial.statusCode, 400); assert.match(partial.json().error, /验收条件/);
        assert.deepEqual(await db.getProject(project.id), pending, '依赖不采纳时事务不能保存任何正文、问题或stamp变化');
        const wrongRole = await act(pending, {...baseAction, decisions: {permission: '采纳', acceptance: '采纳'}}, 'business');
        assert.equal(wrongRole.statusCode, 400); assert.match(wrongRole.json().error, /产品经理/);
        assert.deepEqual(await db.getProject(project.id), pending);
        const accepted = await act(pending, {...baseAction, resolvedBlockerIds: closeProblem ? [card.blockers[0].id] : [], decisions: {permission: '采纳', acceptance: '采纳'}});
        assert.equal(accepted.statusCode, 200, accepted.body);
        const persisted = await db.getProject(project.id), savedCard = persisted.cards[0], blocker = savedCard.blockers[0];
        assert.equal(persisted.stamp, pending.stamp + 1);
        assert.equal(savedCard.revision, 2);
        assert.equal(blocker.resolved, closeProblem);
        assert.deepEqual(savedCard.approvals, {});
        assert.equal(persisted.phase, '可讨论');
        if (closeProblem) {
          assert.equal(blocker.resolution, '离职销售同样立即撤权，不保留只读');
          assert.deepEqual(blocker.resolutionEvidence, evidence);
          assert.equal(blocker.resolvedBy, 'pm'); assert.ok(blocker.resolvedAt);
          assert.equal(blocker.resolutionSuggestionId, card.suggestion!.id);
        } else assert.equal(blocker.resolutionEvidence, undefined);
      }
    });

    await t.test('AI 建议接口在越权、非本期、冻结和运行中时先拒绝，不调用模型', async () => {
      const priorConfigured = config.modelConfigured;
      try {
        const unconfigured = await db.insertProject(readyProject('未配置模型验证'));
        config.modelConfigured = false;
        const unavailable = await request(`/api/projects/${unconfigured.id}/cards/${unconfigured.cards[0].id}/suggest`, {});
        assert.equal(unavailable.statusCode, 400); assert.match(unavailable.json().error, /配置模型服务/);
        config.modelConfigured = true; // This only opens the config gate; every test below must fail before queuing work.
        const excluded = readyProject('非本期建议验证');
        applyAction(excluded, {type: 'scope', cardId: excluded.cards[0].id, included: false, reason: '后续考虑'}, 'pm'); await db.insertProject(excluded);
        const noScope = await request(`/api/projects/${excluded.id}/cards/${excluded.cards[0].id}/suggest`, {});
        assert.equal(noScope.statusCode, 400); assert.match(noScope.json().error, /本期不纳入/); assert.equal((await db.listJobs(excluded.id)).length, 0);
        const frozen = readyProject('冻结建议验证'); confirmAndReview(frozen); beginDelivery(frozen, 'pm', 'local'); await db.insertProject(frozen);
        const wrongRole = await request(`/api/projects/${frozen.id}/cards/${frozen.cards[0].id}/suggest`, {}, 'business');
        assert.equal(wrongRole.statusCode, 400); assert.match(wrongRole.json().error, /冻结交付/);
        const locked = await request(`/api/projects/${frozen.id}/cards/${frozen.cards[0].id}/suggest`, {});
        assert.equal(locked.statusCode, 400); assert.match(locked.json().error, /冻结交付/); assert.equal((await db.listJobs(frozen.id)).length, 0);
        const running = await db.insertProject(readyProject('同卡建议并发验证'));
        await db.newJob(running.id, 'suggest', '已有运行任务', running.cards[0].id);
        const duplicate = await request(`/api/projects/${running.id}/cards/${running.cards[0].id}/suggest`, {});
        assert.equal(duplicate.statusCode, 400); assert.match(duplicate.json().error, /正在整理/); assert.equal((await db.listJobs(running.id)).length, 1);
      } finally { config.modelConfigured = priorConfigured; }
    });

    await t.test('API 拒绝未选择的 AI 字段，保存及刷新后保留人工决定，入池不产生审批',async()=>{
      const {decideAIField}=await import('../shared/intake-fields');
      const p=createProject('AI 字段 API 验收');
      const batch=attachIntakeBatch(p,[{key:'purchase',title:'采购查询',fields:{...completeFields},sourceIds:['crm-kickoff'],evidence:{},assessment:'可确认',issues:[],granularity:'具体',origin:'材料要求',rationale:'查询结果独立',coverageGaps:[],aiSupplements:{exception:{text:'失败时保留查询条件',reason:'材料尚未规定失败路径'},quality:{text:'两秒返回',reason:'待业务确认性能目标'}}}],['crm-kickoff']);
      await db.insertProject(p);
      const make=(project:Project,importSelected=true):Extract<Action,{type:'saveIntake'}>=>{const b=project.intakeBatches![0];return {type:'saveIntake',batchId:b.id,revision:b.revision,importSelected,drafts:b.drafts.map(({id,title,fields,selected,exclusionReason,coverageGaps,aiReviews})=>({id,title,fields,selected,exclusionReason,coverageGaps,aiReviews}))};};
      const blocked=await act(p,make(p),'pm');assert.equal(blocked.statusCode,400);assert.match(blocked.json().error,/AI 分析补充未处理/);assert.equal((await db.getProject(p.id)).cards.length,0);
      const a=make(p,false),draft=batch.drafts[0];a.drafts[0].aiReviews=decideAIField(draft,'exception','保留');a.drafts[0].aiReviews=decideAIField({...draft,aiReviews:a.drafts[0].aiReviews},'quality','删除');
      const denied=await act(p,a,'business');assert.equal(denied.statusCode,400);assert.match(denied.json().error,/权限/);assert.equal((await act(p,a,'pm')).statusCode,200);
      const saved=await db.getProject(p.id);assert.equal(saved.cards.length,0);assert.equal(saved.intakeBatches![0].drafts[0].aiReviews!.quality!.decision,'删除');
      assert.equal((await act(saved,make(saved),'pm')).statusCode,200);const imported=await db.getProject(p.id),c=imported.cards[0];
      assert.match(c.fields.exception,/失败时保留查询条件/);assert.equal(c.fields.quality,completeFields.quality);assert.deepEqual(c.approvals,{});assert.deepEqual(c.confirmations,[]);assert.equal(c.aiOrigins!.exception!.reviewedBy,'pm');
      const repeated=await act(imported,make(imported,false),'pm');assert.equal(repeated.statusCode,200,repeated.body);assert.equal((await db.getProject(p.id)).cards.length,1);
    });

    await t.test('材料草稿 API 保存、权限、版本保护与入池分离', async () => {
      const project = createProject('入池 API 验证');
      const base: IntakeCandidate = {key:'overview',title:'CRM 客户管理',fields:{...completeFields},sourceIds:['crm-kickoff'],assessment:'可确认',issues:[],evidence:{},granularity:'概要',origin:'材料要求',rationale:'多项业务成果',coverageGaps:[]};
      const batch = attachIntakeBatch(project,[base,{...base,key:'child',title:'单客户转交',granularity:'具体',parentKey:'overview'}],['crm-kickoff']);
      await db.insertProject(project);
      const draftAction = (current:Project, importSelected:boolean):Action => {const b=current.intakeBatches![0];return {type:'saveIntake',batchId:b.id,revision:b.revision,importSelected,drafts:b.drafts.map(({id,title,fields,selected,exclusionReason,coverageGaps})=>({id,title,fields,selected,exclusionReason,coverageGaps}))};};
      const forbidden=await act(project,draftAction(project,false),'business'); assert.equal(forbidden.statusCode,400);
      assert.deepEqual(await db.getProject(project.id),project);
      const saved=await act(project,draftAction(project,false));assert.equal(saved.statusCode,200,saved.body);
      const draft=saved.json<Project>();assert.equal(draft.cards.length,0);assert.equal(draft.intakeBatches![0].revision,2);
      const stale=await act(draft,draftAction(project,true));assert.equal(stale.statusCode,400);assert.deepEqual(await db.getProject(project.id),draft);
      const imported=await act(draft,draftAction(draft,true));assert.equal(imported.statusCode,200,imported.body);
      const formal=imported.json<Project>();assert.equal(formal.cards.length,2);assert.ok(formal.cards.every(card=>!card.approvals.pm&&!card.approvals.business));
      assert.equal(formal.cards.find(card=>card.granularity==='具体')!.parentId,formal.cards.find(card=>card.granularity==='概要')!.id);
      const repeated=await act(formal,draftAction(formal,true));assert.equal(repeated.statusCode,200);assert.equal(repeated.json<Project>().cards.length,2);
      const unknown=await request(`/api/projects/${project.id}/refine`,{batchId:'unknown',parentDraftId:batch.drafts[0].id,revision:1});assert.equal(unknown.statusCode,400);
      const current=await db.getProject(project.id),b=current.intakeBatches![0];
      const wrongRole=await request(`/api/projects/${project.id}/refine`,{batchId:b.id,parentDraftId:b.drafts[0].id,revision:b.revision},'business');assert.equal(wrongRole.statusCode,403);
      const concrete=await request(`/api/projects/${project.id}/refine`,{batchId:b.id,parentDraftId:b.drafts[1].id,revision:b.revision});assert.equal(concrete.statusCode,400);assert.match(concrete.json().error,/只有概要/);
      const oldRevision=await request(`/api/projects/${project.id}/refine`,{batchId:b.id,parentDraftId:b.drafts[0].id,revision:1});assert.equal(oldRevision.statusCode,409);
      assert.equal((await db.listJobs(project.id)).length,0);
      const upload=await request(`/api/projects/${project.id}/materials`,{name:'业务材料',kind:'会议纪要',text:'业务资料正文',location:''},'business');assert.equal(upload.statusCode,403);
    });

    await t.test('整体评审仅评审人员可通过；退回后不能无改动重送', async () => {
      const project = readyProject('整体评审验证');
      const cardId = project.cards[0].id;
      applyAction(project, {type: 'pmConfirm', cardId}, 'pm');
      applyAction(project, {type: 'businessConfirm', cardId, result: '通过', comment: ''}, 'business');
      applyAction(project, {type: 'submitReview'}, 'pm');
      await db.insertProject(project);
      const wrongRole = await act(project, {type: 'review', result: '通过', comment: ''}, 'pm');
      assert.ok([400, 403].includes(wrongRole.statusCode));
      const rejected = await act(project, {type: 'review', result: '要求修改', comment: '请补充跨部门边界'}, 'business');
      assert.equal(rejected.statusCode, 200);
      const returned = rejected.json<Project>();
      assert.equal(returned.phase, '可讨论');
      const resubmit = await act(returned, {type: 'submitReview'});
      assert.equal(resubmit.statusCode, 400);
      assert.match(resubmit.json().error, /被退回/);
      assert.equal((await db.getProject(project.id)).version.join('.'), '0.0.1');
    });

    await t.test('沟通群可由业务发送多份材料，重试幂等、格式与数量受限且不改正式需求',async()=>{
      const p=readyProject('沟通附件 API');await db.insertProject(p);const c=p.cards[0];
      const upload=async(files:{name:string;body:string|Buffer}[],key=randomUUID(),extra:Record<string,string>={})=>{
        const boundary='chat-attachments-boundary';const chunks:Buffer[]=[];
        for(const [name,value] of Object.entries({text:'请先总结这份资料，不生成修改。',clientMessageId:key,...extra}))chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
        for(const file of files)chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${file.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`),Buffer.from(file.body),Buffer.from('\r\n'));
        chunks.push(Buffer.from(`--${boundary}--\r\n`));
        return app!.inject({method:'POST',url:`/api/projects/${p.id}/cards/${c.id}/material-messages`,headers:{host:'127.0.0.1',cookie:cookies.business,'content-type':`multipart/form-data; boundary=${boundary}`},payload:Buffer.concat(chunks)});
      };
      const files=[{name:'业务口径.md',body:'提醒失败不影响记录。'},{name:'字段说明.txt',body:'状态仅表示流程进度。'}],key=randomUUID();
      const responses=await Promise.all([upload(files,key),upload(files,key)]);for(const r of responses)assert.equal(r.statusCode,200,r.body);
      let current=await db.getProject(p.id);assert.equal(current.cards[0].messages.length,1);assert.equal(current.materials.length,p.materials.length+2);
      const message=current.cards[0].messages[0];assert.equal(message.role,'business');assert.equal(message.participantId,'business');assert.equal(message.materialIds?.length,2);
      assert.deepEqual(current.cards[0].fields,c.fields);assert.deepEqual(current.cards[0].approvals,c.approvals);assert.equal(current.phase,p.phase);
      for(const mid of message.materialIds!){const material=current.materials.find(m=>m.id===mid)!;assert.equal(material.sourceConversation?.messageId,message.id);assert.ok(material.filePath);}
      const before=current;
      assert.equal((await upload([{name:'有效.md',body:'可读材料'},{name:'未知.exe',body:'unsupported'}])).statusCode,400);
      assert.equal((await upload(files,randomUUID(),{participantId:'pm'})).statusCode,400);
      assert.ok((await upload(Array.from({length:6},(_,i)=>({name:`${i}.md`,body:'材料'})))).statusCode>=400);
      current=await db.getProject(p.id);assert.deepEqual(current,before);
    });

    await t.test('附件自动分析，可回应、建议新卡或澄清，图片读完才整理',async()=>{
      const {createDiscussionQueue}=await import('../server/discussion-jobs');
      const {appendMaterialMessage}=await import('../server/chat-messages');
      const {textMaterial}=await import('../server/materials');
      for(const mode of ['reply','new','clarify'] as const){
        const p=readyProject('材料路由 '+mode),c=p.cards[0],material=textMaterial('补充.md','支持企业提交到达时间。提醒失败不影响记录。');
        const {message}=appendMaterialMessage(p,c.id,'business-operations',{text:mode==='new'?'@Agent 请结合附件分析。':'',clientMessageId:randomUUID()},[material]);
        applyAction(p,{type:'message',cardId:c.id,text:'我在核对上面的附件。'},'pm','pm');
        if(mode==='reply'){material.status='处理中';material.text='';}
        await db.insertProject(p);let routes=0,suggestions=0,demos=0;
        const queue=createDiscussionQueue({enabled:true,delayMs:2,analyze:async()=>{throw new Error('附件不应走盲目追问');},route:async(_p,focused,materials)=>{
          assert.equal(focused.messages.findLast(item=>item.role!=='agent')?.id,message.id);
          routes++;assert.equal(materials[0].text,'支持企业提交到达时间。提醒失败不影响记录。');
          return {reply:mode==='reply'?'这是对资料的说明，不需要更改需求。':mode==='new'?'建议核对独立新卡草稿。':'这份材料可以明确当前异常处理。',clarifiesCurrent:mode==='clarify',evidence:[{materialId:material.id,quote:'提醒失败不影响记录'}],relatedCardIds:[],cards:mode==='new'?[{key:'arrival',title:'企业到达信息登记',granularity:'具体',origin:'材料要求',rationale:'独立登记业务',coverageGaps:[],fields:{goal:'支持企业提交到达时间',scope:'待明确',flow:'待明确',permission:'待明确',exception:'待明确',data:'待明确',constraint:'待明确',quality:'待明确',acceptance:'待明确'},sourceIds:[material.id],assessment:'待澄清',issues:[],evidence:{goal:[{materialId:material.id,quote:'支持企业提交到达时间'}]}}]:[]};
        },suggest:async current=>{suggestions++;return {summary:'提醒异常规则待人工采纳。',issues:[],changes:[{field:'exception',before:current.fields.exception,after:'提醒失败不影响记录。',reason:'新附件补充异常规则',evidence:[{materialId:material.id,quote:'提醒失败不影响记录。'}]}]};},onSuggested:async()=>{demos++;}});
        try{
          const job=await queue.enqueue(p.id,c.id);
          assert.ok(job);
          if(mode==='reply'){await new Promise(resolve=>setTimeout(resolve,20));assert.equal(routes,0);await db.mutateProject(p.id,next=>{const m=next.materials.find(m=>m.id===material.id)!;m.status='待整理';m.text='支持企业提交到达时间。提醒失败不影响记录。';});}
          assert.equal((await waitJob(p.id,job!.id)).status,'succeeded');
          const current=await db.getProject(p.id);assert.equal(routes,1);assert.equal(suggestions,mode==='clarify'?1:0);assert.equal(demos,mode==='clarify'?1:0);
          assert.equal(current.cards.length,p.cards.length);assert.deepEqual(current.cards[0].fields,c.fields);assert.deepEqual(current.cards[0].approvals,{});assert.equal(current.phase,p.phase);
          assert.equal(current.intakeBatches?.length||0,mode==='new'?1:0);assert.equal(current.cards[0].suggestion?.status,mode==='clarify'?'待决定':undefined);
          const replies=current.cards[0].messages.filter(m=>m.materialReply);
          assert.equal(replies.length,1);assert.deepEqual(replies[0].materialReply?.sourceMessageIds,[message.id]);assert.equal(await queue.enqueue(p.id,c.id),undefined);
        }finally{queue.close();}
      }
    });

    await t.test('@Agent 只读提问保持原话题，跟进的普通消息不会启动第二轮',async()=>{
      const {createDiscussionQueue}=await import('../server/discussion-jobs');
      const {latestHumanMessage}=await import('../shared/discussion');
      const p=readyProject('只读讨论'),c=p.cards[0];
      applyAction(p,{type:'message',cardId:c.id,text:'请把讨论汇总一下。'},'pm','pm');
      const asked='@Agent 请解释当前规则，不要修改需求或生成原型。';
      applyAction(p,{type:'message',cardId:c.id,text:asked},'business','business');
      const requestId=c.messages.at(-1)!.id;
      for(let index=0;index<5;index++)applyAction(p,{type:'message',cardId:c.id,text:`产品与业务讨论 ${index}`},'pm','pm');
      await db.insertProject(p);
      let routed=0,suggested=0,demo=0;
      const queue=createDiscussionQueue({enabled:true,delayMs:2,analyze:async card=>{routed++;assert.equal(latestHumanMessage(card)?.id,requestId);assert.match(card.messages[0].text,/汇总/);await db.mutateProject(p.id,next=>applyAction(next,{type:'message',cardId:c.id,text:'请重画原型。'},'pm','pm'));return {reply:'这里只解释当前规则。',answer:null,question:null,summarize:false};},route:async()=>{throw Error('无附件不走材料路由');},suggest:async()=>{suggested++;throw new Error('不能生成草稿');},onSuggested:async()=>{demo++;}});
      try{const job=await queue.enqueue(p.id,c.id);assert.ok(job);assert.equal((await waitJob(p.id,job.id)).status,'succeeded');const current=await db.getProject(p.id),after=current.cards[0];assert.equal(routed,1);assert.equal(suggested,0);assert.equal(demo,0);assert.equal(after.messages.at(-1)?.text,'这里只解释当前规则。');assert.equal(after.assistantCursor,requestId);assert.equal(await queue.enqueue(p.id,c.id),undefined);assert.equal(after.suggestion,undefined);assert.deepEqual(after.fields,c.fields);assert.deepEqual(after.approvals,{});assert.deepEqual(current.version,p.version);assert.equal(current.phase,p.phase);}finally{queue.close();}
    });

    await t.test('无当前追问时 @Agent 撤回或定向回复暂缓问题仍更新原问题',async()=>{
      const {createDiscussionQueue}=await import('../server/discussion-jobs'),{attachDiscussion}=await import('../server/discussion'),{discussionBasis}=await import('../shared/discussion');
      for(const mode of ['withdraw','deferred','legacy-withdraw'] as const){
        const p=readyProject(`文字入口生命周期-${mode}`),c=p.cards[0];
        applyAction(p,{type:'message',cardId:c.id,text:'讨论是否增加购买平台按钮。'},'business','business-operations');
        attachDiscussion(p,c.id,{answer:null,question:{field:'scope',question:'本期是否纳入购买平台占位按钮？',options:['本期纳入','本期不纳入'],role:'pm',participantId:'pm'},summarize:false},discussionBasis(p,c));
        const q=c.followUps![0];
        if(mode!=='deferred'){
          applyAction(p,{type:'message',cardId:c.id,text:'第二个',replyTo:q.id},'pm','pm');
          attachDiscussion(p,c.id,{answer:null,question:null,summarize:false},discussionBasis(p,c));assert.equal(q.status,'answered');
        }else q.status='deferred';
        applyAction(p,{type:'message',cardId:c.id,text:mode!=='deferred'?'@Agent 我撤回刚才不纳入的答复，暂时没想好':'@Agent 第二个',...(mode==='deferred'?{replyTo:q.id}:{})},'pm','pm');
        const last=c.messages.at(-1)!,before=structuredClone(c.fields);
        if(mode==='legacy-withdraw'){
          c.messages.push({id:randomUUID(),role:'agent',text:'旧路径只回复了撤回文字。',createdAt:new Date().toISOString(),materialReply:{contextMessageId:last.id,sourceMessageIds:[],materialIds:[],clarifiesCurrent:false,relatedCardIds:[],evidence:[],warnings:[]}});c.assistantCursor=last.id;
        }
        await db.insertProject(p);let analyzed=0;
        const queue=createDiscussionQueue({enabled:true,delayMs:1,route:async()=>{throw Error('文字答复不能走无生命周期的材料路径');},analyze:async()=>{
          analyzed++;return {handling:{mode:'direct',trigger:'none',reason:''},answer:null,question:null,summarize:false,...(mode!=='deferred'?{reopenQuestion:{questionId:q.id,messageId:last.id,quote:last.text}}:{})};
        }});
        try{
          const job=await queue.enqueue(p.id,c.id,mode==='legacy-withdraw');assert.equal((await waitJob(p.id,job!.id)).status,'succeeded');assert.equal(analyzed,1);
          const after=(await db.getProject(p.id)).cards[0],question=after.followUps![0];assert.equal(after.followUps!.length,1);assert.equal(question.id,q.id);assert.equal(question.status,mode!=='deferred'?'waiting':'answered');
          if(mode!=='deferred'){assert.equal(question.answerMessageId,undefined);assert.equal(question.answerHistory?.length,1);}else assert.equal(question.answerMessageId,last.id);
          assert.deepEqual(after.fields,before);assert.deepEqual(after.approvals,{});
        }finally{queue.close();}
      }
    });

    await t.test('附件分析中继续发言时丢弃旧建议，以新指示回应而不生成修改',async()=>{
      const {createDiscussionQueue}=await import('../server/discussion-jobs');const {appendMaterialMessage}=await import('../server/chat-messages');const {textMaterial}=await import('../server/materials');
      const p=readyProject('材料并发'),c=p.cards[0],m=textMaterial('补充.md','只需说明取消规则');appendMaterialMessage(p,c.id,'business',{text:'@Agent 看看材料',clientMessageId:randomUUID()},[m]);await db.insertProject(p);
      let release!:()=>void,started!:()=>void,calls=0;const gate=new Promise<void>(r=>{release=r;}),entered=new Promise<void>(r=>{started=r;});
      const queue=createDiscussionQueue({enabled:true,delayMs:2,route:async()=>{if(++calls===1){started();await gate;}return {reply:calls===1?'过期建议不得写入':'只解释材料，不生成修改。',clarifiesCurrent:calls===1,evidence:[],relatedCardIds:[],cards:[]};},suggest:async()=>{throw new Error('用户只要回答，不能修改');}});
      try{const job=await queue.enqueue(p.id,c.id);await entered;await db.mutateProject(p.id,next=>applyAction(next,{type:'message',cardId:c.id,text:'@Agent 先只解释材料，不生成修改建议。'},'pm','pm'));release();assert.equal((await waitJob(p.id,job!.id)).status,'succeeded');const current=await db.getProject(p.id);assert.equal(calls,2);assert.equal(current.cards[0].messages.filter(m=>m.role==='agent').length,1);assert.equal(current.cards[0].messages.at(-1)?.text,'只解释材料，不生成修改。');assert.equal(current.cards[0].suggestion,undefined);}finally{release();queue.close();}
    });

    await t.test('文字与多文件上传登记自动分析，不要求勾选；未启用模型时保留材料与人工确认边界',async()=>{
      const p=createProject('自动材料入口');p.materials=[];await db.insertProject(p);
      const pasted=await request(`/api/projects/${p.id}/materials`,{name:'访谈文字',text:'客户可查询自己的申请。',kind:'其他材料'});
      assert.equal(pasted.statusCode,200);const text=pasted.json<Project>().materials[0];assert.equal(text.intake?.status,'pending');
      const boundary='automatic-intake-files',files=[{name:'first.txt',text:'经理只查看本部门申请。'},{name:'second.md',text:'提交失败保留已填写内容。'},{name:'unsupported.exe',text:'unsupported'}];
      const payload=Buffer.concat([...files.map(f=>Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${f.name}"\r\nContent-Type: application/octet-stream\r\n\r\n${f.text}\r\n`)),Buffer.from(`--${boundary}--\r\n`)]);
      const uploaded=await app!.inject({method:'POST',url:`/api/projects/${p.id}/materials`,headers:{host:'127.0.0.1',cookie:cookies.pm,'content-type':`multipart/form-data; boundary=${boundary}`},payload});
      assert.equal(uploaded.statusCode,200);assert.equal(uploaded.json().uploadFailures.length,1);
      const saved=await db.getProject(p.id);assert.equal(saved.materials.length,3);assert.equal(saved.materials[1].intake?.groupId,saved.materials[2].intake?.groupId);assert.notEqual(saved.materials[1].intake?.groupId,text.intake?.groupId);
      assert.equal(saved.cards.length,0);assert.equal(saved.phase,'可讨论');assert.equal((await db.listJobs(p.id)).length,0);
      const {createIntakeQueue}=await import('../server/intake-jobs');
      const queue=createIntakeQueue({enabled:()=>true,error:e=>String(e),delayMs:1,analyze:async materials=>materials.map(m=>({key:m.id,title:m.name,granularity:'具体' as const,origin:'材料要求' as const,rationale:'材料明确提出',coverageGaps:[],fields:{goal:m.text,scope:'待明确',flow:'待明确',permission:'待明确',exception:'待明确',data:'待明确',constraint:'待明确',quality:'待明确',acceptance:'待明确'},sourceIds:[m.id],assessment:'待澄清' as const,issues:[],evidence:{goal:[{materialId:m.id,quote:m.text}]}}))});
      try{
       queue.wake(p.id);
       for(let i=0;i<100;i++){if((await db.getProject(p.id)).intakeBatches?.length===2)break;await new Promise(r=>setTimeout(r,10));}
       const result=await db.getProject(p.id);assert.equal(result.intakeBatches?.length,2);assert.equal(result.intakeBatches![1].drafts.length,2);assert.equal(result.cards.length,0);
      }finally{queue.close();}
    });

    await t.test('ZIP 后台导入逐文件结果，来源与原包保留；不能重复展开或越权重试', async () => {
      const project=createProject('图片与压缩包验证');project.materials=[];await db.insertProject(project);
      const upload=async(name:string,buffer:Buffer,role:Role='pm')=>{
        const boundary='materials-test-boundary';
        const payload=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`),buffer,Buffer.from(`\r\n--${boundary}--\r\n`)]);
        return app!.inject({method:'POST',url:`/api/projects/${project.id}/materials`,headers:{host:'127.0.0.1',cookie:cookies[role],'content-type':`multipart/form-data; boundary=${boundary}`},payload});
      };
      const zip=storedZip({'项目/规则.txt':Buffer.from('原负责人交接后立即撤权'),'附件/坏图.png':Buffer.from('not image'),'程序.exe':Buffer.from('unsupported')});
      assert.equal((await upload('资料.zip',zip,'business')).statusCode,403);
      assert.equal((await upload('资料.zip',zip)).statusCode,200);
      let jobs=await db.listJobs(project.id);const archiveJob=jobs.find(job=>job.kind==='parse')!;
      assert.equal((await waitJob(project.id,archiveJob.id)).status,'succeeded');
      jobs=await db.listJobs(project.id);for(const job of jobs)await waitJob(project.id,job.id);
      const persisted=await db.getProject(project.id),archive=persisted.materials.find(m=>m.name==='资料.zip')!,child=persisted.materials.find(m=>m.name==='规则.txt')!,image=persisted.materials.find(m=>m.name==='坏图.png')!;
      assert.equal(archive.status,'已展开');assert.equal(archive.archiveEntries?.length,3);assert.equal(archive.text,'');
      assert.equal(child.text,'原负责人交接后立即撤权');assert.equal(child.sourceArchive?.path,'项目/规则.txt');assert.equal(child.sourceArchive?.id,archive.id);
      assert.equal(archive.intake,undefined);assert.equal(child.intake?.status,'pending');assert.equal(child.intake?.groupId,image.intake?.groupId);
      assert.ok(archive.archiveEntries?.find(e=>e.path==='程序.exe')?.error);assert.equal(image.status,'待解析');assert.ok(image.error);
      assert.equal(persisted.cards.length,0);assert.equal(persisted.phase,'可讨论');
      assert.equal((await request(`/api/projects/${project.id}/materials/${archive.id}/retry`,{})).statusCode,409);
      assert.equal((await request(`/api/projects/${project.id}/materials/${image.id}/retry`,{},'business')).statusCode,403);
      const download=await app!.inject({url:`/api/projects/${project.id}/materials/${archive.id}/download`,headers:{host:'127.0.0.1'}});
      assert.deepEqual(download.rawPayload,zip);
      const badPreview=await app!.inject({url:`/api/projects/${project.id}/materials/${image.id}/preview`,headers:{host:'127.0.0.1'}});assert.equal(badPreview.statusCode,400);
      assert.equal((await upload('坏包.zip',Buffer.from('not zip'))).statusCode,200);
      const bad=(await db.getProject(project.id)).materials.find(m=>m.name==='坏包.zip')!;
      const badJob=(await db.listJobs(project.id)).find(j=>j.cardId===bad.id)!;assert.equal((await waitJob(project.id,badJob.id)).status,'failed');
      const retry=await request(`/api/projects/${project.id}/materials/${bad.id}/retry`,{});assert.equal(retry.statusCode,200);await waitJob(project.id,retry.json<Job>().id);
      assert.equal((await db.getProject(project.id)).materials.filter(m=>m.name==='规则.txt').length,1);
    });

    await t.test('重启后中断的图片可重试且不改变已完成材料', async () => {
      const project=createProject('材料中断恢复');project.materials=[{id:'pending-image',name:'截图.png',kind:'PNG 图片',location:'上传文件',text:'',status:'处理中',cardIds:[],createdAt:new Date().toISOString(),filePath:'materials/pending.png'}, {id:'done-text',name:'文字.txt',kind:'TXT 文件',location:'上传文件',text:'已经完成',status:'待整理',cardIds:[],createdAt:new Date().toISOString()}];
      await db.insertProject(project);await db.newJob(project.id,'parse','未完成识别','pending-image');
      await db.initStore();
      const restored=await db.getProject(project.id);assert.equal(restored.materials[0].status,'待解析');assert.match(restored.materials[0].error!,/重启/);assert.deepEqual(restored.materials[1],project.materials[1]);
      assert.equal((await db.listJobs(project.id))[0].status,'failed');assert.deepEqual(restored.cards,project.cards);
    });

    await t.test('数据库读取的历史快照不受后续正文、材料和消息影响', async () => {
      const project = readyProject('冻结历史验证'); confirmAndReview(project);
      await db.insertProject(project);
      const historical = structuredClone(project.snapshots.at(-1));
      const response = await act(project, {type: 'editCard', cardId: project.cards[0].id, title: project.cards[0].title, fields: {...completeFields, permission: '原负责人保留七天只读权限'}, reason: '业务补充'});
      assert.equal(response.statusCode, 200);
      await db.mutateProject(project.id, current => {current.materials[0].text += '\n新的材料说明';});
      const persisted = await db.getProject(project.id);
      assert.equal(persisted.phase, '可讨论');
      assert.deepEqual(persisted.snapshots.at(-1), historical);
      const download = await app!.inject({method: 'GET', url: `/api/projects/${project.id}/prd?version=${historical!.id}`, headers: {host: '127.0.0.1'}});
      assert.equal(download.statusCode, 200);
      assert.equal(download.body, historical!.markdown);
    });

    await t.test('两端 HTTP 回执、单端失败重试与冻结版本内容一致', async () => {
      const received: {target: string;key: string;body: {version: string;document: {sha256: string;content: string}}}[] = [];
      let failTeamMate = true;
      receiver = createServer(async (req, res) => {
        const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const target = req.url || '';
        received.push({target, key: String(req.headers['idempotency-key']), body: JSON.parse(Buffer.concat(chunks).toString())});
        res.setHeader('content-type', 'application/json');
        if (target === '/teammate' && failTeamMate) { failTeamMate = false; res.statusCode = 503; res.end('{}'); }
        else res.end(JSON.stringify({accepted: true, receiptId: `test-receipt-${target}`}));
      });
      await new Promise<void>(resolve => receiver!.listen(0, '127.0.0.1', resolve));
      const address = receiver.address(); assert.ok(address && typeof address === 'object');
      config.targets.knowledge.url = `http://127.0.0.1:${address.port}/knowledge`;
      config.targets.teammate.url = `http://127.0.0.1:${address.port}/teammate`;
      const project = readyProject('交付联调验证'); confirmAndReview(project); await db.insertProject(project);
      const first = await request(`/api/projects/${project.id}/deliver`, {mode: 'http'}); assert.equal(first.statusCode, 200);
      assert.equal((await waitJob(project.id, first.json<Job>().id)).status, 'failed');
      const failed = await db.getProject(project.id), delivery = failed.deliveries[0];
      assert.equal(failed.phase, '已明确'); assert.equal(failed.version.join('.'), '0.1.0');
      assert.deepEqual(delivery.targets.map(target => target.status), ['成功', '失败']);
      const snapshot = structuredClone(delivery.snapshot);
      const blocked = await act(failed, {type: 'scope', cardId: failed.cards[0].id, included: false, reason: '交付中不能改范围'});
      assert.equal(blocked.statusCode, 400); assert.match(blocked.json().error, /冻结交付/);
      const retry = await request(`/api/projects/${project.id}/deliver`, {mode: 'http'}); assert.equal(retry.statusCode, 200);
      assert.equal((await waitJob(project.id, retry.json<Job>().id)).status, 'succeeded');
      const finished = await db.getProject(project.id);
      assert.equal(finished.phase, '已交付'); assert.equal(finished.version.join('.'), '1.0.0');
      assert.deepEqual(finished.deliveries[0].targets.map(target => target.attempts), [1, 2]);
      assert.deepEqual(finished.deliveries[0].snapshot, snapshot);
      assert.equal(received.filter(item => item.target === '/knowledge').length, 1);
      const teamRequests = received.filter(item => item.target === '/teammate'); assert.equal(teamRequests.length, 2);
      assert.deepEqual(teamRequests[0], teamRequests[1], '失败目标必须按相同幂等键、版本和文档重试');
      assert.equal(received[0].body.document.sha256, received[1].body.document.sha256);
      assert.ok(received.every(item => item.body.version === 'V1.0.0'));
      await new Promise<void>(resolve => receiver!.close(() => resolve())); receiver = undefined;
    });

    await t.test('重启中断任务可见，成功端不回退，重试次数正确且历史继续可读', async () => {
      const project = readyProject('重启恢复验证'); confirmAndReview(project);
      await db.insertProject(project);
      const {result: delivery} = await db.mutateProject(project.id, current => beginDelivery(current, 'pm', 'local'));
      await db.mutateProject(project.id, current => recordDeliveryResult(current, delivery.id, 'knowledge', {ok: true, receipt: 'local-test-receipt'}));
      const job = await db.newJob(project.id, 'deliver', '中断的交付'); job.status = 'running'; await db.putJob(job);
      await assert.rejects(() => db.newJob(project.id, 'deliver', '重复交付'), /同类任务/);
      const frozen = structuredClone(delivery.snapshot);
      await app!.close();
      await db.initStore(); app = await buildApp();
      const restored = await db.getProject(project.id);
      assert.equal(restored.phase, '已明确'); assert.equal(restored.version.join('.'), '0.1.0');
      assert.deepEqual(restored.deliveries[0].targets.map(target => target.status), ['成功', '失败']);
      assert.match(restored.deliveries[0].targets[1].error!, /重启/);
      assert.deepEqual(restored.deliveries[0].snapshot, frozen);
      const restoredJob = (await db.listJobs(project.id)).find(item => item.id === job.id)!;
      assert.equal(restoredJob.status, 'failed'); assert.match(restoredJob.error!, /重启/);
      const bootstrap = await app!.inject({method: 'GET', url: `/api/bootstrap?projectId=${project.id}`, headers: {host: '127.0.0.1'}});
      assert.equal(bootstrap.statusCode, 200); assert.ok(bootstrap.json().jobs.some((item: Job) => item.id === job.id && item.status === 'failed'));
      const {result: retry} = await db.mutateProject(project.id, current => beginDelivery(current, 'pm', 'local'));
      assert.equal(retry.id, delivery.id); assert.deepEqual(retry.targets.map(target => target.attempts), [1, 2]);
      assert.deepEqual(retry.snapshot, frozen);
    });
  } finally {
    if (receiver) await new Promise<void>(resolve => receiver!.close(() => resolve()));
    if (app) await app.close();
    if (store) await store.pool.end();
    if (created) await admin.query(`DROP DATABASE "${dbName}" WITH (FORCE)`);
    await admin.end();
    if (dataDir) await rm(dataDir, {recursive: true, force: true});
  }
});
