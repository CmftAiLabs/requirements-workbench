import type {Card, SuggestionDraft} from './types';

export interface InterfaceTitleChange {
  before: string;
  after: string;
}

const label = '[\\p{L}\\p{N} ·、（）()_-]{1,40}';
const rename = new RegExp(`^(?:(?:建议|请|把|将)\\s*)?(?:(原型页头标题|页头标题|页面标题|页头)\\s*)?[「“"']?(${label})[」”"']?\\s*(?:改成|改为|更名为)\\s*[「“"']?(${label}?)[」”"']?\\s*(?:更合适|更好|即可|吧)?[。！!]?$`, 'u');
const recorded = new RegExp(`页头标题由「(${label})」改为「(${label})」。`, 'gu');

export function readInterfaceTitleChange(text: string): InterfaceTitleChange | undefined {
  const match = rename.exec(text.trim());
  if (!match) return;
  const [, location, oldText, newText] = match;
  const before = oldText.trim(), after = newText.trim();
  if (!before || !after || before === after || (!location && !before.endsWith('首页'))) return;
  if (/(?:需求卡|卡片标题|不要|不用|不必|是否|如果|假设|万一|改不改|不改|不能|暂不)/u.test(text)) return;
  return {before, after};
}

export function recordedInterfaceTitles(text: string): InterfaceTitleChange[] {
  return Array.from(text.matchAll(recorded), ([, before, after]) => ({before, after}));
}

export function withoutInterfaceTitles(text: string) {
  return text.replace(recorded, '').trimEnd();
}

/** A literal proposal is reviewable without guessing at its wording or changing the card title. */
export function interfaceTitleSuggestion(card: Card): SuggestionDraft | undefined {
  const message = card.messages.findLast(item => item.role !== 'agent');
  if (!message || message.kind === 'change' && !message.accepted || message.replyTo || message.materialIds?.length) return;
  const change = readInterfaceTitleChange(message.text);
  if (!change) return;
  const page = `${card.title} ${card.organization?.module ?? ''}`;
  const matchingPage = page.includes(change.before) || (change.before.endsWith('首页') && page.includes('首页'));
  const found = recordedInterfaceTitles(card.fields.flow).find(item => item.before === change.before || item.after === change.before);
  if (!matchingPage && !found && !/^(?:(?:建议|请|把|将)\s*)?(?:原型页头标题|页头标题|页面标题|页头)/u.test(message.text.trim())) return;
  if (found?.after === change.after) return {summary: `页头标题已采用「${change.after}」。`, changes: [], issues: []};

  const statement = (value: InterfaceTitleChange) => `页头标题由「${value.before}」改为「${value.after}」。`;
  const before = card.fields.flow;
  const after = found ? before.replace(statement(found), () => statement(change)) : `${before.trimEnd()}\n${statement(change)}`.trim();
  if (after.length > 6000) return;
  return {
    summary: `将当前页头标题从「${change.before}」改为「${change.after}」。`,
    issues: [],
    changes: [{field: 'flow', before, after, reason: '落实本轮提出的页头文案', evidence: [{messageId: message.id, quote: message.text.trim()}]}],
  };
}
