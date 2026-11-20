const agentMention=/(?<![\w.%+@-])[@＠][ \t]*(?:agent|需求助手|需求伙伴|助手)(?![\w@-]|\.[a-z0-9])/i;

export const mentionsAgent=(text:string)=>agentMention.test(text);
export const mentionAgent=(text:string)=>mentionsAgent(text)?text:`@Agent ${text}`;
export function withoutLeadingAgentMention(text:string){
 const value=text.trimStart(),mention=value.match(agentMention);
 return mention?.index===0?value.slice(mention[0].length).replace(/^[\s,，:：]+/,''):text;
}
