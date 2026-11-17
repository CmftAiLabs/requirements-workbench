import {readFile,writeFile,cp,mkdir,symlink,readdir} from 'node:fs/promises';
import path from 'node:path';
import {build} from 'vite';
import {chromium} from 'playwright-core';
const started=performance.now(),report={build:false,checks:[],bindings:[],errors:[],timings:{buildMs:0,checkMs:0,totalMs:0}};
let browser,page;
try{
 const spec=JSON.parse(await readFile('/input/spec.json','utf8'));
 await mkdir('/work/src',{recursive:true});await cp('/input/src','/work/src',{recursive:true});
 await symlink('/opt/runner/node_modules','/work/node_modules');
 await writeFile('/work/entry.tsx',`import React from 'react';import{createRoot}from'react-dom/client';import App from './src/App';import './src/styles.css';createRoot(document.getElementById('root')!).render(<App/>);`);
 await build({configFile:false,root:'/work',logLevel:'error',publicDir:false,
  plugins:[{name:'scoped-imports',enforce:'pre',resolveId(source,importer){
   if(source.startsWith('\0')||!importer||!importer.startsWith('/work/src/'))return;
   if(['react','react-dom','react-dom/client','react/jsx-runtime','react/jsx-dev-runtime'].includes(source))return;
   if(source.startsWith('.')){const resolved=path.resolve(path.dirname(importer),source);if(resolved.startsWith('/work/src/'))return;}
   throw Error('仅可导入 React 和 src 内文件：'+source);
  }}],
  define:{'process.env.NODE_ENV':JSON.stringify('production')},
  build:{outDir:'/tmp/bundle',emptyOutDir:true,minify:true,cssCodeSplit:false,lib:{entry:'/work/entry.tsx',name:'ProjectDemo',formats:['iife'],cssFileName:'style',fileName:()=> 'app.js'},rolldownOptions:{output:{inlineDynamicImports:true}}}});
 const js=await readFile('/tmp/bundle/app.js','utf8');
 let css='';for(const name of await readdir('/tmp/bundle'))if(name.endsWith('.css'))css+=await readFile('/tmp/bundle/'+name,'utf8');
 const html=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'"><title>需求讨论 Demo</title><style>html,body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif}*{box-sizing:border-box}${css.replace(/<\/style/gi,'<\\/style')}</style></head><body><div id="root"></div><script>${js.replace(/<\/script/gi,'<\\/script')}</script></body></html>`;
 await writeFile('/output/index.html',html);report.build=true;report.timings.buildMs=performance.now()-started;
 browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--disable-software-rasterizer','--in-process-gpu','--no-zygote']});
 const viewport=spec.viewport||{width:1280,height:800};
 const context=await browser.newContext({viewport,serviceWorkers:'block'});
 await context.route('**/*',route=>route.abort());
 page=await context.newPage();page.setDefaultTimeout(4000);
 page.on('pageerror',e=>report.errors.push(e.message.slice(0,700)));
 const checkLayout=async f=>{
  const size=await f.locator('html').evaluate(el=>({width:el.clientWidth,scrollWidth:el.scrollWidth}));
  if(size.scrollWidth>size.width+2)throw Error(`原型在 ${viewport.width}×${viewport.height} 视口中横向溢出：页面宽 ${size.scrollWidth}px。请调整布局，不要裁掉业务内容；表格可在自己的容器内滚动。`);
 };
 const load=async()=>{await page.setContent(`<style>html,body{margin:0}</style><iframe id="demo" sandbox="allow-scripts allow-forms" style="border:0;display:block;width:${viewport.width}px;height:${viewport.height}px"></iframe>`);await page.locator('#demo').evaluate((el,html)=>el.srcdoc=html,html);const f=page.frameLocator('#demo');await f.locator('#root > *').first().waitFor({state:'visible'});await checkLayout(f);return f;};
 let f=await load();
 if(!(await f.locator('body').innerText()).trim())throw Error('Demo 为空白');
 for(const binding of spec.bindings){
  f=await load();if(binding.navigationTestId)await f.getByTestId(binding.navigationTestId).click();
  await f.getByTestId(binding.testId).waitFor({state:'visible'});await checkLayout(f);report.bindings.push(binding.cardId);
 }
 for(const check of spec.checks){
  f=await load();
  try{for(const step of check.steps){const el=f.getByTestId(step.testId);
   switch(step.action){
    case 'click':await el.click();break;
    case 'fill':await el.fill(step.value);break;
    case 'select':await el.selectOption(step.value);break;
    case 'check':await el.check();break;
    case 'uncheck':await el.uncheck();break;
    case 'expectDisabled':if(await el.isEnabled())throw Error('按钮应不可操作');break;
    case 'expectEnabled':if(!await el.isEnabled())throw Error('按钮应可操作');break;
    case 'expectVisible':await el.waitFor({state:'visible'});break;
    case 'expectText':await el.filter({hasText:step.value}).waitFor({state:'visible'});break;
    case 'expectValue':if(await el.inputValue()!==step.value)throw Error('输入值与预期不一致');break;
    case 'expectCount':if(await el.count()!==step.count)throw Error('元素数量与预期不一致');break;
    default:throw Error('不支持的检查操作');
   }
  }await checkLayout(f);report.checks.push({name:check.name,passed:true});}
  catch(e){report.checks.push({name:check.name,passed:false});const visible=(await f.locator('body').innerText()).slice(0,5000);const controls=await f.locator('input,select,textarea,button').evaluateAll(nodes=>nodes.slice(0,50).map(n=>({testId:n.getAttribute('data-testid'),text:n.textContent?.slice(0,60),value:n.value,disabled:n.disabled,validation:n.validationMessage})));throw Error(check.name+': '+e.message+'\n当前页面：'+visible+'\n控件状态：'+JSON.stringify(controls));}
 }
 if(report.errors.length)throw Error(report.errors.join('\n'));
 await load();await page.screenshot({path:'/output/preview.png'});
}catch(e){report.errors.push(String(e.message||e).slice(0,7000));if(page)await page.screenshot({path:'/output/failed.png'}).catch(()=>{});process.exitCode=1;}
finally{await browser?.close();report.timings.totalMs=performance.now()-started;if(report.build)report.timings.checkMs=report.timings.totalMs-report.timings.buildMs;await writeFile('/output/report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));}
