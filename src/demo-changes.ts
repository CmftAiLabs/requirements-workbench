import {demoUpdate} from '../shared/demo-trace';
import {hasUnresolvedContent} from '../shared/requirement-clarity';
import {FIELDS, type Card, type Evidence, type FieldKey} from '../shared/types';

const fieldLabels = Object.fromEntries(FIELDS) as Record<FieldKey, string>;
const priority = ['permission', 'flow', ...FIELDS.map(([field]) => field)];
const phraseLength = 8;
const questionPrefix = /^(待明确|待澄清|待补充|待确认)[：:]\s*/u;
type FieldEdit = ReturnType<typeof demoUpdate>['changes'][number];
type SupportedEdit = FieldEdit & {
  adopted: boolean;
  quantities: string;
  quotes: {messageId: string; text: string}[];
  previous: string[];
  current: string[];
};

function clauses(text: string) {
  return text.split(/[。！？；!?;\n]+/u).map(part => part.trim()).filter(Boolean);
}

function comparable(text: string) {
  return text.normalize('NFKC').replace(/[\s，,。；;：:“”"「」]/gu, '').toLowerCase();
}

function difference(left: string[], right: string[]) {
  const retained = new Set(right.map(comparable));
  return left.filter(part => !retained.has(comparable(part)));
}

function withoutRetainedQuestion(part: string, after: string[]) {
  if (!questionPrefix.test(part)) return part;
  for (const current of after) {
    if (!questionPrefix.test(current)) continue;
    const retained = current.replace(questionPrefix, '');
    if (!part.endsWith(retained)) continue;
    const before = part.slice(0, -retained.length);
    const shortened = before.replace(/(?:[，、,]\s*(?:以及|和|及)?|以及)\s*$/u, '');
    if (shortened !== before) return shortened;
  }
  return part;
}

function discussionQuotes(evidence: Evidence[]) {
  return evidence.flatMap(({messageId, quote}) => {
    const text = comparable(quote);
    return messageId && text.length >= phraseLength ? [{messageId, text}] : [];
  });
}

function phrases(parts: string[]) {
  const result = new Set<string>();
  for (const part of parts) {
    const text = comparable(part);
    for (let offset = 0; offset <= text.length - phraseLength; offset++) {
      result.add(text.slice(offset, offset + phraseLength));
    }
  }
  return result;
}

function supportedBy(text: string, claims: Set<string>) {
  for (let offset = 0; offset <= text.length - phraseLength; offset++) {
    if (claims.has(text.slice(offset, offset + phraseLength))) return true;
  }
  return false;
}

function sameRule(left: SupportedEdit, right: SupportedEdit, leftClaims: Set<string>, rightClaims: Set<string>) {
  if (left.quantities && right.quantities && left.quantities !== right.quantities) return false;
  // Identical concrete edits across fields need no AI metadata. A shared pending
  // marker or an identical field template by itself does not establish a rule.
  const signature = (parts: string[]) => parts.map(comparable).join('|');
  if (left.current.length === 1 && right.current.length === 1 && leftClaims.size
    && signature(left.current) === signature(right.current)
    && signature(left.previous) === signature(right.previous)) return true;

  // Compare wording from the same answer, and require that wording to occur
  // in both edits. One message can also contain several unrelated decisions.
  const shared = new Set([...leftClaims].filter(phrase => rightClaims.has(phrase)));
  if (!shared.size) return false;
  return left.quotes.some(a => right.quotes.some(b => {
    if (a.messageId !== b.messageId) return false;
    const [longer, shorter] = a.text.length >= b.text.length ? [a.text, b.text] : [b.text, a.text];
    return longer.includes(shorter) && supportedBy(shorter, shared);
  }));
}

function presentGroup(edits: SupportedEdit[], draft: boolean) {
  const primary = edits[0];
  const concrete = primary.current.filter(part => !hasUnresolvedContent(part));
  const match = phrases(primary.quotes.map(quote => quote.text));
  const supported = concrete.filter(part => supportedBy(comparable(part), match));
  const current = edits.length > 1 && supported.length ? supported : primary.current;
  return {
    id: primary.field,
    title: fieldLabels[primary.field],
    status: draft ? '待采纳' : edits.every(edit => edit.adopted) ? '已采纳' : '已保存',
    previous: primary.previous.slice(0, 2),
    current: current.flatMap(part => part.split(/，(?=待[^，。；]{1,12}期间)/u)).slice(0, 3),
    fields: FIELDS.flatMap(([key, label]) => {
      const edit = edits.find(item => item.field === key);
      return edit ? [{field: key, label, before: edit.before, after: edit.after}] : [];
    }),
  };
}

export function presentDemoChanges(card: Card) {
  const update = demoUpdate(card);
  const suggestion = card.suggestion;
  const relevantSuggestion = update.draft || (suggestion?.status === '已写入' && suggestion.baseRevision === card.revision - 1);
  const edits = update.changes.map((change): SupportedEdit => {
    const source = relevantSuggestion ? suggestion?.changes.find(item => item.field === change.field && item.before === change.before) : undefined;
    const adopted = !!source && !update.draft && suggestion?.decisions?.[change.field] === '采纳'
      && (suggestion.overrides?.[change.field] ?? source.after) === change.after;
    const before = clauses(change.before);
    const after = clauses(change.after);
    const removed = difference(before, after).map(part => withoutRetainedQuestion(part, after));
    const added = difference(after, before);
    const formattingOnly = !removed.length && !added.length;
    return {
      ...change,
      adopted,
      quantities: [...new Set(added.join(' ').normalize('NFKC').match(/\d+(?:\.\d+)?/g))].sort().join('|'),
      // A manually rewritten field must be shown from the saved version.
      quotes: source && (adopted || update.draft) && source.after === change.after ? discussionQuotes(source.evidence ?? []) : [],
      previous: formattingOnly ? [change.before] : removed,
      current: formattingOnly ? [change.after] : added,
    };
  }).sort((a, b) => priority.indexOf(a.field) - priority.indexOf(b.field));

  const claims = new Map(edits.map(edit => [edit, phrases(edit.current.filter(part => !hasUnresolvedContent(part)))]));
  const groups: SupportedEdit[][] = [];
  for (const edit of edits) {
    // Comparing every pair keeps a cross-cutting field from chaining two rules together.
    const group = groups.find(items => items.every(item => sameRule(item, edit, claims.get(item)!, claims.get(edit)!)));
    if (group) group.push(edit);
    else groups.push([edit]);
  }
  return {id: update.id, draft: update.draft, groups: groups.map(edits => presentGroup(edits, update.draft))};
}
