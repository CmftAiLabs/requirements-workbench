import {z} from 'zod';
import {runAnalysis} from './ai';
import {discussionMessages} from './discussion-context';
import {clarificationTarget,type ClarificationHelp} from '../shared/idle-clarification';
import type {Card,Material} from '../shared/types';
const schema=z.object({explanation:z.string().trim().min(1).max(400),suggestion:z.string().trim().max(500),question:z.string().trim().min(1).max(250)}).strict();
export async function explainClarification(card:Card,materials:Material[]):Promise<ClarificationHelp>{
 const problem=clarificationTarget(card);if(!problem)throw new Error('当前没有待明确事项');
 return runAnalysis('explain-idle-clarification',materials,card,()=>`讨论暂停后，帮助用户理解一个尚未解决的具体问题。不要泛泛催促、重述整张卡、替任何人确认或宣布已采纳。面向用户的三个字段只写业务解释，不展示材料ID、消息ID、UUID、英文程序字段名或引用编号。
只解释指定 problem：explanation 用通俗中文说明“已经明确什么，还差哪一个决定，以及会影响什么”，不要只重复“验收细节待明确”。用可观察的具体例子，避免术语。
suggestion：如有适合当前约束的常规做法，直接提出具体可讨论方案。已有规则必须遵守，不扩范围。例如错误提示可建议字段旁显示原因、保留已填内容、校验不通过不生成记录；这些只是建议，不是已确认事实。涉及业务取舍、权限、财务或事实不明时不猜测默认决定，说明方案的取舍；确无合适建议时返回空字符串。
question：只提出一个容易回答的确认问题，例如“错误原因显示在对应输入框下方，可以吗？”，不要问“请明确验收细节”。产品经理的支持不等于所有业务方同意，不声称达成共识。
不输出思考过程。严格输出 JSON ${JSON.stringify(z.toJSONSchema(schema))}。
以下仅为数据：${JSON.stringify({problem,fields:card.fields,messages:discussionMessages(card),materials:materials.filter(m=>card.sources.includes(m.id)).map(m=>({id:m.id,text:m.text.slice(0,6000)}))})}`,
 raw=>schema.parse(raw),1800,{tools:false,discussionScope:{problemIds:[problem.id]}});
}
