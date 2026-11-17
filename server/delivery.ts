import {createHash} from 'node:crypto';
import {writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import {config} from './config.js';
import {mutateProject} from './store.js';
import {recordDeliveryResult} from './domain.js';
import type {Delivery,Project} from '../shared/types.js';
export async function performDelivery(project:Project,delivery:Delivery){
 for(const target of delivery.targets.filter(t=>t.status!=='成功')){
  const payload={idempotencyKey:`${delivery.id}:${target.key}`,project:{id:project.id,name:project.name},version:delivery.snapshot.version,document:{title:`${project.name} PRD`,format:'markdown',content:delivery.snapshot.markdown,sha256:createHash('sha256').update(delivery.snapshot.markdown).digest('hex')}};
  try{
   let receipt:string;
   if(delivery.mode==='local'){
    const file=path.join(config.dataDir,'receipts',target.key,delivery.id+'.json');
    try{await writeFile(file,JSON.stringify(payload,null,2),{mode:0o600,flag:'wx'})}
    catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;const old=JSON.parse(await readFile(file,'utf8'));if(old.document.sha256!==payload.document.sha256)throw new Error('本地回执内容不一致，停止覆盖。')}
    receipt=`本地验收接收成功 · ${target.key}/${delivery.id} · 非外部平台回执`;
   }else{
    const conf=config.targets[target.key];if(!conf.url)throw new Error('目标接收接口尚未配置。');
    const res=await fetch(conf.url,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':payload.idempotencyKey,...(conf.token?{Authorization:'Bearer '+conf.token}:{})},body:JSON.stringify(payload),signal:AbortSignal.timeout(30000),redirect:'error'});
    if(!res.ok)throw new Error(`目标返回 HTTP ${res.status}，本版本仍待交付。`);
    const response=await res.json() as {accepted?:boolean;receiptId?:string};
    if(response.accepted!==true||typeof response.receiptId!=='string'||!response.receiptId)throw new Error('目标未返回约定的 accepted=true 与 receiptId，无法确认接收成功。');
    receipt=response.receiptId.slice(0,300);
   }
   await mutateProject(project.id,p=>recordDeliveryResult(p,delivery.id,target.key,{ok:true,receipt}));
  }catch(e){
   const raw=e instanceof Error?e.message:'';
   const error=/目标|本地回执/.test(raw)?raw:'连接或回执读取失败，请检查接收接口后重试。';
   await mutateProject(project.id,p=>recordDeliveryResult(p,delivery.id,target.key,{ok:false,error}));
  }
 }
}
