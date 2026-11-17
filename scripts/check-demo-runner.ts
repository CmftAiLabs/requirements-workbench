import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {buildAndCheck,ensureDemoBuilder} from '../server/demo-builder.ts';
import type {DemoCodeProposal} from '../shared/generated-demo.ts';

// Real sandbox regression: React form submission must run, while imports remain restricted.
await ensureDemoBuilder();
const proposal:DemoCodeProposal={summary:'隔离构建器验证',files:[],deletePaths:[],bindings:[{cardId:'test-card',testId:'counter',field:'flow'}],checks:[{name:'表单提交更新状态',cardIds:['test-card'],steps:[{action:'click',testId:'increment'},{action:'expectText',testId:'counter',value:'1'}]}],assumptions:[]};
const files={'src/App.tsx':`import React,{useState} from 'react';export default function App(){const[n,setN]=useState(0);return <form onSubmit={e=>{e.preventDefault();setN(n+1)}}><div data-testid="counter">{n}</div><button type="submit" data-testid="increment">增加</button></form>}`,'src/styles.css':'body{color:#246;background:#f3f7ff}'};
for(const viewport of [{width:390,height:844},{width:1280,height:800}]){
 const report=await buildAndCheck('runner-check',randomUUID(),files,{...proposal,viewport});
 assert.equal(report.checks[0].passed,true);
}
await assert.rejects(buildAndCheck('runner-check',randomUUID(),{...files,'src/styles.css':'body{min-width:1200px}'},{...proposal,viewport:{width:390,height:844}}),/横向溢出/);
await assert.rejects(buildAndCheck('runner-check',randomUUID(),{...files,'src/App.tsx':"import fs from 'node:fs';export default function App(){return <div>{fs.readFileSync('/etc/passwd','utf8')}</div>}"},proposal),/不允许|禁止|not allowed|restricted|import/i);
console.log('隔离构建器通过：横竖视口均可交互，横向溢出与服务端模块导入被拒绝。');
