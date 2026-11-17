import {useState} from 'react';
import {FileText,LoaderCircle} from 'lucide-react';
import type {Message,Project} from '../shared/types';
import {WorkspaceModal} from './workspace-ui';
import {useMaterialText} from './material-text';

export function ConversationMaterials({project,message,openDraft,openCard}:{project:Project;message:Message;openDraft:(id?:string)=>void;openCard:(id:string)=>void}){
 const [sourceId,setSourceId]=useState(''),source=project.materials.find(m=>m.id===sourceId),reply=message.materialReply;
 const detail=useMaterialText(project.id,source);
 const batch=reply?.intakeBatchId?project.intakeBatches?.find(b=>b.id===reply.intakeBatchId):undefined;
 const draft=batch?.drafts.find(d=>!d.poolCardId)||batch?.drafts[0];
 const waiting=batch?.drafts.filter(d=>!d.poolCardId).length||0;
 const openSource=(id:string)=>setSourceId(id);
 return <>
  {!!message.materialIds?.length&&<div className="co-message-files">{message.materialIds.map(id=>{
   const material=project.materials.find(m=>m.id===id);if(!material)return null;
   return <button type="button" className={`co-message-file ${material.error?'has-error':''}`} key={id} onClick={()=>openSource(id)} title={material.name}>{material.status==='处理中'?<LoaderCircle className="spin" size={14}/>:<FileText size={14}/>}<span>{material.name}</span><small>{material.error?'未读成功':material.status==='处理中'?'读取中':material.archiveEntries?'已展开':'查看材料'}</small></button>;
  })}</div>}
  {reply&&<>
   {(draft||reply.relatedCardIds.length>0)&&<div className="co-material-response-actions">
    {draft&&<button type="button" onClick={()=>openDraft(draft.id)}>{waiting?`核对新卡草稿 · ${waiting}`:`查看新卡 · ${batch!.drafts.length}`}</button>}
    {reply.relatedCardIds.map(id=><button type="button" key={id} onClick={()=>openCard(id)}>沟通「{project.cards.find(c=>c.id===id)?.title}」</button>)}
   </div>}
   {draft&&waiting>0&&<small className="co-material-response-note">由产品经理核对、编辑后加入需求池。</small>}
   {reply.clarifiesCurrent&&<small className="co-material-response-note">当前需求的修改仍需产品经理采纳。</small>}
   {!!reply.evidence.length&&<details className="co-material-evidence"><summary>查看依据 · {reply.evidence.length} 处</summary>{reply.evidence.map((e,i)=><blockquote key={i}>{e.materialId&&<button className="text-button" type="button" onClick={()=>openSource(e.materialId!)}>{project.materials.find(m=>m.id===e.materialId)?.name||'材料原文'}</button>}<p>{e.quote}</p></blockquote>)}</details>}
   {!!reply.warnings.length&&<details className="co-material-warnings"><summary>{reply.warnings.length} 项内容未读成功，本次仅分析可读材料</summary>{reply.warnings.map((warning,i)=><p key={i}>{warning}</p>)}</details>}
  </>}
  {source&&<WorkspaceModal title={source.name} wide onClose={()=>setSourceId('')}>
   <div className="co-material-source-links"><span>{source.location}</span>{source.filePath&&<a href={`/api/projects/${project.id}/materials/${source.id}/download`} download>下载原文件</a>}</div>
   {source.error&&<p className="co-material-warnings">{source.error}</p>}
   {source.mimeType?.startsWith('image/')&&<img alt={source.name} src={`/api/projects/${project.id}/materials/${source.id}/preview`} style={{maxWidth:'100%',maxHeight:260,objectFit:'contain'}}/>}
   {source.archiveEntries&&<div className="co-message-files">{source.archiveEntries.map((entry,i)=>entry.materialId?<button className="co-message-file" key={i} onClick={()=>openSource(entry.materialId!)}><FileText size={14}/>{entry.path}</button>:<p key={i} className="co-material-warnings">{entry.path}：{entry.error}</p>)}</div>}
   {!source.archiveEntries&&<pre className="co-material-source-text">{detail.error||(detail.loading?'正在读取材料正文…':detail.text)||(source.status==='处理中'?'正在读取材料，完成后自动分析。':'尚无可用正文，请检查文件后重新上传。')}</pre>}
  </WorkspaceModal>}
 </>;
}
