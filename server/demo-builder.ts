import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile,chmod} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {config} from './config.ts';
import type {DemoCodeProposal,DemoRevision,DemoView} from '../shared/generated-demo.ts';
import type {Project} from '../shared/types.ts';
import {demoInputKey,demoBasisKey,isDemoDraft,usableDemo,digest} from './demo-schema.ts';
import {zipSync,strToU8} from 'fflate';
import {workspacePRD} from './workspace-export.ts';
import {moduleShell} from '../shared/prototype-shell';

export class DemoBindingCheckError extends Error {
 constructor(message:string,readonly bindingIndex:number){super(message);this.name='DemoBindingCheckError';}
}

export function artifactDir(projectId:string,artifactId:string){
 if(!/^[a-zA-Z0-9-]+$/.test(projectId)||!/^[a-zA-Z0-9-]+$/.test(artifactId))throw new Error('无效的原型版本');
 return path.join(config.dataDir,'demos',projectId,artifactId);
}
function docker(args:string[],timeout=180000){return new Promise<string>((resolve,reject)=>{
 const child=spawn('docker',args,{stdio:['ignore','pipe','pipe']});let output='';
 const append=(data:Buffer)=>{output=(output+data.toString()).slice(-10000);};child.stdout.on('data',append);child.stderr.on('data',append);
 const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('原型构建或交互检查超时'));},timeout);
 child.on('error',()=>{clearTimeout(timer);reject(new Error('原型构建器无法启动，请检查本地 Docker。'));});
 child.on('close',code=>{clearTimeout(timer);code===0?resolve(output):reject(new Error(output||'原型构建器未完成'));});
});}
const runnerImage=()=>process.env.DEMO_RUNNER_IMAGE||'requirements-demo-runner:1';
export async function ensureDemoBuilder(){
 try{await docker(['image','inspect','--format','{{.Id}}',runnerImage()],15000);}
 catch{throw new Error('原型构建器尚未就绪。请启动 Docker，并先运行 pnpm demo:setup。');}
}
export async function readDemoSource(projectId:string,revision?:Pick<DemoRevision,'artifactId'>):Promise<Record<string,string>>{
 if(!revision)return {};
 return JSON.parse(await readFile(path.join(artifactDir(projectId,revision.artifactId),'sources.json'),'utf8'));
}
export type DemoBuildReport={build:boolean;checks:{name:string;passed:boolean}[];errors:string[];sourceHash?:string;htmlHash?:string;timings?:{buildMs:number;checkMs:number;totalMs:number}};
export async function buildAndCheck(projectId:string,artifactId:string,files:Record<string,string>,proposal:DemoCodeProposal){return runArtifact(projectId,artifactId,files,proposal,'full');}
export async function buildPreview(projectId:string,artifactId:string,files:Record<string,string>,proposal:DemoCodeProposal){return runArtifact(projectId,artifactId,files,proposal,'preview');}
export async function readDemoProposal(projectId:string,artifactId:string):Promise<DemoCodeProposal>{
 const dir=artifactDir(projectId,artifactId),proposal=JSON.parse(await readFile(path.join(dir,'proposal.json'),'utf8'));
 try{const spec=JSON.parse(await readFile(path.join(dir,'verification-spec.json'),'utf8'));return {...proposal,checks:spec.checks};}catch{return proposal;}
}
export async function verifyArtifact(projectId:string,artifactId:string){
 const dir=artifactDir(projectId,artifactId),files=await readDemoSource(projectId,{artifactId}),proposal=await readDemoProposal(projectId,artifactId);
 await writeFile(path.join(dir,'input/spec.json'),JSON.stringify({viewport:proposal.viewport,bindings:proposal.bindings,checks:proposal.checks}));
 return runArtifact(projectId,artifactId,files,proposal,'verify');
}
async function runArtifact(projectId:string,artifactId:string,files:Record<string,string>,proposal:DemoCodeProposal,mode:'full'|'preview'|'verify'):Promise<DemoBuildReport>{
 const dir=artifactDir(projectId,artifactId),input=path.join(dir,'input'),output=path.join(dir,'output');
 const reportPath=path.join(output,mode==='preview'?'preview-report.json':'report.json');
 if(mode!=='verify'){
 await mkdir(output,{recursive:true});await chmod(output,0o777);
 for(const [file,content] of Object.entries(files)){const destination=path.join(input,file);await mkdir(path.dirname(destination),{recursive:true});await writeFile(destination,content);}
 await writeFile(path.join(input,'spec.json'),JSON.stringify({viewport:proposal.viewport,bindings:proposal.bindings,checks:proposal.checks}));
 await writeFile(path.join(dir,'sources.json'),JSON.stringify(files));await writeFile(path.join(dir,'proposal.json'),JSON.stringify(proposal));
 }
 const name='requirements-demo-'+randomUUID();
 try{
  await docker(['run','--rm','--init','--name',name,'--network','none','--cap-drop','ALL','--security-opt','no-new-privileges','--memory','1024m','--cpus','2','--pids-limit','180','--read-only','--tmpfs','/tmp:rw,size=512m','--tmpfs','/work:rw,size=128m,uid=1000,gid=1000','--mount',`type=bind,source=${input},target=/input,readonly`,'--mount',`type=bind,source=${output},target=/output`,runnerImage(),mode]);
 }catch(error){
  let reason='',bindingFailure:DemoBindingCheckError|undefined;
  try{const report=JSON.parse(await readFile(reportPath,'utf8'));reason=report.errors?.join('\n')||'';
   const index=Array.isArray(report.bindings)?report.bindings.length:-1,target=proposal.bindings[index];
   if(report.build&&index>=0&&target&&report.checks?.length===0&&reason.includes('getByTestId(')&&[target.testId,target.navigationTestId].some(id=>id&&reason.includes(id)))bindingFailure=new DemoBindingCheckError(reason,index);
  }catch{}
  if(!reason&&String(error).includes('Unable to find image'))reason='请先运行 pnpm demo:setup 准备本地 原型构建器。';
  throw bindingFailure||new Error((reason||String(error)).slice(0,5000));
 }finally{await docker(['rm','-f',name],10000).catch(()=>{});}
 const report=JSON.parse(await readFile(reportPath,'utf8'));
 if(!report.build||report.errors.length||report.checks.some((c:{passed:boolean})=>!c.passed))throw new Error('原型未通过交互检查');
 report.sourceHash=digest(files);report.htmlHash=digest(await readFile(path.join(output,'index.html'),'utf8'));await writeFile(reportPath,JSON.stringify(report,null,2));
 return report as DemoBuildReport;
}
const safeJSON=(v:unknown)=>JSON.stringify(v).replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
export function bridge(payload:{projectId:string;bindings:DemoRevision['bindings']}){
 const get=(id:string)=>document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
 let pending:{cardId:string;field?:string}|undefined;
 const locate=()=>{
  if(!pending)return;
  const options=payload.bindings.filter(b=>b.cardId===pending!.cardId),b=options.find(b=>b.field===pending!.field)||options[0];if(!b)return;
  const target=get(b.testId);
  if(!target||!target.getClientRects().length){if(b.navigationTestId)get(b.navigationTestId)?.click();return;}
  document.querySelectorAll('.wb-demo-focus').forEach(el=>el.classList.remove('wb-demo-focus'));target.classList.add('wb-demo-focus');target.scrollIntoView({block:'nearest',behavior:'smooth'});pending=undefined;
 };
 const style=document.createElement('style');style.textContent='.wb-demo-focus{outline:2px solid #78a9ec!important;outline-offset:3px;scroll-margin:12px}';document.head.append(style);
 window.addEventListener('message',event=>{
  if(event.source!==window.parent||event.data?.channel!=='requirements-workbench'||event.data?.type!=='locate'||event.data?.projectId!==payload.projectId)return;
  if(!payload.bindings.some(b=>b.cardId===event.data.cardId))return;
  pending={cardId:event.data.cardId,field:event.data.field};locate();
 });
 new MutationObserver(()=>locate()).observe(document.body,{subtree:true,childList:true});
 document.addEventListener('click',event=>{
  if(!event.isTrusted)return;
  let el=event.target as HTMLElement|null;
  while(el){const bindings=payload.bindings.filter(b=>b.testId===el!.dataset?.testid);if(bindings.length){window.parent.postMessage({channel:'requirements-demo',type:'trace',projectId:payload.projectId,cardIds:[...new Set(bindings.map(b=>b.cardId))],field:bindings[0].field},'*');return;}el=el.parentElement;}
 });
}
export async function generatedHTML(p:Project,r:DemoRevision){
 if(r.modules)return moduleShell(p.id,r.modules.map(m=>({id:m.id,name:m.name,cardIds:m.cardIds,url:`/api/projects/${p.id}/demo/artifacts/${m.artifactId}/index.html`})));
 const html=await readFile(path.join(artifactDir(p.id,r.artifactId),'output/index.html'),'utf8');
 return html.replace('</body>',`<script>{const __name=(fn)=>fn;(${bridge.toString()})(${safeJSON({projectId:p.id,bindings:r.bindings})});}</script></body>`);
}
export async function demoArtifactHTML(p:Project,artifactId:string){
 const revisions=p.generatedDemo?.revisions.slice().reverse()||[],root=revisions.find(r=>r.artifactId===artifactId);
 if(root)return generatedHTML(p,root);
 for(const r of revisions){const module=r.modules?.find(m=>m.artifactId===artifactId);if(module){
  const html=await readFile(path.join(artifactDir(p.id,artifactId),'output/index.html'),'utf8');
  return html.replace('</body>',`<script>{const __name=(fn)=>fn;(${bridge.toString()})(${safeJSON({projectId:p.id,bindings:r.bindings.filter(b=>module.cardIds.includes(b.cardId))})});}</script></body>`);
 }}
 throw Object.assign(new Error('原型产物不存在'),{statusCode:404});
}
export async function demoView(p:Project,metadataOnly=false):Promise<DemoView>{
 const revision=usableDemo(p);if(!revision)return {html:'',stale:false,draft:false,status:'根据本项目需求生成可交互原型'};
 const stale=revision.inputKey!==demoInputKey(p)||(revision.draft&&revision.basisKey!==demoBasisKey(p));
 const draft=isDemoDraft(p);
 return {html:metadataOnly?'':await generatedHTML(p,revision),url:`/api/projects/${p.id}/demo/artifacts/${revision.artifactId}/index.html${revision.modules?'?shell=2':''}`,revision,stale,draft,status:stale?'上次可用原型 · 尚未同步当前需求':draft?'Agent 生成草稿 · 尚未采纳':'已同步当前需求'};
}
export async function generatedDemoZip(p:Project){
 const view=await demoView(p);if(!view.revision)throw new Error('请先生成项目原型。');
 if(view.stale)throw new Error('当前原型 尚未同步需求，请更新原型后再导出。');
 const r=view.revision,source=await readDemoSource(p.id,r),files:Record<string,Uint8Array>={'index.html':strToU8(view.html),'requirements.json':strToU8(JSON.stringify({project:p.name,revision:r,draft:view.draft},null,2)),'PRD.md':strToU8(workspacePRD(p).markdown)};
 if(r.modules){
  files['index.html']=strToU8(moduleShell(p.id,r.modules.map(m=>({id:m.id,name:m.name,cardIds:m.cardIds,url:`modules/${m.id}.html`}))));
  for(const module of r.modules)files[`modules/${module.id}.html`]=strToU8(await demoArtifactHTML(p,module.artifactId));
  for(const [name,content] of Object.entries(source))files[name]=strToU8(content);
  files['verification.json']=strToU8(JSON.stringify(r.verification||{status:'passed',passed:r.checksPassed},null,2));
  files['prototype-modules.json']=strToU8(JSON.stringify(r.modules,null,2));
  files['package.json']=strToU8(JSON.stringify({name:'modular-project-prototype',private:true,type:'module',scripts:{dev:'vite --host 127.0.0.1',build:'node build.mjs'},dependencies:{react:'19.3.1','react-dom':'19.3.1',vite:'8.3.5',typescript:'5.9.3'}},null,2));
  files['build.mjs']=strToU8(`import {build} from 'vite';import {readFile,writeFile,mkdir,rm} from 'node:fs/promises';import path from 'node:path';
const modules=JSON.parse(await readFile('prototype-modules.json','utf8'));
try{for(const m of modules){const dir='modules/'+m.id;await writeFile(dir+'/entry.tsx',"import React from 'react';import{createRoot}from'react-dom/client';import App from './src/App';import './src/styles.css';createRoot(document.getElementById('root')).render(<App/>);");const out=path.resolve('.prototype-build',m.id);await build({configFile:false,root:process.cwd(),publicDir:false,define:{'process.env.NODE_ENV':JSON.stringify('production')},build:{outDir:out,emptyOutDir:true,minify:true,cssCodeSplit:false,lib:{entry:path.resolve(dir,'entry.tsx'),name:'Prototype',formats:['iife'],cssFileName:'style',fileName:()=> 'app.js'}}});const js=await readFile(out+'/app.js','utf8');let css='';try{css=await readFile(out+'/style.css','utf8')}catch{}let html=await readFile(dir+'.html','utf8');html=html.replace(/<script>[\\s\\S]*?<\\/script>/,()=>'<script>'+js.replace(/<\\/script/gi,'<\\\\/script')+'</script>').replace(/<style>[\\s\\S]*?<\\/style>/,()=>'<style>html,body{margin:0;font-family:system-ui}*{box-sizing:border-box}'+css.replace(/<\\/style/gi,'<\\\\/style')+'</style>');await writeFile(dir+'.html',html);}}finally{await rm('.prototype-build',{recursive:true,force:true});}
`);
  files['README.md']=strToU8(`# ${p.name} · 模块化原型\n\n直接打开 index.html。模块按需加载，使用内存模拟数据，刷新后重置。\n\n源码位于 modules/<模块ID>/src。npm install 后运行 npm run build 重建各模块，再运行 npm run dev 打开本地预览。此构建只编译源码，平台的交互检查记录见 verification.json。可操作预览与完整检查分开，pending / needs-attention 不是全部通过；本包不代表正式系统通过研发测试。\n\n${view.draft?'包含尚未采纳的建议；PRD.md 保留正式正文。':'对应已保存的需求，确认状态见 PRD.md。'}\n`);
  return Buffer.from(zipSync(files));
 }
 for(const [name,content] of Object.entries(source))files[name]=strToU8(content);
 files['package.json']=strToU8(JSON.stringify({name:'generated-project-demo',private:true,type:'module',scripts:{dev:'vite',build:'vite build'},dependencies:{react:'19.3.1','react-dom':'19.3.1',vite:'8.3.5',typescript:'5.9.3'}},null,2));
 files['main.tsx']=strToU8("import React from 'react';import{createRoot}from'react-dom/client';import App from './src/App';import './src/styles.css';createRoot(document.getElementById('root')!).render(<App/>);");
 files['source.html']=strToU8('<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/main.tsx"></script></body></html>');
 files['vite.config.ts']=strToU8("import{defineConfig}from'vite';export default defineConfig({base:'./',build:{rolldownOptions:{input:'source.html'}}});");
 files['README.md']=strToU8(`# ${p.name} · 原型代码\n\n直接打开 index.html 运行原型，使用模拟数据，不连接真实系统。\n\n修改源码：npm install 后 npm run dev，打开 /source.html。npm run build 重新构建。\n\n原型修订 ${r.number}，${view.draft?'含尚未采纳的建议草稿；PRD.md 保留正式卡片正文，二者尚未一致。':'对应当前已保存需求，需求确认与评审状态见 PRD。'}\n\n本轮变化：${r.summary}\n\n原型假设：\n${r.assumptions.map(a=>'- '+a).join('\n')}\n`);
 return Buffer.from(zipSync(files));
}
