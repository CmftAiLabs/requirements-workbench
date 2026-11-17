import type {Card} from './types';

export const CLARIFICATION_IDLE_MS=90_000;
export interface ClarificationHelp {explanation:string;suggestion:string;question:string}
export function clarificationTarget(card:Card){return card.blockers.find(b=>!b.resolved);}
export function clarificationKey(card:Card){
 const problem=clarificationTarget(card);
 return problem?JSON.stringify([card.id,problem.id,problem.reason]):'';
}
export function clarificationBasis(card:Card){
 return JSON.stringify([clarificationKey(card),card.revision,card.messages.at(-1)?.id]);
}
export function shouldShowClarification({idleMs,enabled,seen,typing,waiting,running}:{idleMs:number;enabled:boolean;seen:boolean;typing:boolean;waiting:boolean;running:boolean}){
 return enabled&&!seen&&!typing&&!waiting&&!running&&idleMs>=CLARIFICATION_IDLE_MS;
}
