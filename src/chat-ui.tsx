import {useId, type ButtonHTMLAttributes} from 'react';
import {FIELDS, type Card, type Fields, type Project} from '../shared/types';

/** A disabled action always carries a visible, screen-reader-associated reason. */
export function ActionButton({reason='',className='',children,...props}:ButtonHTMLAttributes<HTMLButtonElement>&{reason?:string}) {
 const id=useId();
 return <span className={`action-control ${className.includes('full-width')?'action-wide':''}`}>
  <button {...props} type={props.type||'button'} className={className} disabled={!!reason||props.disabled} aria-describedby={reason?id:props['aria-describedby']} title={reason||props.title}>{children}</button>
  {reason&&<small className="action-help" id={id}>{reason}</small>}
 </span>;
}
export function ChangeImpact({project,card,changesBody=false,changesState=true,invalidatesSuggestion=true,detail}:{project:Project;card:Card;changesBody?:boolean;changesState?:boolean;invalidatesSuggestion?:boolean;detail?:string}) {
 const approved=['pm','business'].filter(role=>{const a=card.approvals[role as 'pm'|'business'];return a?.result==='通过'&&a.revision===card.revision&&a.round===card.round}).map(r=>r==='pm'?'产品经理':'业务负责人');
 return <section className={`change-impact ${changesState?'':'no-change'}`} aria-label="确认后的影响"><strong>确认后会发生什么</strong>
  {detail&&<p>{detail}</p>}
  <dl><dt>需求卡片</dt><dd>{card.title} · 当前 r{card.revision}{changesBody?` → r${card.revision+1}`:'，正文不变'}</dd>
  <dt>确认结果</dt><dd>{!changesState?'保留现有确认结果。':approved.length?`${approved.join('、')}对当前卡片的确认将失效；处理后需产品与业务重新确认。`:'当前卡片尚无有效确认；问题处理完成后仍需产品与业务确认。'}</dd>
  <dt>需求阶段</dt><dd>{!changesState?`保持“${project.phase}”。`:project.phase==='可讨论'?'保持“可讨论”。':`从“${project.phase}”回到“可讨论”；本期卡片重新确认后才能再次提交整体评审。`}</dd>
  {changesState&&invalidatesSuggestion&&card.suggestion?.status==='待决定'&&<><dt>Agent 建议</dt><dd>当前待处理建议会过期；请重新整理并处理建议，再进行整卡确认。</dd></>}
  <dt>历史记录</dt><dd>其他卡片的确认、历史 PRD 和交付记录保持不变。</dd></dl>
 </section>;
}
export function FieldDiff({before,after,beforeTitle,afterTitle}:{before:Fields;after:Fields;beforeTitle?:string;afterTitle?:string}) {
 const changed=FIELDS.filter(([key])=>before[key]!==after[key]);
 const titleChanged=beforeTitle!==undefined&&beforeTitle!==afterTitle;
 return <div className="change-preview" aria-label="本次实际修改"><h3>本次实际修改 · {changed.length+(titleChanged?1:0)} 项</h3>
 {titleChanged&&<div className="preview-field"><strong>需求名称</strong><div><p><span>修改前</span>{beforeTitle}</p><p><span>修改后</span>{afterTitle}</p></div></div>}
 {changed.map(([key,label])=><div className="preview-field" key={key}><strong>{label}</strong><div><p><span>修改前</span>{before[key]||'未填写'}</p><p><span>修改后</span>{after[key]||'未填写'}</p></div></div>)}
 {!changed.length&&!titleChanged&&<p>没有正文变化，不会新增修订或使确认失效。</p>}
 </div>;
}
