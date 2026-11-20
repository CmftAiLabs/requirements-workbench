import {AIOrigin} from './intake-ai-field';
import {useEffect,useLayoutEffect,useId,useMemo,useRef,useState} from 'react';
import {ArrowRight,FileText,ListFilter,Maximize2,Play,Sparkles,LoaderCircle,X} from 'lucide-react';
import {FIELDS,cardStatus,type Card,type FieldKey,type Project,type Job} from '../shared/types';
import {liveSuggestion} from '../shared/crm-demo';
import {buildDemoHTML} from '../shared/project-demo';
import {readDemoTrace} from '../shared/demo-trace';
import {preferredDemoViewport} from '../shared/demo-viewport';
import {FittedDemoFrame} from './fitted-demo-frame';
import {presentDemoChanges} from './demo-changes';
import {PreviewChanges} from './preview-changes';

import type {DemoView} from '../shared/generated-demo';
import './preview-toolbar.css';

export type DemoLocation={cardId:string;field?:FieldKey;sequence:number};
type Props={demoJob?:Job;onGenerate:()=>void;canGenerate:boolean;project:Project;card?:Card;running:boolean;expanded:boolean;onExpand:()=>void;onManage:()=>void;onCard:(id:string)=>void;onDiscuss:(id:string,field?:FieldKey)=>void;location?:DemoLocation};
export function DemoPreview({project:p,card:c,running,expanded,onExpand,onManage,onCard,onDiscuss,location,demoJob,onGenerate,canGenerate}:Props){
 const [document,setDocument]=useState(false),[changesOpen,setChangesOpen]=useState(false),[trace,setTrace]=useState<ReturnType<typeof readDemoTrace>>(null),[focus,setFocus]=useState<DemoLocation>();
 const loadStarted=useRef(performance.now());
 const frame=useRef<HTMLIFrameElement>(null),pending=useRef<DemoLocation|undefined>(undefined);
 const toolbar=useRef<HTMLDivElement>(null),changePanel=useRef<HTMLDivElement>(null),changeButton=useRef<HTMLButtonElement>(null),changePanelId=useId();
 const [generated,setGenerated]=useState<DemoView|null>(null),[previewError,setPreviewError]=useState('');
 useEffect(()=>{const abort=new AbortController();if(!p.generatedDemo)setGenerated(null);fetch(`/api/projects/${p.id}/demo/view?metadata=1`,{signal:abort.signal}).then(async response=>{if(!response.ok)throw new Error('原型暂时无法读取，请重试。');return response.json() as Promise<DemoView>;}).then(value=>{setGenerated(value);setPreviewError('');}).catch(e=>{if(e.name!=='AbortError')setPreviewError(e.message);});return()=>abort.abort();},[p.id,p.stamp]);
 useLayoutEffect(()=>{loadStarted.current=performance.now();},[generated?.url]);
 const sendModules=()=>{const revision=generated?.revision;if(revision?.modules)frame.current?.contentWindow?.postMessage({channel:'requirements-workbench',type:'update-modules',projectId:p.id,revision:p.stamp,modules:revision.modules.map(m=>({id:m.id,name:m.name,cardIds:m.cardIds,url:`/api/projects/${p.id}/demo/artifacts/${m.artifactId}/index.html`}))},'*');};
 const loaded=()=>{sendModules();sendLocation();void fetch('/api/metrics/client',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({metric:'preview.load',durationMs:performance.now()-loadStarted.current})}).catch(()=>{});};
 const legacy=!!(p.demo||p.example),html=useMemo(()=>generated?.url?'':generated?.html||(legacy&&c?buildDemoHTML(p,c):''),[generated?.url,generated?.html,legacy,p,c?.id]),suggestion=c?liveSuggestion(c):undefined;
 const update=useMemo(()=>c?presentDemoChanges(c):undefined,[c]);
 const demoRunning=!!demoJob&&['queued','running'].includes(demoJob.status),demoFailed=demoJob?.status==='failed'&&(!generated?.revision||demoJob.createdAt>generated.revision.createdAt);
 const statusLabel=generated?.revision?generated.stale?'未同步':generated.draft?'待采纳':'已同步':legacy?'参考原型':'未生成';
 const statusDescription=generated?.revision?generated.stale?'上次原型尚未同步当前需求':generated.draft?'当前原型包含尚未采纳的需求草稿':'原型已同步当前需求':legacy?'参考原型，尚未生成项目代码':'尚未生成项目原型';
 // Keep the trusted shell and its in-memory business data across compatible updates.
 const shellSource=useMemo(()=>({url:generated?.url,key:generated?.revision?.artifactId}),[p.id,generated?.revision?.businessContract?.runtimeKey||generated?.revision?.businessContract?.source,!!generated?.revision?.modules]);
 useEffect(()=>{sendModules();},[generated?.revision]);
 const changeCount=update?.groups.length??0;
 const hasChanges=!!generated?.revision||changeCount>0;
 const canLocateChange=(field:FieldKey)=>!!c?.included&&c.granularity!=='概要'&&(generated?.revision
  ? !generated.stale&&generated.revision.bindings.some(binding=>binding.cardId===c.id&&binding.field===field)
  : legacy&&!!html);
 const closeChanges=(restoreFocus=false)=>{setChangesOpen(false);if(restoreFocus)changeButton.current?.focus();};
 const sendLocation=()=>{const value=pending.current||c&&{cardId:c.id,field:'flow'};if(value&&frame.current?.contentWindow)frame.current.contentWindow.postMessage({channel:'requirements-workbench',type:'locate',projectId:p.id,cardId:value.cardId,field:value.field||'flow'},'*');};
 const locate=(field:FieldKey)=>{if(c){setChangesOpen(false);setDocument(false);setFocus({cardId:c.id,field,sequence:Date.now()});}};
 useEffect(()=>{setTrace(null);setDocument(false);setChangesOpen(false);pending.current=undefined;},[p.id,c?.id]);
 useEffect(()=>{setChangesOpen(false);},[update?.id,generated?.revision?.id]);
 useEffect(()=>{
  if(!changesOpen)return;
  changePanel.current?.focus();
  const outside=(event:Event)=>{if(!toolbar.current?.contains(event.target as Node))setChangesOpen(false);};
  const leaveFrame=()=>{if(window.document.activeElement===frame.current)setChangesOpen(false);};
  window.document.addEventListener('pointerdown',outside);
  window.document.addEventListener('focusin',outside);
  window.addEventListener('blur',leaveFrame);
  return()=>{window.document.removeEventListener('pointerdown',outside);window.document.removeEventListener('focusin',outside);window.removeEventListener('blur',leaveFrame);};
 },[changesOpen]);
 useEffect(()=>{if(location?.cardId===c?.id){setDocument(false);setFocus(location);}},[location]);
 useEffect(()=>{pending.current=focus?.cardId===c?.id?focus:undefined;sendLocation();},[focus,document,html,c?.id]);
 useEffect(()=>{const receive=(event:MessageEvent)=>{if(event.source!==frame.current?.contentWindow)return;const picked=readDemoTrace(event.data,p);if(picked)setTrace(picked);};window.addEventListener('message',receive);return()=>window.removeEventListener('message',receive);},[p]);
 return <><div className="co-preview-toolbar" ref={toolbar}>
  <div className="co-preview-heading">
   <div className="co-preview-tabs"><button className={!document?'active':''} onClick={()=>{setDocument(false);closeChanges();}}><Play size={13}/>原型</button><button className={document?'active':''} onClick={()=>{setDocument(true);closeChanges();}}><FileText size={13}/>PRD</button></div>
   {!document&&c&&<span className={`co-preview-status ${generated?.stale?'stale':generated?.draft?'draft':''}`} title={statusDescription} aria-label={`${statusDescription}${generated?.revision?`，修订 r${generated.revision.number}`:''}`}><i/><span>{statusLabel}</span>{generated?.revision&&<small>r{generated.revision.number}</small>}</span>}
  </div>
  <div className="co-preview-actions">
   {!document&&c&&<>
    {hasChanges&&<button ref={changeButton} className={`co-preview-changes-trigger ${changesOpen?'active':''}`} aria-label={`本轮变化${changeCount?`，${changeCount} 条业务变化`:''}`} title="查看本轮变化" aria-expanded={changesOpen} aria-haspopup="dialog" aria-controls={changePanelId} onClick={()=>setChangesOpen(value=>!value)}><ListFilter size={14}/><span>变化</span>{changeCount>0&&<b>{changeCount}</b>}</button>}
    <button className="co-preview-generate" aria-label={demoRunning?'原型更新中':generated?.revision?'更新原型':'生成原型'} title={demoRunning?demoJob.label.replaceAll('演示','原型').replace(/\bDemo\b/g,'原型'):generated?.revision?'按当前需求更新原型':'根据项目需求生成原型'} disabled={!canGenerate||running||demoRunning} onClick={()=>{closeChanges();onGenerate();}}>{demoRunning?<LoaderCircle size={13} className="spin"/>:<Sparkles size={13}/>}<span>{demoRunning?'更新中':generated?.revision?'更新原型':'生成原型'}</span></button>
   </>}
   <button type="button" className="icon-button" aria-label={expanded?'收起预览':'放大预览'} title={expanded?'收起预览':'放大预览'} onClick={()=>{closeChanges();onExpand();}}>{expanded?<X size={15}/>:<Maximize2 size={14}/>}</button>
  </div>
  {changesOpen&&!document&&hasChanges&&update&&<div className="co-preview-changes-popover" ref={changePanel} id={changePanelId} role="dialog" aria-label="本轮变化" tabIndex={-1} onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeChanges(true);}}}>
   <div className="co-preview-changes-header"><div><strong>本轮变化</strong><small>{c?.title}</small></div><button aria-label="关闭本轮变化" onClick={()=>closeChanges(true)}><X size={16}/></button></div>
   <PreviewChanges changes={update} view={generated} revisions={p.generatedDemo?.revisions??[]} canLocate={canLocateChange} locate={locate}/>
  </div>}
 </div>
  {c?<><div hidden={!document} className="co-prd"><div className="co-doc-label">当前需求章节 · 随采纳更新</div><h2>{c.title}</h2><p className="co-doc-status">{cardStatus(c)} · 修订 {c.revision}</p>{suggestion&&<p className="co-inline-note">Agent 的建议尚未采纳，这里保留当前需求正文。</p>}{FIELDS.map(([key,label])=><section key={key}><h3>{label}</h3><p>{c.fields[key]||'待明确'}</p><AIOrigin card={c} field={key}/></section>)}<details><summary>来源与确认记录</summary>{c.sources.map(id=><p key={id}>{p.materials.find(m=>m.id===id)?.name||id}</p>)}</details><button onClick={onManage}>查看整份 PRD 与评审</button></div><div className="co-prototype-host" hidden={document}>
   {(demoFailed||previewError)&&<div className="co-inline-error"><p>{(previewError||demoJob?.error)?.replaceAll('演示','原型').replace(/\bDemo\b/g,'原型')}</p><button disabled={!canGenerate||demoRunning} onClick={onGenerate}>重新生成</button></div>}
   {trace&&<div className="co-demo-trace"><button className="co-trace-close" aria-label="收起对应需求" onClick={()=>setTrace(null)}><X size={12}/></button>{trace.cardIds.map(id=><div key={id}><span>{p.cards.find(card=>card.id===id)?.title}{trace.field&&<small> · {FIELDS.find(([key])=>key===trace.field)?.[1]}</small>}</span><div><button onClick={()=>onCard(id)}>查看卡片</button><button onClick={()=>onDiscuss(id,trace.field)}>在群里提 <ArrowRight size={11}/></button></div></div>)}</div>}
   <>{html||generated?.url?<FittedDemoFrame frameRef={frame} key={`${p.id}:${generated?.revision?.modules?shellSource.key:generated?.revision?.artifactId||c.id}`} title={`${p.name}原型预览`} viewport={preferredDemoViewport(p,generated?.revision?.viewport)} html={html} url={generated?.revision?.modules?shellSource.url:generated?.url} trustedShell={!!generated?.revision?.modules} onLoad={loaded}/>:<div className="co-blank"><Play size={28}/><h3>{demoRunning?'正在把需求变成可交互原型':'为这个项目生成原型'}</h3><p>{demoRunning?'页面可运行后立即显示，其他交互检查在后台继续。':'根据需求生成页面和交互，供团队核对。'}</p>{!demoRunning&&<button className="primary" disabled={!canGenerate||running} onClick={onGenerate}>生成项目原型</button>}</div>}</>
  </div></>:<div className="co-blank"><Play size={28}/><h3>在这里看见需求的样子</h3><p>选中需求后预览相关原型。</p></div>}
 </>;
}
