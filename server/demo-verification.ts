import {readFile,writeFile,rename} from 'node:fs/promises';
import path from 'node:path';
import type {DemoRevision,DemoVerification} from '../shared/generated-demo';
import {artifactDir,verifyArtifact,readDemoSource,readDemoProposal,type DemoBuildReport} from './demo-builder';
import {digest} from './demo-schema';
import {recordMetric} from './metrics';
import {generateDemoChecks} from './demo-check-generator';

let verificationTail:Promise<unknown>=Promise.resolve();
const inSlot=<T>(run:()=>Promise<T>)=>{const next=verificationTail.then(run,run);verificationTail=next.catch(()=>{});return next;};

type Candidate=Pick<DemoRevision,'artifactId'|'modules'|'sourceHash'|'verification'>;
/** The published code is immutable. Background checks annotate it, never rewrite it. */
export async function verifyModularDemo(projectId:string,candidate:Candidate,verify=verifyArtifact):Promise<DemoVerification>{
 const start=performance.now(),startedAt=candidate.verification?.startedAt||new Date().toISOString();
 const errors:string[]=[],reports:DemoBuildReport[]=[];let total=0;
 for(const module of candidate.modules||[]){
  const dir=artifactDir(projectId,module.artifactId);
  try{
   const files=await readDemoSource(projectId,module),html=await readFile(path.join(dir,'output/index.html'),'utf8');
   if(digest(files)!==module.sourceHash)throw Error('原型源码与发布版本不一致');
   let proposal=await readDemoProposal(projectId,module.artifactId);
   let context:{project:import('../shared/types').Project;common:unknown[]}|undefined;
   try{context=JSON.parse(await readFile(path.join(dir,'verification-context.json'),'utf8'));}catch{}
   if(context){
    const prepared=await readFile(path.join(dir,'verification-spec.json'),'utf8').then(raw=>{const spec=JSON.parse(raw);return Array.isArray(spec.checks)?spec:undefined;}).catch(()=>undefined);
    if(!prepared){const checks=await inSlot(()=>generateDemoChecks(context!.project,files,proposal,context!.common));await writeFile(path.join(dir,'verification-spec.tmp'),JSON.stringify({checks}));await rename(path.join(dir,'verification-spec.tmp'),path.join(dir,'verification-spec.json'));proposal={...proposal,checks};}
   }
   total+=proposal.checks.length;
   let report:DemoBuildReport|undefined;
   try{const cached:DemoBuildReport=JSON.parse(await readFile(path.join(dir,'output/report.json'),'utf8'));if(cached.build&&cached.sourceHash===module.sourceHash&&cached.htmlHash===digest(html)&&!cached.errors.length&&cached.checks.length===proposal.checks.length&&cached.checks.every((c,i)=>c.passed&&c.name===proposal.checks[i].name))report=cached;}catch{}
   if(!report){
    try{report=await inSlot(()=>verify(projectId,module.artifactId));}catch(error){
     try{report=JSON.parse(await readFile(path.join(dir,'output/report.json'),'utf8'));}catch{}
     if(!report?.errors.length)throw error;
    }
   }
   if(!report)throw Error('没有获得交互检查结果');
   reports.push(report);errors.push(...report.errors.map(error=>`${module.name}：${error}`));
  }catch(error){errors.push(`${module.name}：${error instanceof Error?error.message:String(error)}`);}
 }
 const checks=reports.flatMap(r=>r.checks),passed=checks.filter(c=>c.passed).length;
 const result:DemoVerification={status:!errors.length&&passed===total?'passed':'needs-attention',total,passed,startedAt,finishedAt:new Date().toISOString(),durationMs:performance.now()-start,errors};
 await writeFile(path.join(artifactDir(projectId,candidate.artifactId),'output/verification.json'),JSON.stringify(result,null,2));
 recordMetric('demo.background.check',performance.now()-start,{failed:result.status!=='passed'});
 return result;
}

/** Match immutable artifacts, including a human-adopted alias, never the current pointer alone. */
export function applyDemoVerification(revisions:DemoRevision[],candidate:Candidate,result:DemoVerification){
 for(const revision of revisions)if(revision.artifactId===candidate.artifactId&&revision.sourceHash===candidate.sourceHash){revision.verification=result;revision.checksPassed=result.passed;}
}
