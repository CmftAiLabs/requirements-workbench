import type {Material,Project} from './types';

export const INTAKE_MAX_MATERIALS=20;
export const INTAKE_MAX_CHARACTERS=180000;
export function hasIntakeResult(project:Project,materialId:string){
 return project.materials.some(m=>m.id===materialId&&m.cardIds.length>0)||!!project.intakeBatches?.some(b=>b.materialIds.includes(materialId));
}
/** Only newly submitted material groups are automatic; historical/chat materials are untouched. */
export function nextIntakeMaterials(project:Project):Material[]{
 const pending=project.materials.filter(m=>m.intake?.status==='pending'&&!m.sourceConversation&&!hasIntakeResult(project,m.id));
 const groups=[...new Set(pending.map(m=>m.intake!.groupId))];
 for(const group of groups){
  const members=pending.filter(m=>m.intake!.groupId===group);
  if(members.some(m=>m.status==='处理中'))continue;
  const ready=members.filter(m=>!m.error&&m.text.trim()&&!m.archiveEntries),selected:Material[]=[];let length=0;
  for(const material of ready){
   if(selected.length>=INTAKE_MAX_MATERIALS||length+material.text.length>INTAKE_MAX_CHARACTERS)break;
   selected.push(material);length+=material.text.length;
  }
  if(selected.length)return selected;
 }
 return [];
}
export function materialAnalysisLabel(material:Material,jobs:{kind:string;status:string;result?:unknown}[],blockedReason=''){
 if(material.error||material.status==='处理中'||material.archiveEntries)return material.status;
 if(material.intake?.status==='failed')return '分析未完成';
 if(material.intake?.status==='pending'){
  if(jobs.some(j=>j.kind==='extract'&&['queued','running'].includes(j.status)&&(j.result as {materialIds?:string[]})?.materialIds?.includes(material.id)))return '正在生成卡片';
  return blockedReason||'等待自动分析';
 }
 return material.status;
}
