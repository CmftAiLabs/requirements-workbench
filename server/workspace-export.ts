import {Document,Packer,Paragraph,HeadingLevel,TextRun,Footer,PageNumber,AlignmentType} from 'docx';
import {zipSync,strToU8} from 'fflate';
import {FIELDS,ROLES,cardStatus,versionLabel,type Project} from '../shared/types.js';
import {liveSuggestion} from '../shared/crm-demo.js';
import {buildDemoHTML,demoModel,demoLabel} from '../shared/project-demo.js';
import {conferencePRD} from './conference-prd.ts';
import {concreteCards,excludedRequirements,outlineGaps} from '../shared/intake-policy.js';
import {buildMarkdown} from './domain.js';
import {aiOriginNote} from '../shared/intake-fields';

export function workspacePRD(p:Project){
 const formal=['已明确','已交付'].includes(p.phase);
 if(formal){const frozen=p.snapshots.slice().reverse().find(s=>s.version===versionLabel(p));if(!frozen)throw new Error('缺少该正式版本的冻结文档，请核对版本记录。');return {markdown:frozen.markdown,formal:true};}
 if(p.demo?.kind==='conference')return {markdown:conferencePRD(p),formal:false};
 const lines=[`# ${p.name} · 产品需求文档（草稿）`,'',`版本：${versionLabel(p)} · ${p.phase}`,'','本文件包含当前已采纳需求及尚待确认事项。未采纳的 Agent 建议不作为需求结论；本草稿不能代替正式评审。','','## 本期需求',''];
 for(const [index,c] of concreteCards(p).filter(c=>c.included).entries()){
  lines.push(`### ${index+1}. ${c.title}`, '', `状态：${cardStatus(c)} · 需求编号：${c.id} · 修订 ${c.revision}`, '');
  for(const [key,label] of FIELDS){lines.push(`#### ${label}`,'',c.fields[key]||'待明确','');const note=aiOriginNote(c,key);if(note)lines.push(`> ${note}`,'');}
  const blockers=c.blockers.filter(b=>!b.resolved);if(blockers.length)lines.push('待沟通：',...blockers.map(b=>`- ${b.reason}`),'');
  if(liveSuggestion(c))lines.push('本需求有尚未采纳的 Agent 修改建议，请回到沟通群核对。','');
  lines.push('来源：',...c.sources.map(id=>{const m=p.materials.find(m=>m.id===id);return `- ${m?.name||id}${m?.location?` · ${m.location}`:''}`;}),'');
  for(const [key,label] of FIELDS){const refs=c.provenance[key]||[];if(refs.length)lines.push(`${label}依据：`,...refs.map(e=>`- ${e.materialId?p.materials.find(m=>m.id===e.materialId)?.name||e.materialId:`本卡讨论 ${e.messageId}`}：“${e.quote}”`),'');}
  for(const who of ['pm','business'] as const){const a=c.approvals[who];lines.push(`${ROLES[who]}：${a?.result==='通过'&&a.revision===c.revision&&a.round===c.round?'已确认当前修订':'尚未确认当前修订'}`);}lines.push('');
 }
 const gaps=outlineGaps(p);if(gaps.length)lines.push('## 尚待细化的范围','',...gaps.map(g=>`- ${g.title}：${g.reasons.join('；')}`),'');
 lines.push('## 本期不纳入','',...excludedRequirements(p).map(c=>`- ${c.title}：${c.reason}`),'','## 导出说明','','演示使用模拟数据。需求确认不等于研发已完成，下载不等于向知识中台或 TeamMate 交付。');
 if(!concreteCards(p).filter(c=>c.included).length)lines.push('','尚未形成具体需求，请先在材料箱整理资料。');
 return {markdown:lines.join('\n'),formal:false};
}
export async function prdWord(p:Project){
 const {markdown}=workspacePRD(p);
 const children=markdown.split('\n').filter(line=>line.trim()).map(line=>{
  const heading=line.match(/^(#{1,4})\s+(.+)/);
  if(heading)return new Paragraph({text:heading[2],heading:([HeadingLevel.TITLE,HeadingLevel.HEADING_1,HeadingLevel.HEADING_2,HeadingLevel.HEADING_3] as const)[heading[1].length-1],keepNext:true,spacing:{before:heading[1].length===1?0:240,after:120}});
  const parts=line.replace(/^[-*] /,'• ').split(/(\*\*.*?\*\*)/g);
  return new Paragraph({children:parts.map(text=>new TextRun({text:text.replace(/\*\*/g,''),bold:text.startsWith('**')})),keepNext:/^(需求编号：|演示页面：)/.test(line),spacing:{after:120,line:300}});
 });
 return Packer.toBuffer(new Document({creator:'需求协作工作台',title:p.name+' 产品需求文档',styles:{default:{document:{run:{font:{ascii:'Arial',hAnsi:'Arial',eastAsia:'Heiti SC'},size:22,color:'000000'}}},paragraphStyles:[
  {id:'Title',name:'Title',basedOn:'Normal',next:'Normal',run:{size:38,bold:true,color:'000000'},paragraph:{spacing:{after:240}}},
  ...[1,2,3].map((level)=>({id:'Heading'+level,name:'Heading '+level,basedOn:'Normal',next:'Normal',run:{size:[30,25,22][level-1],bold:true,color:'000000'},paragraph:{keepNext:true}})),
 ]},sections:[{properties:{page:{size:{width:12240,height:15840},margin:{top:1100,bottom:1100,left:1100,right:1100}}},footers:{default:new Footer({children:[new Paragraph({alignment:AlignmentType.CENTER,children:[new TextRun({children:[PageNumber.CURRENT],size:18,color:'777777'})]})]})},children}]}));
}
export function demoZip(p:Project,selectedId?:string){
 const cards=concreteCards(p);if(!cards.length)throw new Error('还没有可导出的演示需求。');
 const selected=p.cards.find(c=>c.id===selectedId)||cards.find(c=>c.included)||cards[0];
 const files:Record<string,Uint8Array>={'index.html':strToU8(buildDemoHTML(p,selected))};
 const manifest=cards.map((c,index)=>{const name=`demo-${index+1}.html`;files[name]=strToU8(buildDemoHTML(p,c));return {file:name,...demoModel(p,c)};});
 files['requirements.json']=strToU8(JSON.stringify({project:p.name,version:versionLabel(p),exportedAt:new Date().toISOString(),initialCardId:selected.id,cards:manifest},null,2));
 files['PRD.md']=strToU8(workspacePRD(p).markdown);
 files['README.md']=strToU8(`# ${p.name} · ${demoLabel(p)}演示\n\n双击 index.html 即可运行当前预览，无需安装依赖。其余需求分别在 demo-N.html 中。HTML 内含可编辑的样式、交互代码与需求数据。\n\n使用内存模拟数据，未连接真实系统。刷新即可重置；页面操作不会改变平台需求确认状态。\n\n${p.demo?.kind==='conference'?'演示包含报名与审核、议程与企业检索、预约确认与模拟手机号交换、晚宴桌号、个人凭证和资讯。微信授权、支付、通知和公众号跳转未接入真实服务，具体模拟范围和待定规则见 PRD.md。':'演示包含客户交接、权限变化、失败回滚、交接记录和站内通知。'}\n\nrequirements.json 记录需求修订、字段、未采纳建议编号与演示草稿标记。正式需求以经过确认和评审的 PRD 为准。\n\n## 需求与文件\n${manifest.map(c=>`- ${c.title}：${c.file} · ${c.status}`).join('\n')}\n`);
 return Buffer.from(zipSync(files));
}
