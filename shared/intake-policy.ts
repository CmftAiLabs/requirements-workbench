import {hasUnresolvedContent} from './requirement-clarity';
import {FIELDS} from './types.ts';
import type {Card, IntakeDraft, Project} from './types.ts';

/** Existing cards without a granularity remain concrete requirements. */
export const isOverview = (card: Pick<Card, 'granularity'>) => card.granularity === '概要';
export const concreteCards = (project: Pick<Project, 'cards'>) => project.cards.filter(card => !isOverview(card));

export function intakeAssessment(draft: Pick<IntakeDraft, 'granularity' | 'assessment' | 'fields' | 'issues'>): '需评估' | '待澄清' | '可确认' {
  if (draft.granularity === '概要') return '待澄清';
  if (draft.assessment === '需评估') return '需评估';
  if (draft.issues.length || FIELDS.some(([key]) => hasUnresolvedContent(draft.fields[key]))) return '待澄清';
  return '可确认';
}

/** Open original scope must not disappear merely because selected children are complete. */
export function outlineGaps(project: Pick<Project, 'cards' | 'intakeBatches'>): {cardId:string;title:string;reasons:string[]}[] {
  const formal = project.cards.filter(card => isOverview(card) && card.included).flatMap(card => {
    const reasons = [...(card.coverageGaps || []), ...card.blockers.filter(blocker => !blocker.resolved).map(blocker => blocker.reason)];
    for (const batch of project.intakeBatches || []) {
      const parent = batch.drafts.find(draft => draft.poolCardId === card.id);
      if (parent) for (const child of batch.drafts.filter(draft => draft.parentId === parent.id && draft.origin === '材料要求' && !draft.poolCardId && !draft.acceptedExclusionReason?.trim())) reasons.push(`尚未入池或明确排除：${child.title}`);
    }
    if (!project.cards.some(child => child.parentId === card.id && !isOverview(child) && child.included)) reasons.push('尚无本期已入池的具体需求，请继续细化或明确本期排除范围');
    return reasons.length ? [{cardId: card.id, title: card.title, reasons: [...new Set(reasons)]}] : [];
  });
  const pendingRoots = (project.intakeBatches || []).flatMap(batch => batch.drafts.filter(draft => !draft.parentId && draft.origin === '材料要求' && !draft.poolCardId && !draft.acceptedExclusionReason?.trim()).map(draft => ({cardId: draft.id, title: draft.title, reasons: ['材料中的需求尚未入池或明确排除，请到材料箱处理']})));
  return [...formal, ...pendingRoots];
}

export function excludedRequirements(project: Pick<Project, 'cards' | 'intakeBatches'>): {id:string;title:string;reason:string}[] {
  const cards = project.cards.filter(card => !card.included).map(card => ({id: card.id, title: card.title, reason: card.exclusionReason}));
  const drafts = (project.intakeBatches || []).flatMap(batch => batch.drafts.filter(draft => !draft.poolCardId && draft.acceptedExclusionReason?.trim()).map(draft => ({id: draft.id, title: draft.acceptedExclusionTitle || draft.title, reason: draft.acceptedExclusionReason!})));
  return [...cards, ...drafts.filter(draft => !cards.some(card => card.id === draft.id))];
}
