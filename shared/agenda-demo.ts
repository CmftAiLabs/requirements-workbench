import type {Fields} from './types.ts';

export type AgendaBehavior={clearSearch:boolean;retryLoad:boolean;keepKeywordOnRetry:boolean};
const actionNames={
 clearSearch:'(?:清空|清除)(?:搜索(?:条件)?|关键词|筛选条件)',
 retryLoad:'(?:重试|重新加载)',
};

/** Compile only the two supported interactions; unknown rules keep the original preview. */
export function agendaBehavior(fields:Fields):AgendaBehavior{
 const texts=[fields.exception,fields.flow,fields.acceptance].map(text=>text.normalize('NFKC').replace(/[“”「」『』"'\s]/g,''));
 const enabled=(name:string)=>{
  const mentions=texts.flatMap(text=>text.split(/[。；;\n]/)).filter(text=>new RegExp(name).test(text));
  // A human rejection or contradictory rule must not be re-enabled by old acceptance text.
  const negative=new RegExp(`(?:不(?:再)?(?:提供|显示|展示|支持|保留|设置|增加|需要)|取消|去掉|移除|隐藏|禁止使用|无需(?:提供|显示|增加)?|暂不做|不做|不设)[^。；]{0,12}${name}|${name}(?:按钮|功能|入口)?(?:不提供|不显示|不支持|取消|移除|隐藏)`);
  if(mentions.some(text=>negative.test(text)))return false;
  const uncertain=new RegExp(`(?:是否|要不要|需不需要)[^。；]{0,14}${name}|${name}(?:按钮|功能|入口)?(?:是否|要不要|需不需要|(?:尚|仍)?待(?:明确|确认))`);
  return mentions.some(text=>!uncertain.test(text)&&new RegExp(`(?:提供|增加|设置|点击|点选|允许|支持|可用)[^。；]{0,16}${name}|${name}(?:按钮|入口)|${name}后`).test(text));
 };
 const retryLoad=enabled(actionNames.retryLoad);
 const resetOnRetry=texts.some(text=>/(?:重试|重新加载)(?:成功)?(?:时|后)(?:应|可|会|需要|将|自动){0,3}(?:清空|清除|重置|不保留)(?:原有|原)?(?:关键词|搜索条件|筛选条件)/.test(text));
 return {clearSearch:enabled(actionNames.clearSearch),retryLoad,keepKeywordOnRetry:!resetOnRetry};
}
