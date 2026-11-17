import {performance} from 'node:perf_hooks';

type Sample={name:string;durationMs:number;bytes:number;failed:boolean};
const samples:Sample[]=[];
const totals=new Map<string,{count:number;failed:number;durationMs:number;bytes:number}>();
export function recordMetric(name:string,durationMs:number,options:{bytes?:number;failed?:boolean}={}){
 const duration=Math.max(0,Number.isFinite(durationMs)?durationMs:0),bytes=Math.max(0,options.bytes||0);
 const total=totals.get(name)||{count:0,failed:0,durationMs:0,bytes:0};
 total.count++;total.failed+=options.failed?1:0;total.durationMs+=duration;total.bytes+=bytes;totals.set(name,total);
 samples.push({name,durationMs:duration,bytes,failed:!!options.failed});if(samples.length>2048)samples.shift();
}
export async function measured<T>(name:string,run:()=>Promise<T>):Promise<T>{
 const start=performance.now();let failed=false;try{return await run();}catch(error){failed=true;throw error;}finally{recordMetric(name,performance.now()-start,{failed});}
}
export function metricsSnapshot(){
 return {scope:'process',windowSamples:samples.length,series:[...totals].map(([name,total])=>{
  const times=samples.filter(s=>s.name===name).map(s=>s.durationMs).sort((a,b)=>a-b),at=(p:number)=>times.length?times[Math.max(0,Math.ceil(times.length*p)-1)]:0;
  return {name,...total,meanMs:total.durationMs/total.count,p50Ms:at(.5),p95Ms:at(.95),maxMs:times.at(-1)||0};
 })};
}
