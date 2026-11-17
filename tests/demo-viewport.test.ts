import test from 'node:test';
import assert from 'node:assert/strict';
import {DESKTOP_VIEWPORT,PORTRAIT_VIEWPORT,fitDemoViewport,preferredDemoViewport,validDemoViewport,withPreviewSizing} from '../shared/demo-viewport';

test('横版与竖版原型在窄栏、矮窗口和放大预览中保持比例且不越界',()=>{
 for(const viewport of [DESKTOP_VIEWPORT,PORTRAIT_VIEWPORT,{width:1920,height:1080}]){
  for(const available of [{width:240,height:600},{width:640,height:340},{width:620,height:810},{width:1500,height:1000}]){
   const fitted=fitDemoViewport(available,viewport);
   assert.ok(fitted.width<=available.width+0.01&&fitted.height<=available.height+0.01);
   assert.ok(fitted.scale>0&&fitted.scale<=1);
   assert.ok(Math.abs(fitted.width/fitted.height-viewport.width/viewport.height)<0.0001);
   assert.ok(fitted.scale===1||Math.abs(fitted.width-available.width)<0.01||Math.abs(fitted.height-available.height)<0.01);
  }
 }
 assert.equal(fitDemoViewport({width:0,height:400},DESKTOP_VIEWPORT).scale,0);
 assert.equal(fitDemoViewport({width:500,height:Number.NaN},PORTRAIT_VIEWPORT).height,0);
});

test('旧项目保留手机或桌面视口，新原型可声明尺寸，非法尺寸不能影响宿主布局',()=>{
 assert.deepEqual(preferredDemoViewport({}),DESKTOP_VIEWPORT);
 assert.deepEqual(preferredDemoViewport({demo:{kind:'conference'} as never}),PORTRAIT_VIEWPORT);
 assert.deepEqual(preferredDemoViewport({}, {width:430,height:932}),{width:430,height:932});
 for(const value of [{width:0,height:800},{width:Infinity,height:800},{width:100000,height:800},{width:2560,height:320},{width:390,height:'844'},null])assert.equal(validDemoViewport(value),false);
 const html='<html><head></head><body><button>确认</button></body></html>';
 const fitted=withPreviewSizing(html,'</script><img>');
 assert.ok(fitted.includes('<button>确认</button>'));
 assert.ok(!fitted.includes('</script><img>'));
 assert.match(fitted,/requirements-preview/);
});
