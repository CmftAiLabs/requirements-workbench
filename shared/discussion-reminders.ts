import {getChatDisabledReason} from './chat-policy';
import {liveSuggestion} from './crm-demo';
import {waitingQuestion} from './discussion';
import {isQuestionRecipient,PARTICIPANTS,type ParticipantId} from './participants';
import {cardStatus,type Card,type Project} from './types';

export const reminderLabels = {
  reply: '待回复',
  clarify: '待澄清',
  adopt: '待采纳',
  startConfirmation: '待发起确认',
  confirm: '待确认',
} as const;

export interface DiscussionReminder {
  projectId: string;
  projectName: string;
  cardId: string;
  cardTitle: string;
  kind: keyof typeof reminderLabels;
  anchorId: string;
  detail?: string;
  createdAt: string;
}

export type AssignedReminder = DiscussionReminder & {participantId: ParticipantId};
type ReminderProject = Pick<Project,'id'|'name'|'createdAt'|'deliveries'>;

/** Derive reminders from current discussion and confirmation records. Opening one does not complete it. */
export function cardReminders(project: ReminderProject, card: Card): AssignedReminder[] {
  if (!card.included || card.granularity === '概要') return [];
  const base = {projectId:project.id,projectName:project.name,cardId:card.id,cardTitle:card.title};
  const reminders: AssignedReminder[] = [];
  const question = waitingQuestion(card);
  const recipient = question && PARTICIPANTS.find(person => isQuestionRecipient(question,person.role,person.id));
  if (question && recipient) {
    reminders.push({...base,kind:'reply',participantId:recipient.id,anchorId:`question-${question.id}`,
      detail:question.question.slice(0,180),createdAt:question.activeSince || question.createdAt});
  }

  const product = {project,card,role:'pm',participantId:'pm'} as const;
  const suggestion = liveSuggestion(card);
  if (suggestion) {
    const owner = suggestion.reviewRole === 'business'
      ? {...product,role:'business' as const,participantId:'business' as const} : product;
    const operation = owner.role === 'business' ? 'confirmProductSuggestion' : 'applySuggestion';
    if (recipient?.id !== owner.participantId && !getChatDisabledReason(operation,owner)) {
      const kind = owner.role === 'business' ? 'confirm' : suggestion.changes.length || suggestion.problemResolutions?.length ? 'adopt' : 'clarify';
      reminders.push({...base,kind,participantId:owner.participantId,anchorId:`suggestion-${suggestion.id}`,
        detail:suggestion.summary.slice(0,180),createdAt:suggestion.createdAt});
    }
    return reminders;
  }

  if (question || cardStatus(card) !== '可确认') return reminders;
  const anchorId = `confirmation-${card.id}`;
  if (!getChatDisabledReason('pmConfirm',product)) {
    reminders.push({...base,kind:'startConfirmation',participantId:'pm',anchorId,
      createdAt:card.history.at(-1)?.createdAt || project.createdAt});
  } else if (!getChatDisabledReason('businessConfirm',{project,card,role:'business',participantId:'business'})) {
    reminders.push({...base,kind:'confirm',participantId:'business',anchorId,
      createdAt:card.approvals.pm!.createdAt});
  }
  return reminders;
}
