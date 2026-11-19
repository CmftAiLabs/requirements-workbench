/** A defined workflow state is not an unanswered requirement question. */
export function unresolvedContentHint(value: string): string {
  if (!value?.trim()) return '字段为空';
  const unresolved = /待明确|待澄清|未确定|未知|待补充/.exec(value);
  if (unresolved) return value.slice(Math.max(0, unresolved.index - 16), unresolved.index + 36);
  const compact = value.replace(/\s+/gu, '');
  for (const match of compact.matchAll(/待确认/gu)) {
    const before = compact.slice(0, match.index);
    const after = compact.slice(match.index + match[0].length);
    // Keep ambiguous uses (e.g. “时限待确认”) unresolved. Only explicit
    // state declarations or state-conditioned behavior qualify as business states.
    const stateDeclaration = /(?:状态(?:为|是|设为|变为|改为|显示为|置为|包含|包括|分为)|处于)[“"'「【]?$/u.test(before);
    const stateCondition = /^[”"'」】]?(?:状态|期间|阶段|时(?!间|限|长|段|点))/u.test(after);
    const stateObject = /(?:取消|撤销|查看|处理|筛选|删除|拒绝|编辑|提交|打开|关闭|展示|显示|列出)[“"'「【]?$/u.test(before)
      && /^[”"'」】]?(?:的)?(?:预约|邀请|申请|订单|工单|单据|记录)/u.test(after);
    // E.g. “可查看待确认、已同意、已交换” names a state sequence. A normal
    // comma is deliberately excluded: “范围待确认，已安排会议” is still unclear.
    const stateSequence = /^[”"'」】]?(?:[、/→]|->)[“"'「【]?(?:已\p{Script=Han}{1,6}|被拒绝|拒绝|取消|撤销)(?=[”"'」】、/→，,。；;：:]|及|或|和|以及|$)/u.test(after)
      || /已\p{Script=Han}{1,6}[”"'」】]?(?:[、/→]|->)[“"'「【]?$/u.test(before);
    if (!stateDeclaration && !stateCondition && !stateObject && !stateSequence) return compact.slice(Math.max(0, match.index - 16), match.index + 36);
  }
  return '';
}

export const hasUnresolvedContent = (value: string): boolean => Boolean(unresolvedContentHint(value));
