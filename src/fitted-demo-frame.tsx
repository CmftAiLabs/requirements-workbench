import {useEffect,useId,useLayoutEffect,useMemo,useRef,useState,type RefObject} from 'react';
import {fitDemoViewport,withPreviewSizing,type DemoViewport} from '../shared/demo-viewport';
import './fitted-demo-frame.css';

export function FittedDemoFrame({html,url,trustedShell=false,title,viewport,frameRef,onLoad}:{html:string;url?:string;trustedShell?:boolean;title:string;viewport:DemoViewport;frameRef:RefObject<HTMLIFrameElement|null>;onLoad:()=>void}){
 const host=useRef<HTMLDivElement>(null),token=useId(),growth=useRef(0);
 const [available,setAvailable]=useState({width:0,height:0}),[contentWidth,setContentWidth]=useState(viewport.width);
 const nativeWidth=Math.max(viewport.width,contentWidth),nativeHeight=viewport.height;
 const fitted=fitDemoViewport(available,{width:nativeWidth,height:nativeHeight});
 const source=useMemo(()=>withPreviewSizing(html,token),[html,token]);
 useEffect(()=>{setContentWidth(viewport.width);growth.current=0;},[html,viewport.width,viewport.height]);
 useLayoutEffect(()=>{
  const el=host.current;if(!el)return;
  const observer=new ResizeObserver(([entry])=>{
   if(entry)setAvailable({width:entry.contentRect.width,height:entry.contentRect.height});
  });observer.observe(el);return()=>observer.disconnect();
 },[]);
 useEffect(()=>{
  const receive=(event:MessageEvent)=>{
   const data=event.data;
   if(event.source!==frameRef.current?.contentWindow||data?.channel!=='requirements-preview'||data.type!=='size'||data.token!==token)return;
   if(!Number.isFinite(data.width)||!Number.isFinite(data.viewportWidth)||data.viewportWidth!==nativeWidth||data.width<=nativeWidth+2||growth.current>=3)return;
   const width=Math.min(2560,Math.ceil(data.width));
   if(width>nativeWidth){growth.current++;setContentWidth(width);}
  };
  window.addEventListener('message',receive);return()=>window.removeEventListener('message',receive);
 },[frameRef,nativeWidth,token]);
 return <div className="co-demo-stage" ref={host} data-orientation={viewport.width<viewport.height?'portrait':'landscape'}>
  <div className="co-demo-canvas" style={{width:fitted.width,height:fitted.height,visibility:fitted.scale?'visible':'hidden'}}>
   <iframe ref={frameRef} className="co-demo-frame" title={title} sandbox={trustedShell?'allow-scripts allow-forms allow-same-origin':'allow-scripts allow-forms'} src={url} srcDoc={url?undefined:source} onLoad={onLoad}
    style={{width:nativeWidth,height:nativeHeight,transform:`scale(${fitted.scale})`}}/>
  </div>
 </div>;
}
