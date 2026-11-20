import {Sparkles} from 'lucide-react';
import {aiReviewFor,decideAIField,currentAIOrigin} from '../shared/intake-fields';
import type {Card,FieldKey,IntakeAIReviews,IntakeDraft} from '../shared/types';

export function IntakeAIField({draft,field,label,disabled,onChange}:{draft:IntakeDraft;field:FieldKey;label:string;disabled:boolean;onChange:(reviews:IntakeAIReviews)=>void}){
 const review=aiReviewFor(draft,field);if(!review)return null;
 const {supplement,text,decision}=review;
 return <section className={`intake-ai-field ${decision==='删除'?'removed':''}`} aria-label={`${label} AI 分析补充`}>
  <div className="intake-ai-heading"><span><Sparkles size={13}/>AI 分析补充</span><small>{decision?`已选择${decision}`:'待选择保留或删除'}</small></div>
  {decision==='删除'?<details><summary>查看已删除的补充</summary><p>{text}</p></details>:<textarea aria-label={`${label} AI 补充内容`} rows={3} maxLength={6000} value={text} disabled={disabled} onChange={e=>onChange({...draft.aiReviews,[field]:{text:e.target.value}})}/>}
  <p className="intake-ai-reason">{supplement.reason}</p>
  {!!supplement.evidence?.length&&<details><summary>查看分析依据</summary>{supplement.evidence.map((ref,index)=><blockquote key={index}>{ref.quote}</blockquote>)}</details>}
  <div className="intake-ai-actions" role="group" aria-label={`${label} AI 补充处理`}>
   <button type="button" className="small" aria-pressed={decision==='保留'} disabled={disabled||!text.trim()} onClick={()=>onChange(decideAIField(draft,field,'保留'))}>保留</button>
   <button type="button" className="small" aria-pressed={decision==='删除'} disabled={disabled} onClick={()=>onChange(decideAIField(draft,field,'删除'))}>删除</button>
   <small>{decision==='删除'?'材料内容保留不变':decision==='保留'?'入池时合入正文，仍需业务确认':'不默认选择；修改内容后需重新选择'}</small>
  </div>
 </section>;
}

export function AIOrigin({card,field}:{card:Card;field:FieldKey}){
 const origin=currentAIOrigin(card,field);if(!origin)return null;
 return <details className="field-trace intake-ai-origin"><summary>包含 AI 分析补充 · 产品经理已保留</summary><p>{origin.text}</p><small>{origin.reason}</small></details>;
}
