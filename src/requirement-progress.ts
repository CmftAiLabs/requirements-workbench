import {hasUnreviewedSuggestion} from '../shared/card-organization';
import {liveSuggestion} from '../shared/crm-demo';
import {hasUnresolvedContent} from '../shared/requirement-clarity';
import {cardStatus, FIELDS, type Card} from '../shared/types';

export function requirementProgress(card: Card, agentRunning = false) {
  const status = cardStatus(card);
  const concrete = card.included && card.granularity !== '概要';
  const confirmed = status === '已确认';
  const product = card.approvals.pm;
  const productConfirmed = product?.result === '通过' && product.revision === card.revision && product.round === card.round;
  const blockers = card.included ? card.blockers.filter(item => !item.resolved) : [];
  const questions = concrete ? (card.followUps ?? []).filter(question => question.baseRevision === card.revision
    && (question.status === 'waiting' || question.status === 'deferred')) : [];
  const gaps = concrete && !confirmed ? FIELDS.filter(([key]) => hasUnresolvedContent(card.fields[key])) : [];
  const overviewGaps = card.granularity === '概要' && card.included ? card.coverageGaps ?? [] : [];
  const changes = card.messages.filter(message => message.kind === 'change' && !message.accepted);
  const hasSuggestion = concrete && hasUnreviewedSuggestion(card);
  const suggestion = hasSuggestion ? liveSuggestion(card) : undefined;
  const needsNewSuggestion = hasSuggestion && !suggestion;
  const hasIssues = !!(blockers.length || questions.length || gaps.length || overviewGaps.length);

  let step: string = status;
  if (concrete && status === '可确认') {
    if (agentRunning) step = '助手整理中';
    else if (suggestion) step = suggestion.reviewRole === 'business' ? '待业务确认变更' : suggestion.changes.length || suggestion.problemResolutions?.length ? '待产品采纳' : '待澄清';
    else if (needsNewSuggestion) step = '待重新整理';
    else step = productConfirmed ? '待业务确认' : '待发起确认';
  } else if (card.included && card.granularity === '概要') {
    step = '待细化';
  }
  const pending = !!(hasIssues || changes.length || suggestion || needsNewSuggestion
    || status === '需评估' || (concrete && !confirmed));

  return {
    status, step, pending, blockers, questions, gaps, overviewGaps, changes,
    suggestion: agentRunning ? undefined : suggestion,
    needsNewSuggestion: !agentRunning && needsNewSuggestion,
  };
}
