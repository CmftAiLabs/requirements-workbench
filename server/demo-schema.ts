import {z} from 'zod';
import {FIELDS,type Project} from '../shared/types.ts';
import {liveSuggestion,previewFields} from '../shared/crm-demo.ts';
import {createHash} from 'node:crypto';
import type {DemoCodeProposal,DemoRevision} from '../shared/generated-demo.ts';
import {validDemoViewport} from '../shared/demo-viewport';

const sourcePath=z.string().regex(/^src\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.(?:tsx?|css|json)$/);
const testId=z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,99}$/);
export const demoCodeSchema=z.object({
 dependencies:z.array(z.string().regex(/^module-[a-f0-9]{16}$/)).max(128).optional(),
 viewport:z.object({width:z.number().int().min(320).max(2560),height:z.number().int().min(320).max(1600)}).strict().refine(validDemoViewport,'原型视口宽高比例应在 0.3 至 3 之间').optional(),
 summary:z.string().min(1).max(1500),files:z.array(z.object({path:sourcePath,content:z.string().max(100000)}).strict()).max(24),deletePaths:z.array(sourcePath).max(24).default([]),
 edits:z.array(z.object({path:sourcePath,search:z.string().min(1).max(40000),replace:z.string().max(60000)}).strict()).max(30).default([]),
 bindings:z.array(z.object({cardId:z.string(),testId,field:z.enum(FIELDS.map(([k])=>k) as [string,...string[]]),navigationTestId:testId.optional()}).strict()).min(1).max(100),
 checks:z.array(z.object({name:z.string().min(1).max(160),cardIds:z.array(z.string()).min(1).max(20),steps:z.array(z.object({action:z.enum(['click','fill','select','check','uncheck','expectDisabled','expectEnabled','expectText','expectValue','expectCount','expectVisible']),testId,value:z.string().max(1000).optional(),repeat:z.number().int().min(1).max(1000).optional(),count:z.number().int().min(0).max(1000).optional()}).strict()).min(2).max(24)}).strict()).min(1).max(12),
 assumptions:z.array(z.string().max(600)).max(30),
}).strict();
export const digest=(value:unknown)=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item)).digest('hex');
export function demoOverviews(p:Project){return p.cards.filter(c=>c.included&&c.granularity==='概要').map(c=>({id:c.id,parentId:c.parentId||null,title:c.title,fields:c.fields,coverageGaps:c.coverageGaps||[]})).sort((a,b)=>a.id.localeCompare(b.id));}
export function demoInput(p:Project){return {project:p.name,reference:p.demo||null,overviews:demoOverviews(p),cards:p.cards.filter(c=>c.included&&c.granularity!=='概要').map(c=>({id:c.id,parentId:c.parentId||null,title:c.title,module:c.organization?.module||'',fields:previewFields(c)})).sort((a,b)=>a.id.localeCompare(b.id))};}
export const demoInputKey=(p:Project)=>digest(demoInput(p));
export const demoBasisKey=(p:Project)=>digest({input:demoInput(p),cards:p.cards.map(c=>({id:c.id,revision:c.revision,messages:c.messageCount??c.messages.length,suggestion:liveSuggestion(c)?.id||null,included:c.included}))});
export const isDemoDraft=(p:Project)=>p.cards.some(c=>c.included&&c.granularity!=='概要'&&!!liveSuggestion(c));
export function currentDemo(p:Project):DemoRevision|undefined{return p.generatedDemo?.revisions.find(r=>r.id===p.generatedDemo?.currentId);}
export function usableDemo(p:Project):DemoRevision|undefined{
 const key=demoInputKey(p),basis=demoBasisKey(p);
 return p.generatedDemo?.revisions.slice().reverse().find(r=>r.inputKey===key&&(!r.draft||r.basisKey===basis))||currentDemo(p);
}
export interface DemoFileConflict {path:string;operations:('replace'|'delete'|'edit')[]}
export class DemoFileOperationConflictError extends Error {
 constructor(readonly conflicts:DemoFileConflict[]){
  const labels={replace:'整文件替换',delete:'删除',edit:'局部修改'};
  super('同一文件不能同时整文件替换、删除与局部修改：'+conflicts.map(c=>`${c.path}（${c.operations.map(op=>labels[op]).join('、')}）`).join('；'));
  this.name='DemoFileOperationConflictError';
 }
}
export function validateDemoProposal(raw:unknown,p:Project,previous:Record<string,string>={}){
 const parsed=demoCodeSchema.parse(raw);
 for(const check of parsed.checks)for(const step of check.steps)if(step.repeat!==undefined){
  if(!['fill','expectValue'].includes(step.action)||step.value?.length!==1)throw new Error('repeat 仅用于 fill 或 expectValue，value 必须为单个字符');
  step.value=step.value.repeat(step.repeat);delete step.repeat;
 }
 const proposal=parsed as DemoCodeProposal;
 const paths=proposal.files.map(f=>f.path);
 if(new Set(paths).size!==paths.length||new Set(proposal.deletePaths).size!==proposal.deletePaths.length)throw new Error('文件路径重复');
 const operations=new Map<string,Set<DemoFileConflict['operations'][number]>>();
 const add=(path:string,operation:DemoFileConflict['operations'][number])=>{if(!operations.has(path))operations.set(path,new Set());operations.get(path)!.add(operation);};
 proposal.files.forEach(file=>add(file.path,'replace'));proposal.deletePaths.forEach(path=>add(path,'delete'));proposal.edits?.forEach(edit=>add(edit.path,'edit'));
 const conflicts=[...operations].filter(([,ops])=>ops.size>1).map(([path,ops])=>({path,operations:[...ops]}));
 if(conflicts.length)throw new DemoFileOperationConflictError(conflicts);
 const files={...previous};for(const file of proposal.deletePaths)delete files[file];for(const file of proposal.files)files[file.path]=file.content;
 for(const edit of proposal.edits||[]){const source=files[edit.path];if(source===undefined||!source.includes(edit.search)||source.indexOf(edit.search)!==source.lastIndexOf(edit.search))throw new Error('局部修改的原文必须在现有文件中唯一匹配：'+edit.path);files[edit.path]=source.replace(edit.search,()=>edit.replace);}
 if(!files['src/App.tsx']||!files['src/styles.css'])throw new Error('必须提供 src/App.tsx 和 src/styles.css');
 if(Object.keys(files).length>30||Object.values(files).join('').length>240000)throw new Error('Demo 源码过大，请保持精简');
 const ids=new Set(demoInput(p).cards.map(c=>c.id));
 if(proposal.bindings.some(b=>!ids.has(b.cardId))||proposal.checks.some(c=>c.cardIds.some(id=>!ids.has(id))))throw new Error('只能关联本项目本期具体需求');
 if([...ids].some(id=>!proposal.bindings.some(b=>b.cardId===id)))throw new Error('每个本期具体需求都必须有页面定位');
 if(proposal.checks.some(c=>!c.steps.some(s=>['click','fill','select','check','uncheck'].includes(s.action))||!c.steps.some(s=>s.action.startsWith('expect'))))throw new Error('交互检查必须包含操作和结果断言');
 for(const check of proposal.checks)for(const step of check.steps){
  if(['fill','select','expectText','expectValue'].includes(step.action)&&step.value===undefined)throw new Error('检查步骤缺少 value');
  if(step.action==='expectCount'&&step.count===undefined)throw new Error('检查步骤缺少 count');
 }
 return {proposal,files};
}
