import { FIELDS } from './types.ts';
import type { Card, ChangeDependency, FieldKey, Fields } from './types.ts';

export interface SuggestionReview {
  fields: Fields;
  changedFields: FieldKey[];
  adjustedFields: FieldKey[];
  dependencyProblems: ChangeDependency[];
}

/** Pure preview: only explicitly accepted changes can enter the proposed card. */
export function getSuggestionReview(card: Card, decisions: Partial<Record<FieldKey, '采纳' | '不采纳'>>, overrides: Partial<Record<FieldKey, string>> = {}): SuggestionReview {
  const fields = {...card.fields};
  const adjustedFields: FieldKey[] = [];
  for (const change of card.suggestion?.changes || []) {
    if (decisions[change.field] !== '采纳') continue;
    const value = typeof overrides[change.field] === 'string' ? overrides[change.field]!.trim() : change.after;
    fields[change.field] = value;
    if (value !== change.after) adjustedFields.push(change.field);
  }
  const changedFields = FIELDS.filter(([key]) => fields[key] !== card.fields[key]).map(([key]) => key);
  const seen = new Set<string>();
  const dependencyProblems = (card.suggestion?.dependencies || []).flatMap(dependency => {
    if (!changedFields.includes(dependency.field)) return [];
    const missing = dependency.requires.filter(key => decisions[key] !== '采纳' || !changedFields.includes(key));
    const normalizedReason = dependency.reason.normalize('NFKC').replace(/\s+/gu, '');
    if (!missing.length || seen.has(normalizedReason)) return [];
    seen.add(normalizedReason);
    return [{...dependency, requires: missing}];
  });
  return {fields, changedFields, adjustedFields, dependencyProblems};
}
