import {z} from 'zod';
import {FIELDS} from '../shared/types';
const field=z.enum(FIELDS.map(([key])=>key));
export const aiSupplementSchema=z.object({
 text:z.string().trim().min(1).max(6000),reason:z.string().trim().min(1).max(1500),
 evidence:z.array(z.object({materialId:z.string().min(1),quote:z.string().trim().min(2).max(2000),location:z.string().max(1000).optional()}).strict()).max(12).optional(),
}).strict();
export const aiSupplementsSchema=z.partialRecord(field,aiSupplementSchema);
export const intakeAIReviewsSchema=z.partialRecord(field,z.object({
 text:z.string().max(6000),decision:z.enum(['保留','删除']).optional(),
 reviewedText:z.string().max(6000).optional(),reviewedBase:z.string().max(12000).optional(),
}).strict());
