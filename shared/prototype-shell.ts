/** Trusted shell. Only the active business module is requested and executed. */
export interface PrototypeModuleLink {id:string;name:string;url:string;cardIds:string[]}
export const prototypePersona={id:'E1001',name:'林晓',department:'行政部'} as const;
function runShell(config:{projectId:string;modules:PrototypeModuleLink[]}){
 const frame=document.getElementById('module') as HTMLIFrameElement,nav=document.getElementById('modules')!;
 let revision=0;
 let active=config.modules[0],pending:unknown,store:Record<string,unknown>=Object.create(null);
 const safe=(v:unknown)=>{try{return JSON.stringify(v).length<=256000;}catch{return false;}};
 const send=(data:unknown)=>frame.contentWindow?.postMessage(data,'*');
 const init=()=>send({channel:'requirements-prototype-state',type:'init',projectId:config.projectId,moduleId:active.id,modules:config.modules.map(({id,name})=>({id,name})),store});
 const select=(id:string)=>{
  const next=config.modules.find(m=>m.id===id);if(!next)return;
  if(active?.id===id&&frame.getAttribute('src'))return;
  active=next;frame.src=next.url;
  nav.querySelectorAll('button').forEach(b=>{b.setAttribute('aria-pressed',String(b.dataset.module===id));});
 };
 const renderNav=()=>{nav.replaceChildren();for(const m of config.modules){const button=document.createElement('button');button.type='button';button.textContent=m.name;button.dataset.module=m.id;button.onclick=()=>select(m.id);nav.append(button);button.setAttribute('aria-pressed',String(m.id===active.id));}};renderNav();
 frame.addEventListener('load',()=>{init();if(pending)send(pending);});
 window.addEventListener('message',event=>{
  const d=event.data;if(!d||typeof d!=='object')return;
  if(event.source===window.parent&&d.channel==='requirements-workbench'&&d.projectId===config.projectId&&d.type==='update-modules'){
   if(!Number.isInteger(d.revision)||d.revision<revision||!Array.isArray(d.modules)||!d.modules.length)return;
   const prefix='/api/projects/'+config.projectId+'/demo/artifacts/';
   if(!d.modules.every((m:PrototypeModuleLink)=>typeof m.id==='string'&&typeof m.name==='string'&&Array.isArray(m.cardIds)&&typeof m.url==='string'&&m.url.startsWith(prefix)&&/^[a-zA-Z0-9-]+\/index\.html$/.test(m.url.slice(prefix.length))))return;
   revision=d.revision;const old=active;config.modules=d.modules;active=config.modules.find(m=>m.id===old.id)||config.modules[0];renderNav();
   if(active.id!==old.id||active.url!==old.url)frame.src=active.url;else init();return;
  }
  if(event.source===window.parent&&d.channel==='requirements-workbench'&&d.projectId===config.projectId&&d.type==='locate'){
   const target=config.modules.find(m=>m.cardIds.includes(d.cardId));if(target){pending=d;select(target.id);send(d);}return;
  }
  if(event.source!==frame.contentWindow)return;
  if(d.channel==='requirements-prototype-state'){
   if(d.type==='ready'){init();if(pending)send(pending);}
   if(d.type==='set'&&typeof d.key==='string'&&d.key.length<=200&&!['__proto__','constructor','prototype'].includes(d.key)&&safe(d.value)){
    const next={...store,[d.key]:d.value};if(safe(next))store=next;
   }
   if(d.type==='navigate')select(d.moduleId);
  }else if(d.channel==='requirements-demo'&&d.projectId===config.projectId&&d.type==='trace'&&Array.isArray(d.cardIds)&&d.cardIds.every((id:string)=>active.cardIds.includes(id)))window.parent.postMessage(d,'*');
 });
 select(active.id);
}
const json=(value:unknown)=>JSON.stringify(value).replace(/</g,'\\u003c');
export function moduleShell(projectId:string,modules:PrototypeModuleLink[]){
 if(!modules.length)throw new Error('没有可预览模块');
 return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none';script-src 'unsafe-inline';style-src 'unsafe-inline';frame-src 'self' file:;connect-src 'none';form-action 'none';base-uri 'none'"><title>项目原型</title><style>html,body{margin:0;height:100%;overflow:hidden;font:14px system-ui;background:#f6f8fc}*{box-sizing:border-box}#modules{height:44px;display:flex;align-items:center;gap:6px;padding:6px 10px;overflow:auto;white-space:nowrap;border-bottom:1px solid #dce4ee}button{flex:none;border:0;border-radius:5px;padding:6px 12px;color:#42566c;background:transparent;font:inherit;cursor:pointer}button[aria-pressed=true]{background:#e5eefb;color:#2e5eae}button:focus-visible{outline:2px solid #2e5eae}iframe{display:block;width:100%;height:calc(100% - 44px);border:0;background:white}</style></head><body><nav id="modules" aria-label="业务模块"></nav><iframe id="module" title="当前业务模块" sandbox="allow-scripts allow-forms"></iframe><script>{const __name=(fn)=>fn;(${runShell.toString()})(${json({projectId,modules})});}</script></body></html>`;
}

/** A shared, bounded simulation store; no access to application data or credentials. */
export const prototypeStateSource=`import {useCallback,useRef,useSyncExternalStore} from 'react';
type Runtime={store:Record<string,unknown>;listeners:Set<()=>void>;modules:{id:string;name:string}[];set:(key:string,value:unknown)=>void;navigate:(id:string)=>void};
declare global{interface Window{__reqPrototype?:Runtime}}
const runtime:Runtime=window.__reqPrototype||{store:Object.create(null),listeners:new Set(),modules:[],set:()=>{},navigate:()=>{}};
window.__reqPrototype=runtime;
const emit=()=>runtime.listeners.forEach(fn=>fn());
const valid=(key:string,value:unknown)=>key.length<=200&&!['__proto__','constructor','prototype'].includes(key)&&JSON.stringify({...runtime.store,[key]:value}).length<=256000;
runtime.set=(key,value)=>{if(Object.is(runtime.store[key],value)||!valid(key,value))return;runtime.store={...runtime.store,[key]:value};emit();if(window.parent!==window)window.parent.postMessage({channel:'requirements-prototype-state',type:'set',key,value},'*');};
runtime.navigate=id=>{if(runtime.modules.some(m=>m.id===id))window.parent.postMessage({channel:'requirements-prototype-state',type:'navigate',moduleId:id},'*');};
window.addEventListener('message',event=>{if(event.source!==window.parent||event.data?.channel!=='requirements-prototype-state'||event.data.type!=='init')return;const data=event.data;if(!data.store||typeof data.store!=='object'||JSON.stringify(data.store).length>256000)return;runtime.store=data.store;runtime.modules=data.modules||[];emit();});
if(window.parent!==window)window.parent.postMessage({channel:'requirements-prototype-state',type:'ready'},'*');
const subscribe=(listener:()=>void)=>{runtime.listeners.add(listener);return()=>{runtime.listeners.delete(listener);};};
const snapshot=()=>runtime.store;
export function usePrototypeState<T>(key:string,initial:T|(()=>T)):[T,(value:T|((previous:T)=>T))=>void]{const first=useRef<{value:T}|null>(null);if(!first.current)first.current={value:typeof initial==='function'?(initial as ()=>T)():initial};const state=useSyncExternalStore(subscribe,snapshot,snapshot);const value=(Object.prototype.hasOwnProperty.call(state,key)?state[key]:first.current.value) as T;const set=useCallback((next:T|((previous:T)=>T))=>{const current=(Object.prototype.hasOwnProperty.call(runtime.store,key)?runtime.store[key]:first.current!.value) as T;runtime.set(key,typeof next==='function'?(next as (v:T)=>T)(current):next);},[key]);return [value,set];}
export function usePrototypeNavigation(){useSyncExternalStore(subscribe,snapshot,snapshot);return {modules:runtime.modules,navigate:runtime.navigate};}
`;
