import {setSelectedModel} from './model-settings';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {config} from './config.js';
import {createProject,applyAction,completeNoopSuggestion} from './domain.js';
import {hydrateProject,writeReadModel,type DiscussionAppend} from './read-model';
import {cardView} from './workspace-sync';
import type {Project,Job,Action,Role} from '../shared/types.js';
import type {ParticipantId} from '../shared/participants';
import {notifyProject} from './project-events';
export const pool=new pg.Pool({connectionString:config.databaseUrl,max:8,connectionTimeoutMillis:8000});
// An idle connection can be closed while a model is running. pg removes that
// client; handle the event so the next request can reconnect without a crash.
pool.on('error',()=>console.error('数据库空闲连接已断开，后续请求将重新连接。'));
export class ConflictError extends Error {statusCode=409}
export class NotFoundError extends Error {statusCode=404}
export async function initStore(){
 await pool.query('CREATE TABLE IF NOT EXISTS app_settings(key text PRIMARY KEY, value jsonb NOT NULL)');
 const setting=(await pool.query("SELECT value FROM app_settings WHERE key='model'")).rows[0]?.value;
 setSelectedModel(typeof setting==='string'?setting:undefined);
 await pool.query(`CREATE TABLE IF NOT EXISTS projects(id text PRIMARY KEY, body jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
 ALTER TABLE projects ADD COLUMN IF NOT EXISTS view_stamp bigint NOT NULL DEFAULT 0;
 ALTER TABLE projects ADD COLUMN IF NOT EXISTS view_name text;
 UPDATE projects SET view_stamp=COALESCE((body->>'stamp')::bigint,0),view_name=body->>'name' WHERE view_name IS NULL;
 CREATE TABLE IF NOT EXISTS jobs(id text PRIMARY KEY,project_id text NOT NULL REFERENCES projects(id),body jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
 CREATE INDEX IF NOT EXISTS jobs_project_idx ON jobs(project_id,created_at DESC);
 CREATE UNIQUE INDEX IF NOT EXISTS one_active_job ON jobs(project_id,(body->>'kind'),COALESCE(body->>'cardId','')) WHERE body->>'status' IN ('queued','running');`);
 await pool.query(`CREATE TABLE IF NOT EXISTS workspace_heads(project_id text PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,body jsonb NOT NULL,base_stamp bigint NOT NULL,demo jsonb);
 ALTER TABLE workspace_heads ADD COLUMN IF NOT EXISTS demo jsonb;
 CREATE TABLE IF NOT EXISTS workspace_cards(project_id text REFERENCES projects(id) ON DELETE CASCADE,card_id text NOT NULL,position int NOT NULL,body jsonb NOT NULL,change_key text NOT NULL,changed_stamp bigint NOT NULL,PRIMARY KEY(project_id,card_id));
 ALTER TABLE workspace_cards ADD COLUMN IF NOT EXISTS message_fingerprint text;
 ALTER TABLE workspace_cards ADD COLUMN IF NOT EXISTS history jsonb;
 CREATE INDEX IF NOT EXISTS workspace_card_changes ON workspace_cards(project_id,changed_stamp);
 CREATE TABLE IF NOT EXISTS workspace_messages(project_id text NOT NULL,card_id text NOT NULL,ordinal bigint NOT NULL,message_id text NOT NULL,body jsonb NOT NULL,PRIMARY KEY(project_id,card_id,message_id),FOREIGN KEY(project_id,card_id) REFERENCES workspace_cards(project_id,card_id) ON DELETE CASCADE);
 CREATE INDEX IF NOT EXISTS workspace_message_page ON workspace_messages(project_id,card_id,ordinal DESC);
 ALTER TABLE workspace_messages ADD COLUMN IF NOT EXISTS client_key text;
 UPDATE workspace_messages SET client_key=COALESCE(body->>'participantId',body->>'role')||':'||(body->>'clientMessageId') WHERE client_key IS NULL AND body ? 'clientMessageId';
 CREATE UNIQUE INDEX IF NOT EXISTS workspace_message_idempotency ON workspace_messages(project_id,card_id,client_key) WHERE client_key IS NOT NULL;
 CREATE TABLE IF NOT EXISTS workspace_materials(project_id text REFERENCES projects(id) ON DELETE CASCADE,material_id text NOT NULL,body jsonb NOT NULL,PRIMARY KEY(project_id,material_id));
 CREATE TABLE IF NOT EXISTS discussion_appends(sequence bigserial PRIMARY KEY,project_id text REFERENCES projects(id) ON DELETE CASCADE,card_id text NOT NULL,body jsonb NOT NULL);
 CREATE INDEX IF NOT EXISTS discussion_project_idx ON discussion_appends(project_id,sequence);`);
 const {rows}=await pool.query('SELECT id FROM projects LIMIT 1');
 if(!rows.length)await insertProject(createProject('CRM 客户管理项目'));
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  await client.query(`UPDATE jobs SET body=body || jsonb_build_object('status','failed','error','服务已重启，未完成的任务可以重新发起。','finishedAt',now()) WHERE body->>'status' IN ('queued','running')`);
  const {rows:projects}=await client.query('SELECT id,body,view_stamp FROM projects FOR UPDATE');
  for(const row of projects){
   const appends=(await client.query('SELECT body FROM discussion_appends WHERE project_id=$1 ORDER BY sequence',[row.id])).rows.map(r=>r.body as DiscussionAppend);
   const project=hydrateProject(row.body,Number(row.view_stamp),appends);
   let changed=false;
   for(const card of project.cards)if(completeNoopSuggestion(card))changed=true;
   for(const card of project.cards)for(const a of card.assessments||[])if(a.status==='running'){a.status='failed';a.error='服务已重启，请按最新讨论重新评估。';a.updatedAt=new Date().toISOString();changed=true;}
   const retiredQuestions=project.cards.flatMap(card=>card.followUps||[]).filter(q=>q.status==='waiting'&&q.role==='reviewer');
   for(const question of retiredQuestions){question.status='superseded';changed=true;}
   if(retiredQuestions.length)project.events.push({id:randomUUID(),action:'更新沟通参与角色',role:'system',detail:'已关闭等待旧评审身份的追问，后续由产品与业务继续澄清；历史发言保留。',createdAt:new Date().toISOString()});
   const interruptedMaterials=project.materials.filter(material=>material.status==='处理中');
   for(const material of interruptedMaterials){material.status='待解析';material.error='服务已重启，未完成的文件处理可以重试。';changed=true}
   if(interruptedMaterials.length)project.events.push({id:randomUUID(),action:'恢复中断材料处理',role:'system',detail:`${interruptedMaterials.length} 份材料等待重试，已完成结果保留。`,createdAt:new Date().toISOString()});
   let deliveryChanged=false;
   for(const delivery of project.deliveries.filter(delivery=>!delivery.completedAt)){
    for(const target of delivery.targets){
     if(target.status==='交付中'){
      target.status='失败';target.error='服务已重启，交付结果尚未确认，请重试此冻结版本。';target.updatedAt=new Date().toISOString();changed=true;deliveryChanged=true;
     }
    }
   }
   if(changed){
    project.stamp++;
    if(deliveryChanged)project.events.push({id:randomUUID(),action:'恢复中断交付',role:'system',detail:'已成功目标保持成功，其余中断目标等待按原版本重试。',createdAt:new Date().toISOString()});
    await client.query('UPDATE projects SET body=$2,view_stamp=$3,view_name=$4 WHERE id=$1',[project.id,project,project.stamp,project.name]);
    await client.query('DELETE FROM discussion_appends WHERE project_id=$1',[project.id]);await writeReadModel(client,project);
   }
   else if(!(await client.query('SELECT 1 FROM workspace_heads WHERE project_id=$1',[project.id])).rowCount||(await client.query('SELECT 1 FROM workspace_cards WHERE project_id=$1 AND history IS NULL LIMIT 1',[project.id])).rowCount||(await client.query("SELECT 1 FROM workspace_heads h, jsonb_array_elements(h.body->'materials') m WHERE project_id=$1 AND NOT (m ? 'textLength') LIMIT 1",[project.id])).rowCount)await writeReadModel(client,project);
  }
  await client.query('COMMIT');
 }catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}
}
export interface WorkspaceProjectVersion {id:string;name:string;stamp:string}
export async function listWorkspaceProjectVersions(){
 return (await pool.query<WorkspaceProjectVersion>('SELECT id,view_name AS name,view_stamp AS stamp FROM projects ORDER BY created_at ASC,id')).rows;
}
export async function listProjects(){return (await listWorkspaceProjectVersions()).map(({id,name})=>({id,name}));}
export async function insertProject(p:Project){const client=await pool.connect();try{await client.query('BEGIN');await client.query('INSERT INTO projects(id,body,view_stamp,view_name) VALUES($1,$2,$3,$4)',[p.id,p,p.stamp,p.name]);await writeReadModel(client,p);await client.query('COMMIT');return p;}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}}
export async function getProject(id:string):Promise<Project>{
 const {rows}=await pool.query(`SELECT p.body,p.view_stamp,COALESCE((SELECT jsonb_agg(d.body ORDER BY d.sequence) FROM discussion_appends d WHERE d.project_id=p.id),'[]'::jsonb) AS appends FROM projects p WHERE p.id=$1`,[id]);
 if(!rows.length)throw new NotFoundError('项目不存在');return hydrateProject(rows[0].body,Number(rows[0].view_stamp),rows[0].appends);
}

export async function getWorkspaceProject(id:string,previous?:Project,includeDemo=false):Promise<Project>{
 const base=previous?.id===id?previous.stamp:null;
 const {rows}=await pool.query(`SELECT p.view_stamp,h.body,h.base_stamp,CASE WHEN $3 THEN h.demo ELSE NULL END AS demo,
 COALESCE((SELECT jsonb_agg(c.body ORDER BY c.position) FROM workspace_cards c WHERE c.project_id=p.id AND ($2::bigint IS NULL OR h.base_stamp>$2 OR c.changed_stamp>$2)),'[]'::jsonb) AS cards,
 COALESCE((SELECT jsonb_agg(t.body->'event' ORDER BY t.sequence) FROM (SELECT body,sequence FROM discussion_appends d WHERE d.project_id=p.id ORDER BY sequence DESC LIMIT 40)t),'[]'::jsonb) AS events
 FROM projects p JOIN workspace_heads h ON h.project_id=p.id WHERE p.id=$1`,[id,base,includeDemo]);
 if(!rows.length)throw new NotFoundError('项目不存在');const row=rows[0],same=previous&&base!==null&&Number(row.base_stamp)<=base;
 const changes=new Map<string,Project['cards'][number]>(row.cards.map((c:Project['cards'][number])=>[c.id,c]));
 return {...(same?previous:row.body),...includeDemo?{generatedDemo:row.demo||undefined}:{},stamp:Number(row.view_stamp),cards:same?previous.cards.map(c=>changes.get(c.id)||c):row.cards,events:[...new Map([...row.body.events,...row.events].map((e:Project['events'][number])=>[e.id,e])).values()].slice(-40)};
}
export async function getPreviewProject(id:string){return getWorkspaceProject(id,undefined,true);}
export async function getArtifactProject(id:string):Promise<Project>{
 const row=(await pool.query('SELECT p.id,p.view_name,h.demo FROM projects p JOIN workspace_heads h ON h.project_id=p.id WHERE p.id=$1',[id])).rows[0];
 if(!row)throw new NotFoundError('项目不存在');return {id:row.id,name:row.view_name,generatedDemo:row.demo||undefined,cards:[],materials:[],snapshots:[],deliveries:[],events:[],stamp:0,phase:'可讨论',version:[0,0,0],createdAt:''};
}
export async function getDiscussionView(id:string,cardId:string):Promise<Project>{
 const row=(await pool.query(`SELECT h.body,p.view_stamp,c.body AS card FROM projects p JOIN workspace_heads h ON h.project_id=p.id JOIN workspace_cards c ON c.project_id=p.id AND c.card_id=$2 WHERE p.id=$1`,[id,cardId])).rows[0];
 if(!row)throw new NotFoundError('需求不存在');return {...row.body,stamp:Number(row.view_stamp),cards:[row.card]};
}

export async function appendDiscussion(id:string,action:Extract<Action,{type:'message'}>,role:Role,participantId:ParticipantId,stamp:number){
 const client=await pool.connect();try{
  await client.query('BEGIN');const row=(await client.query('SELECT view_stamp FROM projects WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!row)throw new NotFoundError('项目不存在');
  const currentStamp=Number(row.view_stamp),clientKey=action.clientMessageId?`${participantId}:${action.clientMessageId}`:null;
  if(clientKey){const existing=(await client.query('SELECT body FROM workspace_messages WHERE project_id=$1 AND card_id=$2 AND client_key=$3',[id,action.cardId,clientKey])).rows[0];if(existing){
   if(existing.body.text!==action.text.trim()||existing.body.replyTo!==action.replyTo||existing.body.materialIds?.length)throw new ConflictError('相同消息标识不能用于不同内容。');
   await client.query('COMMIT');return {stamp:currentStamp,messageId:existing.body.id,duplicate:true};
  }}
  const head=(await client.query('SELECT body,change_key FROM workspace_cards WHERE project_id=$1 AND card_id=$2',[id,action.cardId])).rows[0];if(!head)throw new NotFoundError('需求不存在');
  const card=head.body as Project['cards'][number],count=card.messageCount??card.messages.length;
  if(action.baseRevision!==undefined&&action.baseRound!==undefined){if(card.revision!==action.baseRevision||card.round!==action.baseRound)throw new ConflictError('需求正文已有更新，请核对当前修订后再发送。');}
  else if(currentStamp!==stamp)throw new ConflictError('内容已有更新，请核对最新讨论后重试。');
  const p:Project={id,name:'',stamp:currentStamp,phase:'可讨论',version:[0,0,0],cards:[card],materials:[],snapshots:[],deliveries:[],events:[],createdAt:''};
  applyAction(p,action,role,participantId);const message=card.messages.at(-1)!,event=p.events.at(-1)!;card.messageCount=count+1;
  await client.query('INSERT INTO discussion_appends(project_id,card_id,body) VALUES($1,$2,$3)',[id,card.id,{cardId:card.id,message,event}]);
  await client.query('INSERT INTO workspace_messages(project_id,card_id,ordinal,message_id,body,client_key) VALUES($1,$2,$3,$4,$5,$6)',[id,card.id,count,message.id,message,clientKey]);
  await client.query('UPDATE workspace_cards SET body=$3,changed_stamp=$4,message_fingerprint=NULL WHERE project_id=$1 AND card_id=$2',[id,card.id,cardView(card,4,head.change_key),currentStamp+1]);
  await client.query('UPDATE projects SET view_stamp=$2 WHERE id=$1',[id,currentStamp+1]);await client.query('COMMIT');notifyProject(id);return {stamp:currentStamp+1,messageId:message.id};
 }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}

export async function messagePage(id:string,cardId:string,before:string|undefined,limit:number){
 const client=await pool.connect();try{
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const head=(await client.query('SELECT body FROM workspace_cards WHERE project_id=$1 AND card_id=$2',[id,cardId])).rows[0];if(!head)throw new NotFoundError('需求不存在');
  let end=Number(head.body.messageCount);if(before){const cursor=(await client.query('SELECT ordinal FROM workspace_messages WHERE project_id=$1 AND card_id=$2 AND message_id=$3',[id,cardId,before])).rows[0];if(!cursor)throw new ConflictError('消息游标已更新，请重新打开讨论');end=Number(cursor.ordinal);}
  const {rows}=await client.query('SELECT body,ordinal FROM workspace_messages WHERE project_id=$1 AND card_id=$2 AND ordinal<$3 ORDER BY ordinal DESC LIMIT $4',[id,cardId,end,limit]);rows.reverse();
  await client.query('COMMIT');return {messages:rows.map(r=>r.body),total:head.body.messageCount,version:head.body.messageVersion,nextBefore:rows.length&&Number(rows[0].ordinal)>0?rows[0].body.id:null};
 }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}
export async function mutateProject<T>(id:string,fn:(p:Project)=>T,stamp?:number):Promise<{project:Project;result:T}>{
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const {rows}=await client.query('SELECT body,view_stamp FROM projects WHERE id=$1 FOR UPDATE',[id]);
  if(!rows.length)throw new NotFoundError('项目不存在');
  const appends=(await client.query('SELECT body FROM discussion_appends WHERE project_id=$1 ORDER BY sequence',[id])).rows.map(r=>r.body as DiscussionAppend);
  const project=hydrateProject(rows[0].body,Number(rows[0].view_stamp),appends);
  if(stamp!==undefined&&project.stamp!==stamp)throw new ConflictError('内容已有更新，已为你刷新。请核对最新内容后再操作。');
  const result=fn(project);project.stamp++;
  await client.query('UPDATE projects SET body=$2,view_stamp=$3,view_name=$4 WHERE id=$1',[id,project,project.stamp,project.name]);
  await client.query('DELETE FROM discussion_appends WHERE project_id=$1',[id]);await writeReadModel(client,project);
  await client.query('COMMIT');notifyProject(id);return {project,result};
 }catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
}
export async function listJobs(projectId:string):Promise<Job[]>{return (await pool.query('SELECT body FROM jobs WHERE project_id=$1 ORDER BY created_at DESC LIMIT 30',[projectId])).rows.map(r=>r.body)}
export async function putJob(job:Job){await pool.query('UPDATE jobs SET body=$2 WHERE id=$1',[job.id,job]);notifyProject(job.projectId);}
export async function newJob(projectId:string,kind:Job['kind'],label:string,cardId?:string):Promise<Job>{
 const job:Job={id:randomUUID(),projectId,kind,label,cardId,status:'queued',createdAt:new Date().toISOString()};
 try{await pool.query('INSERT INTO jobs(id,project_id,body) VALUES($1,$2,$3)',[job.id,projectId,job])}
 catch(e){if((e as {code?:string}).code==='23505')throw new ConflictError('同类任务正在处理中，请等待完成。');throw e}
 notifyProject(projectId);return job;
}
