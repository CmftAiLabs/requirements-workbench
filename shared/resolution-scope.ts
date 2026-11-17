import type {Card,Fields,ProblemResolution} from './types';
// Bind a server-side issue review to the exact conclusion, evidence and field
// contents. A later edit cannot reuse a review of a different proposal.
export function resolutionScopeBasis(card:Card,candidate:ProblemResolution,fields:Fields){
 const blocker=card.blockers.find(b=>b.id===candidate.blockerId);
 return JSON.stringify([blocker?.id,blocker?.field,blocker?.reason,candidate.resolution,candidate.evidence.map(e=>[e.messageId,e.materialId,e.quote.trim()]),candidate.requiredFields,candidate.requiredRoles,candidate.requiredFields.map(key=>[key,fields[key]])]);
}
