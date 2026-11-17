import type {Project} from './types';

export interface DemoViewport {width:number;height:number}
export const DESKTOP_VIEWPORT:DemoViewport={width:1280,height:800};
export const PORTRAIT_VIEWPORT:DemoViewport={width:390,height:844};

export function validDemoViewport(value:unknown):value is DemoViewport{
 if(!value||typeof value!=='object')return false;
 const {width,height}=value as DemoViewport;
 return Number.isInteger(width)&&Number.isInteger(height)&&width>=320&&width<=2560&&height>=320&&height<=1600&&width/height>=0.3&&width/height<=3;
}
export function preferredDemoViewport(project:Pick<Project,'demo'>,viewport?:DemoViewport):DemoViewport{
 return validDemoViewport(viewport)?viewport:project.demo?.kind==='conference'?PORTRAIT_VIEWPORT:DESKTOP_VIEWPORT;
}
/** Fit a viewport, never the entire scrollable document. Long pages keep their own scrolling. */
export function fitDemoViewport(available:DemoViewport,viewport:DemoViewport){
 const width=Number.isFinite(available.width)?Math.max(0,available.width):0;
 const height=Number.isFinite(available.height)?Math.max(0,available.height):0;
 const scale=Math.min(1,width/viewport.width,height/viewport.height);
 return {scale,width:viewport.width*scale,height:viewport.height*scale};
}

/** Runs only inside the existing sandbox. The parent accepts measurements from this frame alone. */
function previewSizeClient(token:string){
 const style=document.createElement('style');
 style.textContent='html,body,#root{box-sizing:border-box}html{overscroll-behavior:none}body{overscroll-behavior:none}';
 document.head.append(style);
 let scheduled=false,last='';
 const report=()=>{
  scheduled=false;
  const viewportWidth=window.innerWidth;
  const width=Math.ceil(Math.max(viewportWidth,document.documentElement.scrollWidth,document.body?.scrollWidth||0));
  const key=width+':'+viewportWidth;
  if(key===last)return;last=key;
  window.parent.postMessage({channel:'requirements-preview',type:'size',token,width,viewportWidth},'*');
 };
 const schedule=()=>{if(!scheduled){scheduled=true;requestAnimationFrame(report);}};
 const observer=new ResizeObserver(schedule);observer.observe(document.documentElement);if(document.body)observer.observe(document.body);
 new MutationObserver(schedule).observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['class','style','hidden']});
 window.addEventListener('resize',schedule);window.addEventListener('load',schedule);document.fonts?.ready.then(schedule);schedule();
}
export function withPreviewSizing(html:string,token:string){
 const safeToken=JSON.stringify(token).replace(/</g,'\\u003c');
 const script=`<script>{const __name=(fn)=>fn;(${previewSizeClient.toString()})(${safeToken});}</script>`;
 return /<\/body\s*>/i.test(html)?html.replace(/<\/body\s*>/i,()=>script+'</body>'):html+script;
}
