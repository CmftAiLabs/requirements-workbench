import {hasUnresolvedContent} from './requirement-clarity';
import {isBusinessOwner,personFor,type ParticipantId} from './participants';
import { FIELDS, cardStatus } from './types.ts';
import type { Card, Project, Role } from './types.ts';
import {unansweredQuestion} from './discussion.ts';
import {isNoopSuggestion} from './conclusion-presentation';

export type ChatOperation = 'discuss' | 'proposeChange' | 'addBlocker' | 'acceptChange' | 'editCard' | 'applySuggestion' | 'suggest' | 'resolveBlocker' | 'pmConfirm' | 'businessConfirm' | 'businessReject' | 'businessDefer';
export interface ChatPolicyContext {
  project: Project;
  card: Card;
  role: Role;
  participantId?: ParticipantId;
  busy?: boolean;
  agentRunning?: boolean;
  modelConfigured?: boolean;
}

const productOperations: ChatOperation[] = ['acceptChange', 'editCard', 'applySuggestion', 'resolveBlocker', 'pmConfirm'];
const businessOperations: ChatOperation[] = ['proposeChange', 'businessConfirm', 'businessReject', 'businessDefer'];

function approved(card: Card, role: 'pm' | 'business') {
  const record = card.approvals[role];
  return record?.result === '通过' && record.revision === card.revision && record.round === card.round;
}
function suggestionReason(card: Card) {
  const suggestion = card.suggestion;
  if (!suggestion || suggestion.status === '已写入' || isNoopSuggestion(suggestion)) return '';
  if (suggestion.status === '已失效' || suggestion.baseRevision !== card.revision || suggestion.messageCount !== (card.messageCount??card.messages.length)) return '原有 Agent 建议已过期，请按最新卡片和讨论重新整理，再进行确认。';
  return 'Agent 建议尚待决定，请先由产品经理审核修改及问题解决建议，再确认当前卡片。';
}

/** One shared set of prerequisites for the controls and their server-side actions. */
export function getChatDisabledReason(operation: ChatOperation, context: ChatPolicyContext): string {
  const { project, card, role, participantId, busy, agentRunning, modelConfigured } = context;
  // A different role should see who owns the action, even when the page is also busy/frozen.
  if (!['pm', 'business', 'reviewer'].includes(role)) return '当前身份没有沟通群操作权限。';
  if (productOperations.includes(operation) && role !== 'pm') return '仅产品经理有操作权限。';
  if (businessOperations.includes(operation) && role !== 'business') return '仅业务人员有操作权限。';
  if (['businessConfirm','businessReject','businessDefer'].includes(operation)&&!isBusinessOwner(role,participantId)) return '由业务负责人陈敏统一确认；其他业务成员可以在群里补充意见或提出变更。';
  if (project.deliveries.some(delivery => !delivery.completedAt) && !['discuss', 'proposeChange'].includes(operation)) return '当前 PRD 已冻结交付，请先完成两端交付或重试失败目标；期间可以继续讨论、提出变更。';
  if (busy === true) return '正在保存上一项操作，请稍候再试。';
  if (card.granularity === '概要' && ['suggest', 'applySuggestion', 'pmConfirm', 'businessConfirm', 'businessReject', 'businessDefer'].includes(operation)) return '概要卡用于管理目标、范围和待细化内容；请先在材料箱细化为具体卡，再逐张确认。';
  if (card.granularity === '概要' && operation === 'editCard') return '请在概要详情统一调整目标、范围和待细化内容。';

  if (operation === 'suggest') {
    if (!card.included) return '本期不纳入的卡片暂不生成字段建议；如要推进，请先由产品经理纳入本期。';
    if (modelConfigured === false) return '尚未配置模型服务，请先完成服务端模型配置。';
    if (agentRunning === true) return 'Agent 正在整理这张卡片，请等待本次建议完成。';
  }
  if (operation === 'applySuggestion') {
    const suggestion = card.suggestion;
    if (!suggestion) return '还没有可处理的字段建议，请先让 Agent 总结讨论。';
    if (suggestion.status === '已写入') return '这份字段建议已经处理，请继续讨论或生成新的建议。';
    if (suggestion.status !== '待决定' || suggestion.baseRevision !== card.revision || suggestion.messageCount !== (card.messageCount??card.messages.length)) return '这份建议已过期，请根据最新卡片和讨论重新生成。';
  }
  if (operation === 'resolveBlocker' && !card.blockers.some(blocker => !blocker.resolved)) return '当前卡片没有待解决的阻断问题。';

  if (['pmConfirm', 'businessConfirm', 'businessReject', 'businessDefer'].includes(operation)) {
    if (!card.included) return '本期不纳入的卡片不参与确认，请先由产品经理调整本期范围。';
    if (operation !== 'pmConfirm' && !approved(card, 'pm')) return '请先由产品经理确认当前修订并发起本轮业务确认。';
    if (operation === 'pmConfirm' && approved(card, 'pm')) return cardStatus(card) === '已确认' ? '产品与业务已确认当前修订，无需重复确认；如有变化，请提出变更或修改卡片。' : '产品已确认当前修订，请等待业务人员完成本轮确认。';
    if (operation === 'businessConfirm' && approved(card, 'business')) return '业务已确认当前修订，无需重复通过；如有变化，请提出变更或要求修改。';
    if (operation === 'businessDefer' && approved(card, 'business')) return '当前修订已经确认，如有变化请提出变更或要求修改。';
    // Asking for changes or deferring must remain possible even if a proposal is pending.
    if (operation === 'businessReject' || operation === 'businessDefer') return '';
    const pendingQuestion=unansweredQuestion(card);
    if(pendingQuestion)return `还有一个关键问题等${personFor(pendingQuestion.role,pendingQuestion.participantId).name}回复，请先在聊天中明确，再确认当前需求。`;
    if (card.blockers.some(blocker => !blocker.resolved)) return '仍有阻断问题待沟通；讨论明确后，可由产品经理采纳 Agent 建议并解决问题，再确认这张卡片。';
    if (card.assessment === '需评估') return '请先完成需求合理性和范围评估，再发起整卡确认。';
    const incomplete = FIELDS.filter(([key]) => !card.fields[key]?.trim() || hasUnresolvedContent(card.fields[key])).map(([, label]) => label);
    if (incomplete.length) return `请先明确全部九个字段；仍待明确：${incomplete.join('、')}。`;
    return suggestionReason(card);
  }
  return '';
}
