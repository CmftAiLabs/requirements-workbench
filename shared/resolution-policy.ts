import {resolutionScopeBasis} from './resolution-scope';
import {hasUnresolvedContent} from './requirement-clarity';
import { FIELDS } from './types.ts';
import type { Card, FieldKey, ProblemResolution } from './types.ts';
import { getSuggestionReview } from './suggestion-review.ts';

const fieldNames = new Map<string, string>(FIELDS);
const compact = (value: string) => value.normalize('NFKC').replace(/\s+/gu, '');

/** Shared preview guard. The server additionally validates material evidence before committing. */
export function resolutionDisabledReason(card: Card, candidate: ProblemResolution, decisions: Partial<Record<FieldKey, '采纳' | '不采纳'>>, overrides: Partial<Record<FieldKey, string>> = {}): string {
  if (!candidate || typeof candidate !== 'object' || typeof candidate.blockerId !== 'string') return '问题解决建议不完整，请重新整理。';
  const blocker = card.blockers.find(item => item.id === candidate.blockerId);
  if (!blocker) return '该问题已不存在，请重新整理。';
  if (blocker.resolved) return '该问题已经解决，无需重复处理。';
  if (typeof candidate.resolution !== 'string' || !candidate.resolution.trim()) return '尚未形成问题解决结论，请继续讨论。';
  if (!Array.isArray(candidate.requiredFields) || !candidate.requiredFields.length || candidate.requiredFields.some(key => !fieldNames.has(key)) || new Set(candidate.requiredFields).size !== candidate.requiredFields.length || !candidate.requiredFields.includes(blocker.field)) return '问题解决建议缺少有效的关联字段，请重新整理。';
  if (!Array.isArray(candidate.requiredRoles) || !candidate.requiredRoles.length || candidate.requiredRoles.some(role => !['business', 'pm', 'reviewer'].includes(role)) || new Set(candidate.requiredRoles).size !== candidate.requiredRoles.length) return '问题解决建议缺少所需确认角色，请重新整理。';
  if (!Array.isArray(candidate.evidence) || !candidate.evidence.length) return '问题解决建议缺少讨论依据，请继续讨论。';
  const evidenceRoles = new Set<string>();
  for (const evidence of candidate.evidence) {
    if (!evidence || typeof evidence.quote !== 'string' || !evidence.quote.trim() || Boolean(evidence.messageId) === Boolean(evidence.materialId)) return '问题解决依据不完整，请重新整理。';
    if (evidence.messageId) {
      const message = card.messages.find(item => item.id === evidence.messageId);
      if (!message || !['pm', 'business', 'reviewer'].includes(message.role) || (message.kind === 'change' && message.accepted !== true) || !compact(message.text).includes(compact(evidence.quote))) return '问题解决依据必须引用本卡片有效的人类讨论原文。';
      evidenceRoles.add(message.role);
    }
  }
  const missing = candidate.requiredRoles.filter(role => !evidenceRoles.has(role));
  if (missing.length) return `仍缺少${missing.map(role => role === 'business' ? '业务人员' : role === 'pm' ? '产品经理' : '历史参与者').join('、')}的讨论依据，请继续沟通。`;
  const finalFields={...card.fields,...Object.fromEntries((card.suggestion?.changes||[]).map(c=>[c.field,c.after]))};
  const scopeReviewed=candidate.scopeReview?.basis===resolutionScopeBasis(card,candidate,finalFields);
  for (const key of candidate.requiredFields) {
    const change = card.suggestion?.changes.find(item => item.field === key);
    if (change && decisions?.[key] !== '采纳') return `需要先采纳「${fieldNames.get(key)}」的修改，才能解决此问题。`;
    const override = overrides[key];
    if (change && typeof override === 'string' && override.trim() !== change.after) return `「${fieldNames.get(key)}」已人工调整，请重新总结讨论后确认此问题的解决依据。`;
    const finalValue = change ? change.after : card.fields[key];
    if (typeof finalValue !== 'string' || !finalValue.trim() || hasUnresolvedContent(finalValue)&&!scopeReviewed) return `「${fieldNames.get(key)}」仍有待明确内容，需重新核对它与本问题的关系；可先单独采纳字段修改。`;
  }
  const dependencyProblem = getSuggestionReview(card, decisions, overrides).dependencyProblems.find(problem => candidate.requiredFields.some(key => key === problem.field || problem.requires.includes(key)));
  if (dependencyProblem) return `关联修改尚未一致：${dependencyProblem.reason}`;
  return '';
}
