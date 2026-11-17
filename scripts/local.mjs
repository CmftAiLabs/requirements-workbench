import {spawn,spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,existsSync,mkdirSync,openSync,unlinkSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import 'dotenv/config';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');process.chdir(root);
const dir=path.join(root,'data');mkdirSync(dir,{recursive:true,mode:0o700});
const pidFile=path.join(dir,'server.pid'),port=Number(process.env.PORT||4318),url=`http://127.0.0.1:${port}`;
const healthy=async()=>{try{const r=await fetch(url+'/api/health',{signal:AbortSignal.timeout(1500)});return r.ok&&(await r.json()).service==='requirements-workbench'}catch{return false}};
const cmd=process.argv[2]||'start';
if(cmd==='stop'){
 if(existsSync(pidFile)){
  const pid=Number(readFileSync(pidFile,'utf8'));
  const args=spawnSync('ps',['-p',String(pid),'-o','args='],{encoding:'utf8'}).stdout||'';
  if(args.includes(path.join(root,'server/index.ts')))process.kill(pid,'SIGTERM');
  unlinkSync(pidFile);
 }
 console.log('本工作台服务已停止；数据库与项目资料保留。');
}else{
 if(await healthy()){console.log(`工作台已运行：${url}`);process.exit(0)}
 const docker=spawnSync('docker',['compose','up','-d','--wait','db'],{cwd:root,stdio:'inherit'});if(docker.status!==0)process.exit(docker.status||1);
 if(!existsSync(path.join(root,'dist/index.html'))){const b=spawnSync('pnpm',['build'],{cwd:root,stdio:'inherit'});if(b.status!==0)process.exit(b.status||1)}
 const log=openSync(path.join(dir,'server.log'),'a',0o600);
 const child=spawn(process.execPath,[path.join(root,'node_modules/tsx/dist/cli.mjs'),path.join(root,'server/index.ts')],{cwd:root,detached:true,stdio:['ignore',log,log],env:process.env});
 writeFileSync(pidFile,String(child.pid),{mode:0o600});child.unref();
 for(let i=0;i<30;i++){await new Promise(r=>setTimeout(r,1000));if(await healthy()){console.log(`工作台已启动：${url}`);process.exit(0)}}
 console.error('启动未完成，请查看 data/server.log（不包含密钥）。');process.exitCode=1;
}
