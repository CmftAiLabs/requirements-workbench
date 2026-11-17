import type {Evidence,FieldKey,ConversationMaterialReply} from './types';

export const EXPERT_NAMES={pm:'PM 视角',analyst:'业务分析视角',ux:'UX 视角'} as const;
export type ExpertRole=keyof typeof EXPERT_NAMES;
export interface DiscussionHandling {
 mode:'quiet'|'direct'|'deep';
 trigger:'none'|'explicit'|'conflict'|'tradeoff'|'coupled_rules';
 reason:string;
}
export interface AssessmentReport {
 conclusion:string;
 perspectives:{role:ExpertRole;opinion:string;reason:string;fields:FieldKey[]}[];
 alternatives:{option:string;benefit:string;cost:string}[];
 evidence:Evidence[];
 unresolved:string[];
 coverage:string;
}
export interface RequirementAssessment {
 id:string;jobId:string;sourceMessageId:string;baseRevision:number;
 createdAt:string;updatedAt:string;
 status:'running'|'completed'|'failed'|'superseded'|'cancelled';
 reason:string;error?:string;report?:AssessmentReport;questionId?:string;
 materialReply?:ConversationMaterialReply;
 methodVersion:'requirements-session-v1';
}
