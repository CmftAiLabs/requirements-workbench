import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,chmod,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {unzipSync} from 'fflate';
import {createCRMExperience} from '../server/experience';
import {buildModularDemo} from '../server/demo-modules';
import {artifactDir,demoArtifactHTML,generatedDemoZip} from '../server/demo-builder';
import {validateDemoProposal,demoInputKey,demoBasisKey} from '../server/demo-schema';
import {appendDemo} from '../server/demo-jobs';
import type {generateDemoCode} from '../server/demo-generator';
import {config} from '../server/config';

const p=createCRMExperience();p.id='runner-modular-'+randomUUID();p.cards=p.cards.filter(c=>c.included);p.cards.forEach((c,i)=>c.organization={module:i?'第二模块':'第一模块',priority:'正常沟通',reason:'合成验证'});
const dir=path.resolve('.work/scaling/modular-runner');await mkdir(path.join(dir,'export'),{recursive:true});await chmod(dir,0o777);let calls=0;
const generate:typeof generateDemoCode=async(project,previous,_failure,_progress,context)=>{
 assert.ok(context);calls++;
 return validateDemoProposal({summary:'共享计数与模块切换',dependencies:[],viewport:context.viewport,files:[{path:'src/App.tsx',content:`import React from 'react';import {usePrototypeState} from './prototype-state';export default function App(){const [n,setN]=usePrototypeState<number>('shared.count',0);return <main><h1>${context.name}</h1><p data-testid="result">{n}</p><button data-testid="increment" onClick={()=>setN(n+1)}>增加</button></main>}`},{path:'src/styles.css',content:'body{padding:24px;color:#27486b}button{padding:10px}'}],bindings:[{cardId:project.cards[0].id,testId:'increment',field:'flow'}],checks:[{name:'点击增加',cardIds:[project.cards[0].id],steps:[{action:'click',testId:'increment'},{action:'expectText',testId:'result',value:'1'}]}],assumptions:['共享计数为合成验证数据']},project,previous);
};
try{
 const first=await buildModularDemo(p,undefined,{guard:async()=>{},progress:async()=>{},generate});appendDemo(p,{...first,id:randomUUID(),number:1,createdAt:new Date().toISOString(),inputKey:demoInputKey(p),basisKey:demoBasisKey(p),draft:false,cardIds:p.cards.map(c=>c.id),model:'local-fixture'});
 p.cards[0].fields.acceptance+=' 核对变化';const second=await buildModularDemo(p,p.generatedDemo!.revisions[0],{guard:async()=>{},progress:async()=>{},generate});assert.equal(calls,3);assert.equal(second.reused,1);assert.equal(second.modules[1].artifactId,first.modules[1].artifactId);
 appendDemo(p,{...second,id:randomUUID(),number:2,createdAt:new Date().toISOString(),inputKey:demoInputKey(p),basisKey:demoBasisKey(p),draft:false,cardIds:p.cards.map(c=>c.id),model:'local-fixture'});
 const routes:Record<string,string>={'/':'root.html'};await writeFile(path.join(dir,'root.html'),await demoArtifactHTML(p,second.artifactId));
 for(const module of second.modules){const url=`/api/projects/${p.id}/demo/artifacts/${module.artifactId}/index.html`;routes[url]=module.id+'.html';await writeFile(path.join(dir,module.id+'.html'),await demoArtifactHTML(p,module.artifactId));}
 const archive=unzipSync(new Uint8Array(await generatedDemoZip(p)));for(const [name,bytes]of Object.entries(archive)){const file=path.join(dir,'export',name);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,bytes);}
 await writeFile(path.join(dir,'manifest.json'),JSON.stringify({routes,secondUrl:Object.keys(routes).at(-1),firstId:second.modules[0].id}));
 const result=await new Promise<number|null>((resolve,reject)=>{const child=spawn('docker',['run','--rm','--init','--network','none','--cap-drop','ALL','--security-opt','no-new-privileges','--memory','1024m','--cpus','2','--pids-limit','180','--read-only','--tmpfs','/tmp:rw,size=512m','--tmpfs','/work:rw,size=256m,uid=1000,gid=1000','--mount',`type=bind,source=${dir},target=/input,readonly`,'--mount',`type=bind,source=${dir},target=/output`,'--mount',`type=bind,source=${path.resolve('scripts/demo-runner/check-modules.mjs')},target=/opt/runner/check-modules.mjs,readonly`,'--entrypoint','node','requirements-demo-runner:1','/opt/runner/check-modules.mjs'],{stdio:'inherit'});child.on('error',reject);child.on('close',resolve);});assert.equal(result,0);
 console.log(JSON.stringify({modelCalls:0,localModuleGenerations:calls,unchangedModuleReused:true,report:path.join(dir,'modular-report.json')}));
}finally{await rm(path.join(config.dataDir,'demos',p.id),{recursive:true,force:true});}
