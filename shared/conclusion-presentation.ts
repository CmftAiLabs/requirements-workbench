import type {SuggestionDraft} from './types';

// Existing card blockers remain in card details; a round displays only its new issues.
export function conclusionPresentation(s:Pick<SuggestionDraft,'changes'|'issues'|'problemResolutions'>){
 return {actionable:!isNoopSuggestion(s),issues:[...new Set(s.issues)]};
}

/** A reply with no proposed decision must not become a confirmation prerequisite. */
export function isNoopSuggestion(s:Pick<SuggestionDraft,'changes'|'issues'|'problemResolutions'>){
 return !s.changes.length&&!s.issues.length&&!s.problemResolutions?.length;
}
