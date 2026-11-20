import {hasUnresolvedContent} from './requirement-clarity';
import type {ParticipantId} from './participants';
export const FIELDS = [
  ['goal','业务目标'],['scope','场景与范围'],['flow','功能与流程'],['permission','权限规则'],
  ['exception','异常处理'],['data','数据要求'],['constraint','依赖约束'],['quality','质量要求'],['acceptance','验收条件'],
] as const;
export type FieldKey = typeof FIELDS[number][0];
export type Fields = Record<FieldKey,string>;
export const ROLES = {pm:'林舟 · 产品经理',business:'陈敏 · 业务负责人',reviewer:'周衡 · 历史参与者'} as const;
export type Role = keyof typeof ROLES;
export type Phase = '可讨论'|'可评审'|'已明确'|'已交付';
export type CardStatus = '需评估'|'待澄清'|'可确认'|'已确认'|'本期不纳入';
export type Granularity = '概要'|'具体';
export type IntakeOrigin = '材料要求'|'建议补充';
export const COMMUNICATION_PRIORITIES = ['优先沟通','正常沟通','后续沟通'] as const;
export type CommunicationPriority = typeof COMMUNICATION_PRIORITIES[number];
export interface CardOrganization {module:string;priority:CommunicationPriority;reason:string}
export type PoolGrouping = 'modules'|'flat';
export interface ModuleGroupingSuggestion {mode:PoolGrouping;summary:string;groups:{name:string;cardIds:string[]}[]}
export interface ModuleGroupingProposal extends ModuleGroupingSuggestion {id:string;jobId:string;base:string;createdAt:string}
export type ConfirmationResult = '通过'|'要求修改'|'暂无法确认';
export interface Evidence {materialId?:string;messageId?:string;quote:string;location?:string}
export interface AISupplement {text:string;reason:string;evidence?:Evidence[]}
export interface IntakeAIReview {text:string;decision?:'保留'|'删除';reviewedText?:string;reviewedBase?:string}
export type AISupplements = Partial<Record<FieldKey,AISupplement>>;
export type IntakeAIReviews = Partial<Record<FieldKey,IntakeAIReview>>;
export interface AIFieldOrigin extends AISupplement {fieldValue:string;reviewedAt:string;reviewedBy:Role}
export interface ArchiveEntry {path:string;materialId?:string;error?:string}
export interface Material {intake?:{groupId:string;status:'pending'|'failed';error?:string};textLength?:number;textAvailable?:boolean;textVersion?:string;id:string;name:string;kind:string;location:string;text:string;status:'待解析'|'待整理'|'已整理'|'已生成候选卡'|'处理中'|'已展开';cardIds:string[];createdAt:string;filePath?:string;error?:string;mimeType?:string;sourceArchive?:{id:string;name:string;path:string};archiveEntries?:ArchiveEntry[];sourceConversation?:{cardId:string;messageId:string;participantId:ParticipantId}}
export interface ConversationMaterialReply {contextMessageId:string;sourceMessageIds:string[];materialIds:string[];clarifiesCurrent:boolean;intakeBatchId?:string;relatedCardIds:string[];evidence:Evidence[];warnings:string[]}
export interface Message {assessmentId?:string;participantId?:ParticipantId;id:string;role:Role|'agent';text:string;createdAt:string;kind?:'discussion'|'change';accepted?:boolean;replyTo?:string;materialIds?:string[];clientMessageId?:string;materialReply?:ConversationMaterialReply}
export interface FollowUp {activeSourceMessageId?:string;activeSince?:string;answerHistory?:{messageId:string;answeredAt?:string;withdrawnByMessageId:string;withdrawnAt:string}[];participantId?:ParticipantId;id:string;field:FieldKey;question:string;options:string[];role:Role;createdAt:string;baseRevision:number;sourceMessageId:string;status:'waiting'|'answered'|'superseded'|'deferred';answerMessageId?:string;answeredAt?:string}
export type QuestionPurpose='usage'|'business_rule'|'business_conflict'|'scope'|'design_feedback'|'design_choice';
export interface DiscussionAnalysis {reopenQuestion?:{questionId:string;messageId:string;quote:string}|null;deferQuestion?:{questionId:string;sourceMessageId:string;reason:string}|null;replyRequest?:{participantId:ParticipantId;purpose:QuestionPurpose}|null;handling?:import('./expert-discussion').DiscussionHandling;reply?:string;answer:{questionId:string;messageId:string;quote:string}|null;question:{participantId?:ParticipantId;field:FieldKey;question:string;options:string[];role:Role}|null;summarize:boolean}
export interface Confirmation {participantId?:ParticipantId;id:string;role:Role;revision:number;round:number;result:ConfirmationResult;comment:string;createdAt:string}
export interface Blocker {id:string;field:FieldKey;reason:string;resolved:boolean;createdAt:string;resolution?:string;resolutionEvidence?:Evidence[];resolvedAt?:string;resolvedBy?:Role;resolutionSuggestionId?:string}
export interface FieldChange {field:FieldKey;before:string;after:string;reason:string;evidence:Evidence[]}
export interface ChangeDependency {field:FieldKey;requires:FieldKey[];reason:string}
export interface ProblemResolution {scopeReview?:{basis:string};blockerId:string;resolution:string;evidence:Evidence[];requiredFields:FieldKey[];requiredRoles:('business'|'pm'|'reviewer')[]}
export interface Suggestion {processedAt?:string;origin?:'model'|'example';id:string;baseRevision:number;messageCount:number;summary:string;issues:string[];changes:FieldChange[];dependencies?:ChangeDependency[];problemResolutions?:ProblemResolution[];createdAt:string;status:'待决定'|'已写入'|'已失效';decisions?:Partial<Record<FieldKey,'采纳'|'不采纳'>>;overrides?:Partial<Record<FieldKey,string>>}
export interface CardRevision {revision:number;fields:Fields;reason:string;createdAt:string}
export interface Card {aiOrigins?:Partial<Record<FieldKey,AIFieldOrigin>>;assessments?:import('./expert-discussion').RequirementAssessment[];messageCount?:number;messageVersion?:string;historyCount?:number;followUps?:FollowUp[];assistantCursor?:string;organization?:CardOrganization;id:string;title:string;type:'功能要求';revision:number;round:number;fields:Fields;sources:string[];provenance:Record<FieldKey,Evidence[]>;included:boolean;exclusionReason:string;assessment:'需评估'|'待澄清'|'可确认';issues:string[];messages:Message[];suggestion?:Suggestion;blockers:Blocker[];approvals:Partial<Record<'pm'|'business',Confirmation>>;confirmations:Confirmation[];history:CardRevision[];granularity?:Granularity;parentId?:string;intakeDraftId?:string;coverageGaps?:string[]}
export interface Snapshot {cardCount?:number;deferred?:boolean;id:string;version:string;phase:Phase;createdAt:string;cards:Card[];excluded:{id:string;title:string;reason:string}[];materials:Material[];markdown:string;reviewComment?:string}
export interface DeliveryTarget {key:'knowledge'|'teammate';name:string;status:'待交付'|'交付中'|'成功'|'失败';attempts:number;receipt?:string;error?:string;updatedAt?:string}
export interface Delivery {id:string;snapshot:Snapshot;targets:DeliveryTarget[];createdAt:string;completedAt?:string;mode:'http'|'local'}
export interface AuditEvent {participantId?:ParticipantId;id:string;action:string;role:Role|'system';detail:string;createdAt:string}
export interface ConferenceDemo {kind:'conference';title:string;date:string;preparedAt:string;appointments:'preview'|'included'|'excluded';payment:'pending'|'simulated'|'excluded';assumptions:string[]}
export interface Project {generatedDemo?:import('./generated-demo').GeneratedDemo;chatPins?:Partial<Record<Role|ParticipantId,string[]>>;poolGrouping?:PoolGrouping;moduleProposal?:ModuleGroupingProposal;moduleOrder?:string[];example?:'crm';demo?:ConferenceDemo;id:string;name:string;stamp:number;phase:Phase;version:[number,number,number];cards:Card[];materials:Material[];snapshots:Snapshot[];deliveries:Delivery[];events:AuditEvent[];createdAt:string;intakeBatches?:IntakeBatch[]}
export interface ExtractedCard {organization?:CardOrganization;title:string;fields:Fields;sourceIds:string[];assessment:'需评估'|'待澄清'|'可确认';issues:string[];evidence:Partial<Record<FieldKey,Evidence[]>>}
export interface IntakeCandidate extends ExtractedCard {aiSupplements?:AISupplements;key:string;parentKey?:string;granularity:Granularity;origin:IntakeOrigin;rationale:string;coverageGaps:string[];relatedCardId?:string}
export interface IntakeDraft extends ExtractedCard {aiSupplements?:AISupplements;aiReviews?:IntakeAIReviews;id:string;parentId?:string;granularity:Granularity;origin:IntakeOrigin;rationale:string;coverageGaps:string[];selected:boolean;exclusionReason:string;acceptedExclusionReason?:string;acceptedExclusionTitle?:string;poolCardId?:string;relatedCardId?:string;editedFields?:FieldKey[]}
export interface IntakeBatch {id:string;materialIds:string[];drafts:IntakeDraft[];revision:number;createdAt:string}
export interface SuggestionDraft {summary:string;issues:string[];changes:FieldChange[];dependencies?:ChangeDependency[];problemResolutions?:ProblemResolution[]}
export interface Job {id:string;projectId:string;kind:'parse'|'extract'|'refine'|'suggest'|'deliver'|'group'|'listen'|'demo';status:'queued'|'running'|'succeeded'|'failed';label:string;error?:string;createdAt:string;finishedAt?:string;cardId?:string;result?:unknown}
export type Action =
 | {type:'pinChat';cardId:string;pinned:boolean}
 | {type:'setPoolGrouping';mode:PoolGrouping}
 | {type:'renameModule';from:string;to:string}
 | {type:'applyModuleGrouping';proposalId:string}
 | {type:'organizeCard';cardId:string;organization:CardOrganization}
 | {type:'adoptConclusion';cardId:string;suggestionId:string;decisions:Partial<Record<FieldKey,'采纳'|'不采纳'>>;overrides?:Partial<Record<FieldKey,string>>;resolvedBlockerIds?:string[]}
 | {type:'updateOverview';cardId:string;title:string;fields:Fields;coverageGaps:string[];reason:string}
 | {type:'saveIntake';batchId:string;revision:number;drafts:{id:string;aiReviews?:IntakeAIReviews;organization?:CardOrganization;title:string;fields:Fields;selected:boolean;exclusionReason:string;coverageGaps:string[]}[];importSelected:boolean}
 | {type:'message';cardId:string;text:string;replyTo?:string;baseRevision?:number;baseRound?:number;clientMessageId?:string}
 | {type:'applySuggestion';cardId:string;suggestionId:string;decisions:Partial<Record<FieldKey,'采纳'|'不采纳'>>;overrides?:Partial<Record<FieldKey,string>>;resolvedBlockerIds?:string[]}
 | {type:'editCard';cardId:string;fields:Fields;title:string;reason:string}
 | {type:'scope';cardId:string;included:boolean;reason:string}
 | {type:'addBlocker';cardId:string;field:FieldKey;reason:string}
 | {type:'resolveBlocker';cardId:string;blockerId:string;reason:string}
 | {type:'pmConfirm';cardId:string}
 | {type:'businessConfirm';cardId:string;result:ConfirmationResult;comment:string}
 | {type:'proposeChange';cardId:string;text:string}
 | {type:'acceptChange';cardId:string;messageId:string;field:FieldKey}
 | {type:'submitReview'}
 | {type:'review';result:'通过'|'要求修改';comment:string};
export interface Bootstrap {participantId:ParticipantId;projects:{id:string;name:string}[];project:Project;role:Role;jobs:Job[];config:{model:string;modelConfigured:boolean;knowledgeConfigured:boolean;teammateConfigured:boolean;localOnly:boolean}}

export function cardStatus(card:Card):CardStatus {
 if(!card.included)return '本期不纳入';
 if(card.granularity==='概要')return '待澄清';
 const passed=(r:'pm'|'business')=>card.approvals[r]?.revision===card.revision&&card.approvals[r]?.round===card.round&&card.approvals[r]?.result==='通过';
 // Conversation questions do not revoke a human-approved requirement revision.
 if(passed('pm')&&passed('business')&&!card.blockers.some(b=>!b.resolved))return '已确认';
 if(card.followUps?.some(q=>q.baseRevision===card.revision&&['waiting','deferred'].includes(q.status)))return '待澄清';
 if(card.assessment==='需评估')return '需评估';
 if(card.blockers.some(b=>!b.resolved))return '待澄清';
 if(Object.values(card.fields).some(v=>hasUnresolvedContent(v)))return '待澄清';
 return '可确认';
}
export const versionLabel=(p:Pick<Project,'version'>)=>'V'+p.version.join('.');
