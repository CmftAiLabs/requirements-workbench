import {aiOriginNote} from '../shared/intake-fields';
import {FIELDS,cardStatus,versionLabel,type Evidence,type Project} from '../shared/types.ts';
import {conferencePage,CONFERENCE_PAGES} from '../shared/conference-demo.ts';
import {liveSuggestion} from '../shared/crm-demo.ts';

export function conferencePRD(p:Project){
 if(!p.demo)throw new Error('没有大会演示配置');
 const cards=p.cards.filter(c=>c.granularity!=='概要'&&c.included),overviews=p.cards.filter(c=>c.granularity==='概要'&&c.included);
 const sources=p.materials.filter(m=>m.text.trim());
 const sourceLabel=(id:string)=>'S'+String(sources.findIndex(m=>m.id===id)+1).padStart(2,'0');
 const quotes:{key:string;ref:Evidence;cardId:string}[]=[];
 const quoteLabel=(ref:Evidence,cardId:string)=>{
  const key=JSON.stringify([ref.materialId,ref.messageId,ref.quote]);let n=quotes.findIndex(q=>q.key===key);
  if(n<0){n=quotes.length;quotes.push({key,ref,cardId});}return 'E'+String(n+1).padStart(2,'0');
 };
 const lines=[`# ${p.demo.title}小程序产品需求文档`,'',`文档状态：草稿 · ${versionLabel(p)} · ${p.phase} · 项目修订 ${p.stamp}`,'',
 '本文件供产品、业务及评审人员结合演示核对需求。内容来自项目会议纪要、功能架构及参考截图；已知要求、演示假设和待确认事项分别标明。当前尚未完成业务确认和整体评审，不能视为正式开发基线。','',
 '## 1 文档目录','',
 '2 业务目标与范围；3 用户与主要流程；4 功能需求；5 待确认决策；6 演示与验收路径；7 来源与修订。','',
 '## 2 业务目标与范围','',
 ...overviews.flatMap(c=>[c.fields.goal,'',`本期拟定范围：${c.fields.scope}`,'',`材料中的约束：${c.fields.constraint}`,'']),
 '材料记录的计划上线日为 2026年10月1日，当前已晚于该日期，实际上线情况及最新排期须重新核实；文档不据此认定已上线。活动日期按纪要为 2026年11月27日。约6万元是材料中的预算估计，最终报价与取舍仍待确认。','',
 '明确不做：直播及直播链接复制、合作伙伴或媒体模块；预约不做复杂算法匹配和会议室自动分配；晚宴不展示具体座位号。','',
 '本次演示处理：',...p.demo.assumptions.map(v=>'- '+v),'',
 '## 3 用户与主要流程','',
 '- 未报名访客：查看首页基础信息，查看更多或进入详情前报名。',
 '- 受邀参会者：模拟微信授权并填写信息，按手机号校验邀请名单；通过后进入参会服务。',
 '- 名单外申请者：报名后进入待审核状态，演示中通过后台模拟审核放行。',
 '- 企业受邀交流方：收到模拟邀请，确认后交换模拟手机号。',
 '- 会务人员：后台审核、内容维护、桌位分配与数据导出属于待明确权限范围，演示按钮不代表普通参会者拥有这些权限。','',
 '主流程：查看大会基础信息 → 报名与名单校验 → 必要时人工审核 → 查看议程与企业 → 发起预约并确认 → 交换手机号 → 查询晚宴桌号与个人凭证。支付与邀请码尚未明确，不擅自增加为报名放行前置条件。','',
 '## 4 功能需求','',
 '每一节对应一张具体需求卡，保留固定九字段。括号内 E 编号可在第7节找到原文；无依据或未决规则仍保留待明确。',''];
 cards.forEach((c,i)=>{
  lines.push(`### 4.${i+1} ${c.title}`,'',`需求编号：${c.id} · 修订 ${c.revision} · 状态 ${cardStatus(c)}`,'',`演示页面：${CONFERENCE_PAGES[conferencePage(c)]}`,'');
  for(const [key,label] of FIELDS){const refs=(c.provenance[key]||[]).map(ref=>quoteLabel(ref,c.id));lines.push(`**${label}**：${c.fields[key]||'待明确'}${refs.length?' ['+[...new Set(refs)].join('，')+']':''}`,'');const note=aiOriginNote(c,key);if(note)lines.push(`> ${note}`,'');}
  if(liveSuggestion(c))lines.push('该卡仍有尚未采纳的 Agent 建议，本节只采用当前已保存正文。','');
  const pm=c.approvals.pm,business=c.approvals.business;
  lines.push(`确认记录：产品${pm?.result==='通过'&&pm.revision===c.revision&&pm.round===c.round?'已确认':'待确认'}；业务${business?.result==='通过'&&business.revision===c.revision&&business.round===c.round?'已确认':'待确认'}。`,'');
 });
 lines.push('## 5 待确认决策','','以下问题仍阻止需求正式确认。演示中的建议处理不自动关闭问题，业务及涉及权限的评审结论仍需回到对应卡片确认。','');
 cards.forEach((c,i)=>{const open=c.blockers.filter(b=>!b.resolved);if(open.length)lines.push(`### 5.${i+1} ${c.title}`,'',...open.map(b=>'- '+b.reason),'');});
 for(const overview of overviews)if(overview.coverageGaps?.length)lines.push('概要尚未覆盖：',...[...new Set(overview.coverageGaps)].map(g=>'- '+g),'');
 lines.push('共同待确认：数据保存期限、导出范围、后台各角色权限、性能与兼容性目标、正式素材和最新排期。','',
 '## 6 演示与验收路径','',
 '- 报名准入：访客点击议程进入报名；名单内模拟报名通过；名单外显示审核中；模拟审核通过后才能查看详情。',
 ...(p.demo.payment==='simulated'?['- 模拟支付：用户已选择预约与模拟支付都演示。可分别点击模拟支付成功或失败，不实际扣款，不自动改变报名准入状态；收费金额、退款和支付与准入关系仍待确认。']:[]),
 '- 议程与企业：搜索关键词和行业分类，检查有结果、无结果与详情展示；议程、嘉宾及企业介绍均为占位示例。',
 '- 预约流程：从企业发邀请 → 待确认 → 模拟对方同意 → 已同意 → 交换手机号 → 已交换。未同意前不展示联系方式；是否纳入本期仍按第5节处理。',
 '- 晚宴：查看07桌示例和高亮圆桌；切换未分配场景；不显示具体座位或同桌人员资料。',
 '- 我的：查看报名状态、修改演示资料、保存示意凭证、查看预约和桌号。示意凭证不可用于真实入场，修改后复审规则仍待确认。',
 '- 资讯：点击文章查看公众号跳转演示，体验链接失效。没有真实公众号链接或外部跳转。',
 '- 后台与异常：在演示场景菜单模拟审核通过或驳回、加载失败、交换记录CSV导出和重置。上述异常提示与默认处理属于演示建议，须经业务确认。','',
 'Demo 使用浏览器内存数据，刷新即重置；未接入微信授权、真实支付、通知、小程序后台或真实个人信息。Demo 的完成不改变需求确认状态。','',
 '## 7 来源与修订','',
 '### 7.1 材料索引','',...sources.map(m=>`${sourceLabel(m.id)} ${m.location?.includes(m.name)?m.location:m.name+(m.location?' ｜ '+m.location:'')}`),'',
 '### 7.2 字段原文索引','',...quotes.map((q,i)=>`E${String(i+1).padStart(2,'0')} ${q.ref.materialId?sourceLabel(q.ref.materialId):'卡片讨论 '+q.cardId+' / '+q.ref.messageId}：${q.ref.quote.replace(/\s+/g,' ')}`),'',
 '### 7.3 修订与交付','',`当前平台版本 ${versionLabel(p)}，阶段 ${p.phase}，项目修订 ${p.stamp}。各需求编号与修订见第4节，原文及编辑历史保存在平台。`,'',
 `本次演示准备时间：${p.demo.preparedAt.slice(0,10)}。完成草稿与演示准备，没有代业务负责人确认，也没有代评审人员通过。`,'',
 '下载仅生成本地文件，尚未向知识中台或 TeamMate 交付。正式交付须在需求和整体评审完成后，使用冻结的正式PRD版本。','');
 return lines.join('\n');
}
