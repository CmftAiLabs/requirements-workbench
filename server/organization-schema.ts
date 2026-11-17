import {z} from 'zod';
import {COMMUNICATION_PRIORITIES} from '../shared/types';
export const organizationSchema=z.object({
 module:z.string().trim().min(1).max(30),
 priority:z.enum(COMMUNICATION_PRIORITIES),
 reason:z.string().trim().min(1).max(240),
}).strict();
export const moduleNameSchema=z.string().trim().min(1).max(30);
export const moduleGroupingSchema=z.object({
 mode:z.enum(['modules','flat']),summary:z.string().trim().min(1).max(1000),
 groups:z.array(z.object({name:moduleNameSchema,cardIds:z.array(z.string().min(1).max(120)).min(1).max(500)}).strict()).max(30),
}).strict();
