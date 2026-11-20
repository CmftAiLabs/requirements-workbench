import {FIELDS,type AISupplements,type Card,type FieldKey,type Fields,type IntakeAIReviews,type IntakeCandidate,type IntakeDraft} from './types';
import {hasUnresolvedContent} from './requirement-clarity';

type IntakeFields=Pick<IntakeDraft,'fields'|'origin'|'evidence'|'rationale'|'aiSupplements'|'aiReviews'>;

/** Older whole-card ideas also require field decisions; an old client cannot bypass review. */
export function splitLegacyAISupplements<T extends Pick<IntakeCandidate,'fields'|'origin'|'evidence'|'rationale'|'aiSupplements'>>(draft:T):T {
 if(draft.origin!=='建议补充')return draft;
 const fields={...draft.fields},evidence={...draft.evidence},aiSupplements:AISupplements={...draft.aiSupplements};
 for(const [key,label] of FIELDS)if(fields[key]?.trim()&&!hasUnresolvedContent(fields[key])&&!evidence[key]?.length){
  const existing=aiSupplements[key];
  aiSupplements[key]=existing?{...existing,text:existing.text===fields[key]?existing.text:`${fields[key]}\n${existing.text}`}:{text:fields[key],reason:draft.rationale||'AI 根据材料提出的可选设想，材料未明确要求。',evidence:[]};
  fields[key]=`待明确：材料未明确${label}。`;delete evidence[key];
 }
 return {...draft,fields,evidence,aiSupplements};
}

export function aiReviewFor(draft:IntakeFields,key:FieldKey){
 const supplement=draft.aiSupplements?.[key];if(!supplement)return undefined;
 const review=draft.aiReviews?.[key],text=review?.text??supplement.text;
 const decision=review?.reviewedText===text&&review.reviewedBase===draft.fields[key]?review.decision:undefined;
 return {supplement,text,decision};
}
export const pendingAIFields=(draft:IntakeFields)=>FIELDS.filter(([key])=>draft.aiSupplements?.[key]&&!aiReviewFor(draft,key)?.decision).map(([key])=>key);

/** Only expressly retained text enters formal fields. Material content is never deleted with an AI suggestion. */
export function resolvedIntakeFields(draft:IntakeFields):Fields {
 const fields={...draft.fields};
 for(const [key,label] of FIELDS){const review=aiReviewFor(draft,key);if(review?.decision!=='保留')continue;
  const base=fields[key].trim();
  const empty=!base||base===`待明确：材料未明确${label}。`||/^(?:待明确|待澄清|待补充)[。.]?$/u.test(base);
  fields[key]=empty?review.text.trim():`${base}\n${review.text.trim()}`;
 }
 return fields;
}

/** A decision is bound to both the edited suggestion and the material field it supplements. */
export function decideAIField(draft:IntakeFields,key:FieldKey,decision:'保留'|'删除'):IntakeAIReviews {
 const text=draft.aiReviews?.[key]?.text??draft.aiSupplements?.[key]?.text??'';
 return {...draft.aiReviews,[key]:{text,decision,reviewedText:text,reviewedBase:draft.fields[key]}};
}
export const currentAIOrigin=(card:Pick<Card,'fields'|'aiOrigins'>,key:FieldKey)=>card.aiOrigins?.[key]?.fieldValue===card.fields[key]?card.aiOrigins[key]:undefined;
export function aiOriginNote(card:Pick<Card,'fields'|'aiOrigins'>,key:FieldKey):string {
 const origin=currentAIOrigin(card,key);
 return origin?`AI 分析补充（产品经理已选择保留）：${origin.text}`:'';
}
