import type {Card,Material,Project} from './types';

export const CHAT_FILE_ACCEPT='.txt,.md,.csv,.pdf,.docx,.xlsx,.png,.jpg,.jpeg,.webp,.gif,.tif,.tiff,.zip';
export const CHAT_MAX_FILES=5;
export const CHAT_MAX_BYTES=50*1024*1024;

export function pendingAttachmentMessages(card:Card){
 const processed=new Set(card.messages.flatMap(m=>m.materialReply?.sourceMessageIds||[]));
 return card.messages.filter(m=>m.role!=='agent'&&m.materialIds?.length&&!processed.has(m.id));
}
export function conversationMaterials(project:Pick<Project,'materials'>,ids:string[]):Material[]{
 const wanted=new Set(ids);
 return project.materials.filter(m=>wanted.has(m.id)||!!m.sourceArchive&&wanted.has(m.sourceArchive.id));
}
export function attachmentWarnings(materials:Material[]):string[]{
 return materials.flatMap(m=>[
  ...(m.error?[`${m.name}：${m.error}`]:[]),
  ...(m.archiveEntries||[]).filter(e=>e.error).map(e=>`${m.name} / ${e.path}：${e.error}`),
 ]);
}
export function attachmentDisabledReason(project:Project,card?:Card){
 if(!card)return '请先选择要沟通的需求。';
 if(card.granularity==='概要')return '请在材料箱细化概要后，进入具体需求沟通。';
 if(!card.included)return '这项需求已移出本期，请先恢复后再分析新材料。';
 if(project.deliveries.some(d=>!d.completedAt))return '当前 PRD 正在冻结交付，请完成交付后再分析新材料。';
 return '';
}
