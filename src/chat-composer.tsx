import {useEffect,useRef,useState,type ReactNode,type RefObject} from 'react';
import {ArrowUp,FileText,LoaderCircle,Paperclip,Sparkles,X} from 'lucide-react';
import {CHAT_FILE_ACCEPT,CHAT_MAX_BYTES,CHAT_MAX_FILES} from '../shared/chat-attachments';
import './chat-materials.css';

type Props={files:File[];setFiles:(files:File[])=>void;clearDraft:()=>void;assistantAvailable?:boolean;text:string;setText:(value:string)=>void;inputRef:RefObject<HTMLTextAreaElement|null>;disabledReason:string;attachmentReason:string;hint:string;quickActions:ReactNode;modelPicker?:ReactNode;reply?:string;clearReply:()=>void;sendText:()=>Promise<void>;sendMaterials:(data:FormData)=>Promise<boolean>};
export function ChatComposer({files,setFiles,clearDraft,assistantAvailable=true,text,setText,inputRef,disabledReason,attachmentReason,hint,quickActions,modelPicker,reply,clearReply,sendText,sendMaterials}:Props){
 const [notice,setNotice]=useState(''),[uploading,setUploading]=useState(false),[drag,setDrag]=useState(false);
 const picker=useRef<HTMLInputElement>(null),composing=useRef(false),sending=useRef(false),requestId=useRef(''),mounted=useRef(true);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 useEffect(()=>{requestId.current='';},[text,reply]);
 const add=(incoming:FileList|File[])=>{
  if(disabledReason||attachmentReason||uploading)return;
  const next=[...files],errors:string[]=[];
  for(const file of Array.from(incoming)){
   const ext='.'+(file.name.split('.').at(-1)||'').toLowerCase();
   if(!CHAT_FILE_ACCEPT.split(',').includes(ext)){errors.push(`${file.name}：暂不支持该格式`);continue;}
   if(file.size>(ext==='.zip'?30:10)*1024*1024){errors.push(`${file.name}：超过${ext==='.zip'?30:10} MB`);continue;}
   if(next.some(f=>f.name===file.name&&f.size===file.size&&f.lastModified===file.lastModified))continue;
   if(next.length>=CHAT_MAX_FILES||next.reduce((n,f)=>n+f.size,0)+file.size>CHAT_MAX_BYTES){errors.push('每次最多5个文件，合计50 MB');break;}
   next.push(file);
  }
  setFiles(next);requestId.current='';setNotice([...new Set(errors)].join('；'));setDrag(false);
 };
 const submit=async()=>{
  if(disabledReason||sending.current||composing.current||!text.trim()&&!files.length)return;
  sending.current=true;
  try{
   if(!files.length){await sendText();return;}
   if(attachmentReason)return;
   setUploading(true);setNotice('');requestId.current ||= crypto.randomUUID();
   const data=new FormData();data.set('text',text.trim());data.set('clientMessageId',requestId.current);
   // The caller supplies the pending question ID, never a client-supplied identity.
   for(const file of files)data.append('files',file);
   const okay=await sendMaterials(data);
   if(okay){clearDraft();requestId.current='';}else if(mounted.current)setNotice('发送未完成，材料和文字已保留，可重试。');
  }finally{sending.current=false;if(mounted.current)setUploading(false);}
 };
 return <form className={`co-composer ${drag?'co-dropping':''}`} onSubmit={e=>{e.preventDefault();void submit();}}
  onDragOver={e=>{if(e.dataTransfer.types.includes('Files')){e.preventDefault();if(!attachmentReason&&!disabledReason)setDrag(true);}}}
  onDragLeave={e=>{if(!e.currentTarget.contains(e.relatedTarget as Node))setDrag(false);}}
  onDrop={e=>{if(e.dataTransfer.files.length){e.preventDefault();add(e.dataTransfer.files);}setDrag(false);}}>
  {hint&&<p role="status">{hint}</p>}{!assistantAvailable&&<p className="co-assistant-notice" role="status">AI 助手尚未启用，可继续人工讨论。</p>}<div className="co-quick-actions">{quickActions}</div>
  <div className="co-input-box">
   {reply&&<div className="co-replying"><span className="co-replying-label">正在回答</span><span className="co-replying-text" title={reply}>{reply}</span><button type="button" aria-label="取消定向回复" onClick={clearReply}><X size={12}/></button></div>}
   {!!files.length&&<div className="co-input-files">{files.map((file,index)=><span className="co-file-chip" key={`${file.name}:${index}`}><FileText size={14}/><span title={file.name}>{file.name}</span><button type="button" disabled={uploading} aria-label={`移除附件：${file.name}`} onClick={()=>{setFiles(files.filter((_,i)=>i!==index));requestId.current='';}}><X size={12}/></button></span>)}</div>}
   <textarea ref={inputRef} aria-label="沟通消息" placeholder="直接讨论或添加材料，Agent 会帮你分析…" value={text} disabled={!!disabledReason||uploading} maxLength={5000}
    onChange={e=>{setText(e.target.value);requestId.current='';}}
    onPaste={e=>{if(e.clipboardData.files.length){e.preventDefault();add(e.clipboardData.files);}}}
    onCompositionStart={()=>{composing.current=true;}} onCompositionEnd={()=>{composing.current=false;}}
    onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing&&!composing.current){e.preventDefault();void submit();}}}/>
   {notice&&<p className="co-attachment-notice" role="status">{notice}</p>}
   <div className="co-input-bottom"><div className="co-compose-tools">
    <input ref={picker} className="visually-hidden" type="file" multiple disabled={!!disabledReason||!!attachmentReason||uploading} accept={CHAT_FILE_ACCEPT} aria-label="选择沟通材料" onChange={e=>{if(e.target.files)add(e.target.files);e.target.value='';}}/>
    <button type="button" className="co-attach-button" aria-label="添加材料" disabled={!!disabledReason||!!attachmentReason||uploading} title={disabledReason||attachmentReason||'添加文档、图片或 ZIP，也可拖入或粘贴图片'} onClick={()=>picker.current?.click()}><Paperclip size={16}/></button>
    <button type="button" className="co-mention" aria-label="提问 Agent" disabled={!!disabledReason||uploading} title={disabledReason||'提问需求助手'} onClick={()=>{setText(text.includes('@Agent')?text:'@Agent '+text);inputRef.current?.focus();}}><Sparkles size={13}/><span>@Agent</span></button>
    {modelPicker}
   </div><span>{uploading?'正在发送材料…':'Enter 发送 · Shift + Enter 换行'}</span><button className="co-send" disabled={!!disabledReason||!!files.length&&!!attachmentReason||uploading||!text.trim()&&!files.length} title={disabledReason||(files.length?attachmentReason:'')||'发送'} aria-label="发送">{uploading?<LoaderCircle size={17} className="spin"/>:<ArrowUp size={18}/>}</button></div>
  </div>
 </form>;
}
