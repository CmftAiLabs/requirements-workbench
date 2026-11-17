import assert from 'node:assert/strict';
import {readFile,writeFile,cp,symlink} from 'node:fs/promises';
import {createServer} from 'node:http';
import {chromium} from 'playwright-core';
const manifest=JSON.parse(await readFile('/input/manifest.json','utf8')),requests=[];
const routes=new Map(Object.entries(manifest.routes));
const server=createServer(async(req,res)=>{
 requests.push(req.url);const file=routes.get(req.url);if(!file){res.writeHead(404);res.end();return;}
 res.writeHead(200,{'content-type':'text/html','cache-control':'private, max-age=31536000, immutable','content-security-policy':`sandbox allow-scripts allow-forms${req.url==='/'?' allow-same-origin':''}; frame-ancestors 'self'`});res.end(await readFile('/input/'+file));
});
await new Promise(r=>server.listen(4318,'127.0.0.1',r));
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--disable-software-rasterizer','--in-process-gpu','--no-zygote']});
try{
 const page=await browser.newPage({viewport:{width:1280,height:800}}),errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(6000);
 await page.goto('http://127.0.0.1:4318/');const child=()=>page.frameLocator('#module');await child().getByTestId('result').waitFor();
 assert.ok(!requests.some(url=>url===manifest.secondUrl),'Inactive module must not be downloaded');
 await child().getByTestId('increment').click();await child().getByTestId('result').filter({hasText:'1'}).waitFor();
 await page.getByRole('button',{name:'第二模块',exact:true}).click();await child().getByTestId('result').filter({hasText:'1'}).waitFor();assert.ok(requests.includes(manifest.secondUrl));
 await child().getByTestId('increment').click();await child().getByTestId('result').filter({hasText:'2'}).waitFor();await page.getByRole('button',{name:'第一模块',exact:true}).click();await child().getByTestId('result').filter({hasText:'2'}).waitFor();
 assert.deepEqual(errors,[]);await page.screenshot({path:'/output/modular-preview.png'});
 // The exported source is rebuilt with the same installed Vite/React versions.
 await cp('/input/export','/work/export',{recursive:true});await symlink('/opt/runner/node_modules','/work/export/node_modules');process.chdir('/work/export');await import('/work/export/build.mjs');
 assert.ok((await readFile('/work/export/modules/'+manifest.firstId+'.html','utf8')).includes('data-testid'));
 await writeFile('/output/modular-report.json',JSON.stringify({lazyLoading:true,sharedSimulationState:true,moduleStateSurvivesNavigation:true,exportBuild:true,errors,requests},null,2));console.log('模块按需加载、共享模拟状态、切换保留状态和导出源码重建均通过。');
}finally{await browser.close();await new Promise(r=>server.close(r));}
