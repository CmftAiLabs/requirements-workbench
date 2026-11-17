// Gateway IDs are case-sensitive. A catalog entry is not a capability claim.
export const MODEL_OPTIONS=[
 'deepseek-v4.1-flash-1017','cmft-qwen3.8-flash-next','CMFT-glm-5.3-flash',
 'cmhk-deepseek-v4-flash','qwen3.8-max','glm-5.3','kimi-k3.1-pro','gpt-6-sol','claude-opus-5-5',
] as const;
let selected:string|undefined;
export const currentModel=()=>selected||process.env.MODEL_NAME||'kimi-k3.1-pro';
export const visionModel=()=>process.env.VISION_MODEL_NAME||process.env.MODEL_NAME||'kimi-k3.1-pro';
export const modelOptions=()=>[...new Set<string>([...MODEL_OPTIONS,currentModel()])];
export function setSelectedModel(value:string|undefined){selected=value;}
export function modelProviderOptions(model:string,withTools=false){
 // GPT-6 Sol Chat Completions requires none for tool calls. Plain text uses low.
 if(['cmft-qwen3.8-flash-next','qwen3.8-max','CMFT-glm-5.3-flash','glm-5.3','claude-opus-5-5'].includes(model))return {openaiCompatible:{reasoningEffort:'low' as const}};
 if(model==='gpt-6-sol')return {openaiCompatible:{reasoningEffort:withTools?'none' as const:'low' as const}};
 return /^kimi-k3(?:$|[-.])/i.test(model)||/(?:^|[-_])deepseek-v4(?:$|[-.])/i.test(model)?{openaiCompatible:{reasoningEffort:'low' as const}}:undefined;
}

export function modelReasoningDescription(model:string){
 if(model==='cmft-qwen3.8-flash-next')return '低思考（low）已验证；当前通道在复杂需求评估中多次出现 JSON 格式错误，建议优先使用已通过评估验证的其他模型。';
 if(model==='gpt-6-sol')return '低思考；调用只读检索工具时使用 none，以兼容当前 Chat Completions 接口。';
 if(['cmft-qwen3.8-flash-next','qwen3.8-max','CMFT-glm-5.3-flash','glm-5.3','claude-opus-5-5'].includes(model))return '低思考（low）；当前网关已验证 reasoning_effort 映射，不发送未经验证的原生思考开关。';
 if(modelProviderOptions(model))return '低思考（low），为结构化结果保留输出预算。';
 return '使用网关默认思考设置；尚未验证此通道的专用思考参数映射，不强行发送通用 low。';
}
export const modelPolicies=()=>Object.fromEntries(modelOptions().map(model=>[model,modelReasoningDescription(model)]));
