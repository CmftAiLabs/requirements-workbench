import {modelOptions,modelPolicies,visionModel,setSelectedModel} from './model-settings';
import {PARTICIPANTS,participantById,defaultParticipantId,type ActiveRole} from '../shared/participants';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import statics from '@fastify/static';
import {existsSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {z,ZodError} from 'zod';
import {config} from './config.js';
import {requestAccessError,proxyTokenMatches} from './request-policy';
import {pool,listProjects,listWorkspaceProjectVersions,insertProject,getProject,getWorkspaceProject,getPreviewProject,getArtifactProject,appendDiscussion,messagePage,mutateProject,listJobs,newJob,putJob,ConflictError} from './store.js';
import {createReminderReader} from './discussion-reminders';
import {createProject,applyAction,attachIntakeRefinement,attachSuggestion,buildMarkdown,beginDelivery} from './domain.js';
import {probeModel,refineIntakeRequirement,suggestChanges,suggestModuleGrouping} from './ai.js';
import {concreteChats,groupingBasis} from '../shared/card-organization';
import {prepareUpload,textMaterial,isImageFile,isArchiveFile,MAX_TEXT} from './materials.js';
import {expandZip,MAX_ARCHIVE_BYTES} from './archive-materials.js';
import {recognizeImage,normalizeImage} from './image-materials.js';
import {performDelivery} from './delivery.js';
import {createCRMExperience,applyCRMExampleConclusion} from './experience.js';
import {workspacePRD,prdWord,demoZip} from './workspace-export.js';
import {buildDemoHTML} from '../shared/project-demo.ts';
import {actionRequest,materialRequest,extractionRequest,refinementRequest} from './validation.js';
import {ROLES,type Role,type Job,type Action,type Material,type ArchiveEntry,type Message} from '../shared/types.js';
import {getChatDisabledReason} from '../shared/chat-policy.js';
import {createDemoQueue,reconcileDemo} from './demo-jobs.ts';
import {demoView,demoArtifactHTML,generatedDemoZip} from './demo-builder.ts';
import {createDiscussionQueue} from './discussion-jobs.ts';
import {createIntakeQueue} from './intake-jobs';
import {appendMaterialMessage} from './chat-messages';
import {CHAT_MAX_FILES,CHAT_MAX_BYTES,attachmentDisabledReason,pendingAttachmentMessages,conversationMaterials} from '../shared/chat-attachments';
import {discussionRequest,latestHumanMessage} from '../shared/discussion.ts';
import {mentionsAgent} from '../shared/agent-mention';
import {createWorkspaceSync,compactProject} from './workspace-sync';
import {digest} from './demo-schema';
import {metricsSnapshot,recordMetric} from './metrics';
import {watchProject} from './project-events';
import type {FastifyRequest,FastifyReply} from 'fastify';

const publicError=(e:unknown)=>{
 const raw=e instanceof Error?e.message:'操作失败';
 const secret=process.env.MODEL_API_KEY;
 return (secret?raw.split(secret).join('[已隐藏]'):raw).replace(/Bearer\s+\S+/gi,'Bearer [已隐藏]').replace(/postgres(?:ql)?:\/\/[^\s]+/g,'[数据库连接已隐藏]').slice(0,600);
};
function participantOf(req:FastifyRequest){
 const signed=req.cookies.participant,value=signed?req.unsignCookie(signed):null;
 const person=value?.valid?participantById(value.value||''):undefined;
 if(person)return person;
 const legacy=req.cookies.role?req.unsignCookie(req.cookies.role):null;
 return participantById(legacy?.valid&&legacy.value==='business'?'business':'pm')!;
}
function roleOf(req:FastifyRequest):ActiveRole{return participantOf(req).role;}
function requirePM(req:FastifyRequest){if(roleOf(req)!=='pm')throw Object.assign(new Error('该操作需要产品经理身份。'),{statusCode:403})}
const params=(req:FastifyRequest)=>req.params as {id:string;cardId?:string;materialId?:string};
function runJob(job:Job,task:()=>Promise<void>){
 setImmediate(()=>{void(async()=>{
  try{job.status='running';await putJob(job);await task();job.status='succeeded'}
  catch(e){job.status='failed';job.error=publicError(e)}
  finally{job.finishedAt=new Date().toISOString();await putJob(job)}
 })().catch(()=>console.error('后台任务状态保存失败，请检查数据库连接。'))});
 return job;
}
// Large batches stay responsive without flooding the model gateway.
let activeImageReads=0;
const imageWaiters:(()=>void)[]=[];
async function readImage(buffer:Buffer){
 if(activeImageReads>=2)await new Promise<void>(resolve=>imageWaiters.push(resolve));
 else activeImageReads++;
 try{return await recognizeImage(buffer)}finally{const next=imageWaiters.shift();if(next)next();else activeImageReads--}
}
async function startMaterialProcessing(projectId:string,material:Material,onReady?:(id:string)=>void){
 const archive=isArchiveFile(material.name);
 const job=await newJob(projectId,'parse',`${archive?'展开压缩包':'识别图片'}：${material.name}`,material.id);
 job.result={materialId:material.id};
 return runJob(job,async()=>{
  try{
   const buffer=await readFile(path.join(config.dataDir,material.filePath!));
   if(archive){
    const entries=await expandZip(buffer),children:Material[]=[],report:ArchiveEntry[]=[];
    for(const entry of entries){
     if(entry.error||!entry.buffer){report.push({path:entry.path,error:entry.error||'没有可读取的文件内容。'});continue}
     const child=await prepareUpload(entry.path,entry.buffer);
     child.sourceArchive={id:material.id,name:material.name,path:entry.path};
     child.location=`${material.name} / ${entry.path}${isImageFile(child.name)?' · 图片识别':''}`;
     children.push(child);report.push({path:entry.path,materialId:child.id});
    }
    await mutateProject(projectId,p=>{
     const target=p.materials.find(item=>item.id===material.id);
     if(!target||target.archiveEntries)throw new ConflictError('压缩包已有展开结果，请刷新材料箱。');
     if(target.intake)for(const child of children)child.intake={...target.intake};
     target.archiveEntries=report;target.status='已展开';delete target.error;delete target.intake;p.materials.push(...children);
    });
    job.result={materialId:material.id,importedCount:children.length,failedCount:report.filter(entry=>entry.error).length+children.filter(child=>child.error).length};
    for(const child of children.filter(child=>child.status==='处理中')){
     try{await startMaterialProcessing(projectId,child,onReady)}catch(error){await markMaterialFailed(projectId,child.id,error)}
    }
   }else{
    const result=await readImage(buffer);
    if(!result.text.trim()||result.text.length>MAX_TEXT)throw new Error('图片识别结果为空或过长，请分成更清晰的小图后上传。');
    await mutateProject(projectId,p=>{
     const target=p.materials.find(item=>item.id===material.id);if(!target)throw new Error('材料不存在');
     target.text=result.text;target.mimeType=result.mimeType;target.status='待整理';delete target.error;
    });
   }
  }catch(error){await markMaterialFailed(projectId,material.id,error);throw error}finally{onReady?.(projectId)}
 });
}
async function markMaterialFailed(projectId:string,materialId:string,error:unknown){
 await mutateProject(projectId,p=>{const target=p.materials.find(item=>item.id===materialId);if(target&&target.status==='处理中'){target.status='待解析';target.error=publicError(error)}});
}
export async function buildApp(){
 const app=Fastify({logger:false,bodyLimit:2*1024*1024,requestTimeout:120000});
 const workspaceRoot=path.resolve('dist'),workspaceIndex=path.join(workspaceRoot,'index.html');
 const servesWorkspace=existsSync(workspaceIndex);
 const sync=createWorkspaceSync(),requestStarts=new WeakMap<FastifyRequest,number>(),responseBytes=new WeakMap<FastifyRequest,number>();
 const readReminders=createReminderReader();
 const streams=new Set<()=>void>();app.addHook('preClose',async()=>{for(const close of streams)close();});
 const demos=createDemoQueue({enabled:config.modelConfigured});
 void demos.resume().catch(()=>app.log.warn('原型后台检查恢复未完成'));
 const discussion=createDiscussionQueue({enabled:config.modelConfigured,onSuggested:(id,cardId)=>demos.enqueue(id,cardId)});
 const intake=createIntakeQueue({enabled:()=>config.modelConfigured,error:publicError});
 void intake.resume().catch(()=>app.log.warn('材料自动分析恢复未完成'));
 app.addHook('onClose',async()=>{discussion.close();demos.close();intake.close();});
 await app.register(cookie,{secret:config.sessionSecret,hook:'onRequest'});
 await app.register(multipart,{limits:{fileSize:MAX_ARCHIVE_BYTES,files:1,fields:10}});
 app.addHook('onRequest',async(req,reply)=>{
  requestStarts.set(req,performance.now());
  if(!proxyTokenMatches(config.proxyAccessToken,req.headers['x-workbench-token']))return reply.code(401).send({error:'请通过工作台入口访问。'});
  const host=req.headers.host||'';
  const error=requestAccessError(req.method,host,req.headers.origin,config.publicOrigin,req.headers['sec-fetch-site'] as string|undefined);
  if(error)return reply.code(403).send({error});
 });
 app.addHook('onSend',async(req,reply,payload)=>{
  reply.header('X-Content-Type-Options','nosniff').header('Referrer-Policy','same-origin');
  if(!(req.routeOptions.config as {previewArtifact?:boolean}|undefined)?.previewArtifact&&!reply.hasHeader('X-Frame-Options'))reply.header('X-Frame-Options','DENY');
  if(req.url.startsWith('/api/')&&!reply.hasHeader('Cache-Control'))reply.header('Cache-Control','no-store');
  reply.header('Server-Timing',`app;dur=${(performance.now()-(requestStarts.get(req)||performance.now())).toFixed(2)}`);
  responseBytes.set(req,typeof payload==='string'?Buffer.byteLength(payload):Buffer.isBuffer(payload)?payload.length:0);
  return payload;
 });
 app.addHook('onResponse',async(req,reply)=>{recordMetric(`${req.method} ${req.routeOptions.url||'unmatched'}`,performance.now()-(requestStarts.get(req)||performance.now()),{bytes:responseBytes.get(req),failed:reply.statusCode>=400});});
 app.setErrorHandler((error,req,reply)=>{
  if(error instanceof ZodError)return reply.code(400).send({error:'输入格式不正确：'+error.issues.map(i=>i.path.join('.')+' '+i.message).slice(0,3).join('；')});
  const status=(error as {statusCode?:number}).statusCode;
  reply.code(status&&status>=400&&status<600?status:400).send({error:publicError(error)});
 });
 app.get('/api/health',async()=>{await pool.query('SELECT 1');return {service:'requirements-workbench',version:'0.1.0',database:'ok',model:config.model,modelConfigured:config.modelConfigured}});
 app.get('/api/models',async()=>({model:config.model,options:modelOptions(),policies:modelPolicies(),visionModel:visionModel()}));
 app.post('/api/models/probe',async req=>{
  requirePM(req);const {model}=z.object({model:z.string()}).strict().parse(req.body);
  if(!modelOptions().includes(model))throw new Error('请选择已配置的模型。');
  return probeModel(model);
 });
 app.post('/api/models',async req=>{
  requirePM(req);const {model}=z.object({model:z.string()}).strict().parse(req.body);
  if(!modelOptions().includes(model))throw new Error('请选择已配置的模型。');
  const client=await pool.connect();
  try{
   await client.query('BEGIN');
   // Serialize the check with job creation so an ongoing assessment cannot
   // switch models between routing, evaluation and validation repair.
   await client.query('LOCK TABLE jobs IN SHARE ROW EXCLUSIVE MODE');
   const active=await client.query("SELECT 1 FROM jobs WHERE body->>'status' IN ('queued','running') LIMIT 1");
   if(active.rowCount)throw new ConflictError('仍有任务运行，请完成后再切换模型。');
   await client.query("INSERT INTO app_settings(key,value) VALUES('model',$1::jsonb) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[JSON.stringify(model)]);
   await client.query('COMMIT');setSelectedModel(model);
   return {model,options:modelOptions(),policies:modelPolicies(),visionModel:visionModel()};
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 });
 app.get('/api/metrics',async req=>{requirePM(req);return metricsSnapshot();});
 app.post('/api/metrics/client',async(req,reply)=>{
  const data=z.object({metric:z.literal('preview.load'),durationMs:z.number().finite().min(0).max(3600000)}).strict().parse(req.body);
  recordMetric(data.metric,data.durationMs);return reply.code(204).send();
 });
 app.get('/api/workspace/sync',async req=>{
  const query=z.object({projectId:z.string().max(100).optional(),cursor:z.string().max(100).optional()}).strict().parse(req.query);
  const [versions,indexHtml]=await Promise.all([
   listWorkspaceProjectVersions(),
   servesWorkspace?readFile(workspaceIndex,'utf8').catch(()=>''):'',
  ]);
  const id=query.projectId||versions[0]?.id;
  if(!id)throw new Error('尚无项目');
  if(!versions.some(project=>project.id===id))throw Object.assign(new Error('项目不存在'),{statusCode:404});
  const projects=versions.map(({id,name})=>({id,name}));
  const jobs=await listJobs(id),person=participantOf(req),settings={model:config.model,modelConfigured:config.modelConfigured,knowledgeConfigured:!!config.targets.knowledge.url,teammateConfigured:!!config.targets.teammate.url,localOnly:!config.publicOrigin};
  const context=`${id}:${person.id}`,signature=digest({versions,jobs,settings});
  const state=await sync(context,signature,query.cursor,async previous=>{
   const [project,reminders]=await Promise.all([getWorkspaceProject(id,previous?.project),readReminders(versions,person.id)]);
   return {projects,project,jobs,reminders,role:person.role,participantId:person.id,config:settings};
  });
  const clientEntry=indexHtml.match(/<script\b[^>]*\bsrc="(\/assets\/[^"/]+\.js)"/)?.[1];
  return {...state,clientEntry};
 });
 app.post('/api/session',async(req,reply)=>{
  const input=z.object({role:z.enum(['pm','business']).optional(),participantId:z.enum(['pm','business','business-sales','business-operations']).optional()}).strict().refine(value=>value.role||value.participantId,'请选择参与人员').parse(req.body);
  const person=participantById(input.participantId||defaultParticipantId(input.role!))!;
  if(input.role&&input.role!==person.role)throw new Error('人员与角色不匹配');
  const options={signed:true,httpOnly:true,secure:!!config.publicOrigin,sameSite:'strict' as const,path:'/',maxAge:7*24*3600};
  reply.setCookie('role',person.role,options);reply.setCookie('participant',person.id,options);return {role:person.role,participantId:person.id};
 });
 app.get('/api/bootstrap',async(req)=>{
  const projects=await listProjects();const q=req.query as {projectId?:string};
  const project=await getProject(q.projectId||projects[0].id);
  return {projects,project,role:roleOf(req),participantId:participantOf(req).id,jobs:await listJobs(project.id),config:{model:config.model,modelConfigured:config.modelConfigured,knowledgeConfigured:!!config.targets.knowledge.url,teammateConfigured:!!config.targets.teammate.url,localOnly:!config.publicOrigin}};
 });
 app.post('/api/projects',async(req)=>{requirePM(req);const {name}=z.object({name:z.string().trim().min(1).max(100)}).parse(req.body);const p=createProject(name);p.materials=[];return insertProject(p)});
 app.post('/api/examples/crm',async req=>{requirePM(req);return insertProject(createCRMExperience())});
 app.get('/api/projects/:id',async req=>getProject(params(req).id));
 app.get('/api/projects/:id/version',async req=>{const row=(await pool.query('SELECT view_stamp AS stamp FROM projects WHERE id=$1',[params(req).id])).rows[0];if(!row)throw Object.assign(new Error('项目不存在'),{statusCode:404});return {stamp:Number(row.stamp)};});
 app.get('/api/projects/:id/events',async(req,reply)=>{
  const id=params(req).id;if(!(await pool.query('SELECT 1 FROM projects WHERE id=$1',[id])).rowCount)throw Object.assign(new Error('项目不存在'),{statusCode:404});
  if(streams.size>=128)return reply.code(503).send({error:'实时连接较多，将使用定时同步。'});
  reply.hijack();reply.raw.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','Connection':'keep-alive','X-Accel-Buffering':'no','X-Content-Type-Options':'nosniff'});
  let ended=false;const close=()=>{if(ended)return;ended=true;clearInterval(heartbeat);unwatch();streams.delete(close);reply.raw.end();};
  const write=(text:string)=>{if(!ended&&!reply.raw.write(text))close();};
  const unwatch=watchProject(id,()=>write('event: invalidate\ndata: {}\n\n'));
  const heartbeat=setInterval(()=>write(': heartbeat\n\n'),15000);heartbeat.unref();streams.add(close);reply.raw.on('close',close);write(': connected\nretry: 2000\n\n');
 });
 app.get('/api/projects/:id/history',async req=>{const p=await getProject(params(req).id);return {stamp:p.stamp,snapshots:p.snapshots,deliveries:p.deliveries,events:p.events};});
 app.get('/api/projects/:id/cards/:cardId/history',async req=>{
  const {id,cardId}=params(req),row=(await pool.query('SELECT history FROM workspace_cards WHERE project_id=$1 AND card_id=$2',[id,cardId])).rows[0];if(!row)throw Object.assign(new Error('需求不存在'),{statusCode:404});return {history:row.history||[]};
 });
 app.get('/api/projects/:id/cards/:cardId/messages',async req=>{
  const {id,cardId}=params(req);
  const q=z.object({before:z.string().max(120).optional(),limit:z.coerce.number().int().min(1).max(100).default(40)}).strict().parse(req.query);
  return messagePage(id,cardId!,q.before,q.limit);
 });
 app.get('/api/projects/:id/materials/:materialId/text',async req=>{
  const {id,materialId}=params(req),m=(await pool.query("SELECT body->>'text' AS text FROM workspace_materials WHERE project_id=$1 AND material_id=$2",[id,materialId])).rows[0];if(!m)throw new Error('材料不存在');return {text:m.text,version:digest(m.text)};
 });
 app.post('/api/projects/:id/actions',async(req,reply)=>{
  const {action,stamp}=actionRequest.parse(req.body);
  if(action.type==='message'&&req.headers.prefer==='return=minimal'){
   const id=params(req).id;await appendDiscussion(id,action,roleOf(req),participantOf(req).id,stamp);
   if(mentionsAgent(action.text))void discussion.enqueue(id,action.cardId).catch(()=>console.error('@Agent 请求未能排队，已保存讨论消息。'));
   return reply.code(204).send();
  }
  const changesDemo=['confirmProductSuggestion','adoptConclusion','applySuggestion','editCard','scope','updateOverview','saveIntake'].includes(action.type);
  const result=await mutateProject(params(req).id,p=>{applyAction(p,action as Action,roleOf(req),participantOf(req).id);if(changesDemo)reconcileDemo(p);},stamp);
  if(action.type==='message'&&mentionsAgent(action.text))await discussion.enqueue(result.project.id,action.cardId).catch(()=>console.error('@Agent 请求未能排队，已保存讨论消息。'));
  if(changesDemo&&(result.project.generatedDemo||action.type==='saveIntake'&&action.importSelected))await demos.enqueue(result.project.id,'cardId' in action?action.cardId:undefined).catch(()=>console.error('Demo 更新排队失败'));
  return req.headers.prefer==='return=minimal'?reply.code(204).send():result.project;
 });
 app.post('/api/projects/:id/group',async req=>{
  requirePM(req);if(!config.modelConfigured)throw new Error('服务端尚未配置模型密钥。');
  const {id}=params(req),project=await getProject(id);
  if(!concreteChats(project).length)throw new Error('请先保存具体需求，再进行归类。');
  const base=groupingBasis(project),job=await newJob(id,'group','根据当前需求分析模块归属');
  return runJob(job,async()=>{
   const suggestion=await suggestModuleGrouping(project);
   await mutateProject(id,current=>{
    if(groupingBasis(current)!==base)throw new ConflictError('分析期间需求或模块发生变化，请重新分析。');
    current.moduleProposal={...suggestion,id:randomUUID(),jobId:job.id,base,createdAt:new Date().toISOString()};
   });
   job.result={message:'归类方案已生成，等待产品核对后应用。'};
  });
 });
 app.post('/api/projects/:id/cards/:cardId/material-messages',async req=>{
  const {id,cardId}=params(req),person=participantOf(req),before=await getProject(id),card=before.cards.find(c=>c.id===cardId);
  const disabled=attachmentDisabledReason(before,card);if(disabled)throw new Error(disabled);
  if(!req.isMultipart())throw new Error('请选择需要发送的材料文件。');
  const fields:Record<string,string>={},files:{name:string;buffer:Buffer}[]=[];let total=0;
  for await(const part of req.parts({limits:{files:CHAT_MAX_FILES,fileSize:MAX_ARCHIVE_BYTES,fields:4,fieldSize:20000}})){
   if(part.type==='file'){
    const buffer=await part.toBuffer();total+=buffer.length;
    if(total>CHAT_MAX_BYTES)throw new Error('每次材料合计最多50 MB，请分次发送。');
    files.push({name:part.filename,buffer});
   }else{
    if(typeof part.value!=='string'||part.fieldname in fields)throw new Error('材料消息格式不正确。');
    fields[part.fieldname]=part.value;
   }
  }
  const input=z.object({text:z.string().trim().max(5000).default(''),replyTo:z.string().min(1).max(120).optional(),clientMessageId:z.string().uuid()}).strict().parse(fields);
  if(!files.length)throw new Error('请先添加材料。');
  const analyzeAttachment=async(message:Message)=>{
   if(message.materialIds?.length)await discussion.enqueue(id,cardId!).catch(()=>console.error('材料消息已保存，附件分析暂未排队，可重试。'));
  };
  const duplicate=card!.messages.find(m=>m.clientMessageId===input.clientMessageId);
  if(duplicate){if(duplicate.participantId!==person.id)throw new Error('这条材料消息属于其他参与人员。');await analyzeAttachment(duplicate);return {messageId:duplicate.id,duplicate:true};}
  const prepared:Material[]=[];let saved=false;
  try{
   for(const file of files)prepared.push(await prepareUpload(file.name,file.buffer));
   const {result}=await mutateProject(id,p=>appendMaterialMessage(p,cardId!,person.id,input,prepared));
   saved=result.created;
   if(saved)for(const material of prepared.filter(m=>m.status==='处理中')){
    try{await startMaterialProcessing(id,material)}catch(error){await markMaterialFailed(id,material.id,error)}
   }
   await analyzeAttachment(result.message);
   return {messageId:result.message.id,duplicate:!result.created};
  }finally{
   if(!saved)await Promise.all(prepared.filter(m=>m.filePath).map(m=>rm(path.join(config.dataDir,m.filePath!)).catch(()=>{})));
  }
 });
 app.post('/api/projects/:id/cards/:cardId/conversation/retry',async req=>{
  const {id,cardId}=params(req),p=await getProject(id),card=p.cards.find(c=>c.id===cardId);
  const disabled=attachmentDisabledReason(p,card);if(disabled)throw new Error(disabled);
  const {assessmentId}=z.object({assessmentId:z.string().min(1).optional()}).parse(req.body||{});
  if(!assessmentId&&!discussionRequest(p,card!,true))return {message:'请发送附件，或在文字消息中 @Agent。'};
  const materials=conversationMaterials(p,pendingAttachmentMessages(card!).flatMap(m=>m.materialIds||[]));
  for(const material of materials.filter(m=>m.status==='待解析'&&m.error&&m.filePath&&!m.archiveEntries&&(isImageFile(m.name)||isArchiveFile(m.name)))){
   const {result}=await mutateProject(id,current=>{const target=current.materials.find(m=>m.id===material.id)!;if(target.status!=='待解析')return false;target.status='处理中';delete target.error;return true;});
   if(result)try{await startMaterialProcessing(id,material)}catch(error){await markMaterialFailed(id,material.id,error)}
  }
  return await (assessmentId?discussion.resume(id,cardId!,assessmentId):discussion.enqueue(id,cardId!,true))||{message:'这轮讨论已处理，可继续补充材料或发言。'};
 });
 app.post('/api/projects/:id/materials',async req=>{
  requirePM(req);const {id}=params(req);await getProject(id);
  const materials:Material[]=[],failures:string[]=[],groupId=randomUUID();let saved=false,total=0;
  try{
   if(req.isMultipart()){
    for await(const part of req.parts({limits:{files:20,fileSize:MAX_ARCHIVE_BYTES,fields:0}})){
     if(part.type!=='file')continue;
     const buffer=await part.toBuffer();total+=buffer.length;
     if(total>50*1024*1024)throw new Error('本次文件合计超过50 MB，请分次上传。');
     try{materials.push(await prepareUpload(part.filename,buffer))}catch(error){failures.push(`${part.filename}：${publicError(error)}`)}
    }
    if(!materials.length)throw new Error(failures.join('；')||'请选择上传文件');
   }else{const body=materialRequest.parse(req.body);materials.push(textMaterial(body.name,body.text,body.kind,body.location))}
   for(const material of materials)material.intake={groupId,status:'pending'};
   await mutateProject(id,p=>{p.materials.push(...materials)});saved=true;
   for(const material of materials.filter(m=>m.status==='处理中')){
    try{await startMaterialProcessing(id,material,intake.wake)}catch(error){await markMaterialFailed(id,material.id,error)}
   }
   intake.wake(id);
   return {...await getProject(id),uploadFailures:failures};
  }finally{
   if(!saved)await Promise.all(materials.filter(m=>m.filePath).map(m=>rm(path.join(config.dataDir,m.filePath!)).catch(()=>{})));
  }
 });
 app.post('/api/projects/:id/materials/:materialId/retry',async req=>{
  requirePM(req);const {id,materialId}=params(req),p=await getProject(id),material=p.materials.find(item=>item.id===materialId);
  if(!material?.filePath||(!isImageFile(material.name)&&!isArchiveFile(material.name)))throw new Error('只有图片识别和压缩包展开任务可以重试。');
  if(material.status!=='待解析'||!material.error||material.archiveEntries||material.cardIds.length||p.intakeBatches?.some(batch=>batch.materialIds.includes(material.id)))throw new ConflictError('该材料不能重复处理，请查看当前处理结果。');
  if(isImageFile(material.name)&&!config.modelConfigured)throw new Error('服务端尚未配置模型密钥。');
  await mutateProject(id,current=>{
   const target=current.materials.find(item=>item.id===material.id)!;
   if(target.status!=='待解析'||target.archiveEntries)throw new ConflictError('材料正在处理或已有结果，请刷新。');
   target.status='处理中';delete target.error;
  });
  try{return await startMaterialProcessing(id,material,intake.wake)}catch(error){await markMaterialFailed(id,material.id,error);intake.wake(id);throw error}
 });
 app.get('/api/projects/:id/materials/:materialId/preview',async(req,reply)=>{
  const {id,materialId}=params(req),m=(await getProject(id)).materials.find(item=>item.id===materialId);
  if(!m?.filePath||!isImageFile(m.name))throw new Error('该材料不是可预览的图片。');
  const preview=await normalizeImage(await readFile(path.join(config.dataDir,m.filePath)));
  return reply.type('image/png').send(preview.buffer);
 });
 app.get('/api/projects/:id/materials/:materialId/download',async(req,reply)=>{
  const {id,materialId}=params(req);const m=(await getProject(id)).materials.find(m=>m.id===materialId);
  if(!m)throw new Error('材料不存在');
  reply.header('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(m.name)}`);
  return reply.type('application/octet-stream').send(m.filePath?await readFile(path.join(config.dataDir,m.filePath)):Buffer.from(m.text));
 });
 app.post('/api/projects/:id/extract',async req=>{
  requirePM(req);const {materialIds}=extractionRequest.parse(req.body);
  return intake.start(params(req).id,materialIds);
 });
 app.post('/api/projects/:id/refine',async req=>{
  requirePM(req);
  const {id}=params(req),{batchId,parentDraftId,revision}=refinementRequest.parse(req.body),p=await getProject(id);
  const batch=p.intakeBatches?.find(item=>item.id===batchId),parent=batch?.drafts.find(item=>item.id===parentDraftId);
  if(!batch||!parent)throw new Error('概要草稿不存在，请刷新材料箱。');
  if(p.deliveries.some(delivery=>!delivery.completedAt))throw new Error('当前 PRD 已冻结交付，请先完成本次交付后再细化概要。');
  if(batch.revision!==revision)throw new ConflictError('草稿已更新，请重新核对后细化。');
  if(parent.granularity!=='概要')throw new Error('只有概要卡可以继续细化；具体卡请直接编辑或进入沟通群。');
  if(parent.relatedCardId)throw new Error('该草稿关联已有需求，请先查看已有卡片，避免重复拆分。');
  if(!config.modelConfigured)throw new Error('服务端尚未配置模型密钥。');
  const formal=parent.poolCardId?p.cards.find(card=>card.id===parent.poolCardId):undefined;
  if(parent.poolCardId&&!formal)throw new Error('关联概要卡不存在。');
  const currentParent=formal?{...parent,title:formal.title,fields:formal.fields,coverageGaps:formal.coverageGaps||[],sourceIds:formal.sources,evidence:formal.provenance}:parent;
  const materials=p.materials.filter(material=>batch.materialIds.includes(material.id)||currentParent.sourceIds.includes(material.id));
  const siblings=batch.drafts.filter(draft=>draft.parentId===parent.id);
  const job=await newJob(id,'refine',`细化概要：${currentParent.title}`,parent.id);
  return runJob(job,async()=>{
   const candidates=await refineIntakeRequirement(currentParent,materials,p.cards,siblings);
   const {result:refined}=await mutateProject(id,current=>{
    if(formal&&current.cards.find(card=>card.id===formal.id)?.revision!==formal.revision)throw new ConflictError('概要卡在细化期间已修改，请核对最新内容后重试。');
    return attachIntakeRefinement(current,batchId,parent.id,candidates,revision);
   });
   job.result={batchId,draftId:parent.id,newDraftCount:refined.drafts.length-batch.drafts.length};
  });
 });
 // Tabs opened before this release may still request timed clarification hints.
 app.post('/api/projects/:id/cards/:cardId/clarification-help',async()=>({help:null}));
 app.post('/api/projects/:id/cards/:cardId/suggest',async req=>{
  const {id,cardId}=params(req),p=await getProject(id),card=p.cards.find(c=>c.id===cardId);
  if(!card)throw new Error('需求卡片不存在');
  const agentRunning=(await listJobs(id)).some(job=>['suggest','listen'].includes(job.kind)&&job.cardId===cardId&&['queued','running'].includes(job.status));
  const disabled=getChatDisabledReason('suggest',{project:p,card,role:roleOf(req),participantId:participantOf(req).id,agentRunning,modelConfigured:config.modelConfigured});
  if(disabled)throw new Error(disabled);
  const job=await newJob(id,'suggest','整理本卡讨论并生成建议',cardId);
  return runJob(job,async()=>{
   const suggestion=await suggestChanges(card,p.materials,p.cards,async label=>{job.label=label;await putJob(job);});
   await mutateProject(id,current=>{attachSuggestion(current,card.id,suggestion,card.revision,card.messages.length);current.cards.find(c=>c.id===card.id)!.assistantCursor=latestHumanMessage(card)?.id;});
   await demos.enqueue(id,card.id);
  });
 });
 app.post('/api/projects/:id/cards/:cardId/example-conclusion',async req=>{
  const {id,cardId}=req.params as {id:string;cardId:string};
  const {stamp}=z.object({stamp:z.number().int().nonnegative()}).strict().parse(req.body);
  const result=await mutateProject(id,p=>{const c=p.cards.find(c=>c.id===cardId);if(!c)throw new Error('需求不存在');const disabled=getChatDisabledReason('suggest',{project:p,card:c,role:roleOf(req)});if(disabled)throw new Error(disabled);applyCRMExampleConclusion(p,cardId,roleOf(req));},stamp);
  return result.project;
 });
 app.get('/api/projects/:id/jobs',async req=>listJobs(params(req).id));
 app.post('/api/projects/:id/demo/generate',async req=>{
  if(!config.modelConfigured)throw new Error('请先配置模型服务。');
  const {cardId}=z.object({cardId:z.string().max(120).optional()}).strict().parse(req.body||{});
  const p=await getProject(params(req).id);if(cardId&&!p.cards.some(c=>c.id===cardId&&c.included&&c.granularity!=='概要'))throw new Error('请选择本期具体需求。');
  const job=await demos.enqueue(p.id,cardId,true);if(!job)throw new Error('请先在材料箱保存具体需求。');return job;
 });
 app.get('/api/projects/:id/demo/view',async req=>{const q=z.object({metadata:z.enum(['1']).optional()}).strict().parse(req.query);return demoView(await getPreviewProject(params(req).id),q.metadata==='1');});
 app.get('/api/projects/:id/demo/artifacts/:artifactId/index.html',{config:{previewArtifact:true}},async(req,reply)=>{
  const {id,artifactId}=req.params as {id:string;artifactId:string};
  const p=await getArtifactProject(id),html=await demoArtifactHTML(p,artifactId),etag='"'+digest(html)+'"',trustedShell=p.generatedDemo?.revisions.some(r=>r.artifactId===artifactId&&!!r.modules);
  reply.header('Cache-Control','private, max-age=31536000, immutable').header('ETag',etag);
  if(req.headers['if-none-match']===etag)return reply.code(304).send();
  return reply.type('text/html; charset=utf-8').header('Content-Security-Policy',`sandbox allow-scripts allow-forms${trustedShell?' allow-same-origin':''}; frame-ancestors 'self'`).send(html);
 });
 app.get('/api/projects/:id/demo',async(req,reply)=>{
  const p=await getProject(params(req).id),query=z.object({cardId:z.string().max(120).optional()}).parse(req.query);
  const card=query.cardId?p.cards.find(c=>c.id===query.cardId):p.cards.find(c=>c.included);
  if(!card)throw new Error('没有可预览的需求卡片。');
  const view=await demoView(p);
  if(view.html)reply.header('Content-Security-Policy',"sandbox allow-scripts allow-forms; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; form-action 'none'");
  return reply.type('text/html; charset=utf-8').send(view.html||buildDemoHTML(p,card));
 });
 app.get('/api/projects/:id/exports/:format',async(req,reply)=>{
  const {id,format}=req.params as {id:string;format:string};
  const kind=z.enum(['docx','md','demo']).parse(format);
  const query=z.object({cardId:z.string().max(120).optional(),stamp:z.coerce.number().int().nonnegative().optional()}).parse(req.query);
  const p=await getProject(id);
  if(query.stamp!==undefined&&query.stamp!==p.stamp)throw new ConflictError('需求有新更新，请刷新后导出，以保持文档和预览一致。');
  if(query.cardId&&!p.cards.some(c=>c.id===query.cardId))throw new Error('预览需求不存在，请重新选择。');
  const extension=kind==='demo'?'zip':kind;
  const name=`${p.name}-${kind==='demo'?'原型':workspacePRD(p).formal?'PRD正式版':'PRD草稿'}.${extension}`;
  reply.header('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  if(kind==='demo'){if(!p.generatedDemo&&!p.demo&&!p.example)throw new Error('请先生成项目原型。');return reply.type('application/zip').send(p.generatedDemo?await generatedDemoZip(p):demoZip(p,query.cardId));}
  if(kind==='docx')return reply.type('application/vnd.openxmlformats-officedocument.wordprocessingml.document').send(await prdWord(p));
  return reply.type('text/markdown; charset=utf-8').send(workspacePRD(p).markdown);
 });
 app.post('/api/projects/:id/deliver',async req=>{
  requirePM(req);const {mode}=z.object({mode:z.enum(['local','http'])}).parse(req.body);
  if(mode==='http'&&(!config.targets.knowledge.url||!config.targets.teammate.url))throw new Error('知识中台与 TeamMate 的真实接收接口尚未配置。可以先下载 PRD，或使用明确标注的本地验收。');
  const {id}=params(req);await getProject(id);const job=await newJob(id,'deliver',mode==='local'?'本地验收交付（非外部平台）':'交付最终 PRD');
  return runJob(job,async()=>{
   const {project,result}=await mutateProject(id,p=>beginDelivery(p,'pm',mode));
   await performDelivery(project,result);
   const current=await getProject(id),record=current.deliveries.find(d=>d.id===result.id);
   if(record?.targets.some(t=>t.status!=='成功'))throw new Error('部分目标接收失败，请查看交付记录并重试失败目标。');
   intake.wake(id);
  });
 });
 app.get('/api/projects/:id/prd',async(req,reply)=>{
  const p=await getProject(params(req).id),v=(req.query as {version?:string}).version;
  const s=v?p.snapshots.find(s=>s.id===v)||p.deliveries.map(d=>d.snapshot).find(s=>s.id===v):undefined;
  if(v&&!s)throw new Error('历史版本不存在');
  const md=s?.markdown||buildMarkdown(p);
  reply.type('text/markdown; charset=utf-8').header('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(p.name+'-'+(s?.version||'当前草稿')+'.md')}`);return md;
 });
 if(servesWorkspace){
  await app.register(statics,{root:workspaceRoot,prefix:'/'});
  app.setNotFoundHandler((req,reply)=>req.url.startsWith('/api/')?reply.code(404).send({error:'接口不存在'}):reply.sendFile('index.html'));
 }else app.get('/',async(_,reply)=>reply.type('text/html').send('<html lang="zh-CN"><body>工作台正在构建，请稍后刷新。</body></html>'));
 return app;
}
