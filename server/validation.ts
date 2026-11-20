import {z} from 'zod';
import {FIELDS} from '../shared/types.js';
import {organizationSchema,moduleNameSchema} from './organization-schema';
import {intakeAIReviewsSchema} from './intake-field-schema';
const id=z.string().min(1).max(120),reason=z.string().trim().min(1).max(5000);
const field=z.enum(FIELDS.map(f=>f[0]) as ['goal','scope','flow','permission','exception','data','constraint','quality','acceptance']);
const fields=z.object(Object.fromEntries(FIELDS.map(([k])=>[k,z.string().max(12000)])) as Record<typeof field._output,z.ZodString>).strict();
export const actionSchema=z.discriminatedUnion('type',[
 z.object({type:z.literal('pinChat'),cardId:id,pinned:z.boolean()}).strict(),
 z.object({type:z.literal('setPoolGrouping'),mode:z.enum(['modules','flat'])}).strict(),
 z.object({type:z.literal('renameModule'),from:moduleNameSchema,to:moduleNameSchema}).strict(),
 z.object({type:z.literal('applyModuleGrouping'),proposalId:id}).strict(),
 z.object({type:z.literal('organizeCard'),cardId:id,organization:organizationSchema}).strict(),
 z.object({type:z.literal('adoptConclusion'),cardId:id,suggestionId:id,decisions:z.partialRecord(field,z.enum(['采纳','不采纳'])),overrides:z.partialRecord(field,z.string().trim().min(1).max(6000)).optional(),resolvedBlockerIds:z.array(id).max(100).refine(ids=>new Set(ids).size===ids.length,'同一问题不能重复选择').optional()}).strict(),
 z.object({type:z.literal('updateOverview'),cardId:id,title:z.string().trim().min(1).max(120),fields,coverageGaps:z.array(z.string().trim().min(1).max(5000)).max(100),reason}).strict(),
 z.object({type:z.literal('saveIntake'),batchId:id,revision:z.number().int().positive(),drafts:z.array(z.object({id,aiReviews:intakeAIReviewsSchema.optional(),organization:organizationSchema.optional(),title:z.string().trim().min(1).max(120),fields,selected:z.boolean(),exclusionReason:z.string().trim().max(5000),coverageGaps:z.array(z.string().trim().min(1).max(5000)).max(100)}).strict()).min(1).max(100).refine(items=>new Set(items.map(item=>item.id)).size===items.length,'同一草稿不能重复提交'),importSelected:z.boolean()}).strict(),
 z.object({type:z.literal('message'),cardId:id,text:reason,replyTo:id.optional(),baseRevision:z.number().int().positive().optional(),baseRound:z.number().int().positive().optional(),clientMessageId:id.optional()}),
 z.object({type:z.literal('applySuggestion'),cardId:id,suggestionId:id,decisions:z.partialRecord(field,z.enum(['采纳','不采纳'])),overrides:z.partialRecord(field,z.string().trim().min(1).max(6000)).optional(),resolvedBlockerIds:z.array(id).max(100).refine(ids=>new Set(ids).size===ids.length,'同一问题不能重复选择').optional()}),
 z.object({type:z.literal('editCard'),cardId:id,fields,title:z.string().trim().min(1).max(120),reason}),
 z.object({type:z.literal('scope'),cardId:id,included:z.boolean(),reason:z.string().max(5000)}),
 z.object({type:z.literal('addBlocker'),cardId:id,field,reason}),
 z.object({type:z.literal('resolveBlocker'),cardId:id,blockerId:id,reason}),
 z.object({type:z.literal('pmConfirm'),cardId:id}),
 z.object({type:z.literal('businessConfirm'),cardId:id,result:z.enum(['通过','要求修改','暂无法确认']),comment:z.string().max(5000)}),
 z.object({type:z.literal('proposeChange'),cardId:id,text:reason}),
 z.object({type:z.literal('acceptChange'),cardId:id,messageId:id,field}),
 z.object({type:z.literal('submitReview')}),
 z.object({type:z.literal('review'),result:z.enum(['通过','要求修改']),comment:z.string().max(5000)}),
]);
export const actionRequest=z.object({action:actionSchema,stamp:z.number().int().nonnegative()});
export const materialRequest=z.object({name:z.string().trim().min(1).max(180),kind:z.string().max(60).optional(),location:z.string().max(300).optional(),text:z.string().min(1).max(160000)});
export const extractionRequest=z.object({materialIds:z.array(id).min(1).max(20)});
export const refinementRequest=z.object({batchId:id,parentDraftId:id,revision:z.number().int().positive()});
