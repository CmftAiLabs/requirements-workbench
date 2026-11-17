import test from 'node:test';
import assert from 'node:assert/strict';
import { addExtractedCards, applyAction, attachSuggestion, beginDelivery, buildMarkdown, createProject, recordDeliveryResult } from '../server/domain.ts';
import { cardStatus, versionLabel } from '../shared/types.ts';
import type { Card, ExtractedCard, Fields, Project, SuggestionDraft } from '../shared/types.ts';

const completeFields = (): Fields => ({
  goal: '客户交接后责任清晰', scope: '销售主管将单个客户交给同部门在职销售，本期不含批量交接',
  flow: '选择接收人，填写原因，提交；成功后更新客户负责人', permission: '交接成功立即撤销原负责人权限，新负责人获得编辑权限',
  exception: '无权限拒绝，任一步失败均回滚，重复提交只执行一次', data: '记录客户、原新负责人和操作人；审计日志保存一年',
  constraint: '依赖现有员工目录与权限服务', quality: '负责人和权限在同一事务提交；50 并发下 95% 请求 3 秒内完成',
  acceptance: '正常交接成功；原负责人立即无权访问；失败和重复提交不会出现不一致',
});
function draft(overrides: Partial<ExtractedCard> = {}): ExtractedCard {
  return {title: '单个客户转交', fields: completeFields(), sourceIds: ['crm-kickoff'], assessment: '可确认', issues: [], evidence: {}, ...overrides};
}
function setup(count = 1) {
  const project = createProject('CRM 需求协作');
  addExtractedCards(project, Array.from({length: count}, (_, index) => draft({title: `客户需求 ${index + 1}`})), ['crm-kickoff']);
  return {project, card: project.cards[0]};
}
function confirm(project: Project, card: Card) {
  applyAction(project, {type: 'pmConfirm', cardId: card.id}, 'pm');
  applyAction(project, {type: 'businessConfirm', cardId: card.id, result: '通过', comment: ''}, 'business');
}
function clarify(project: Project) {
  for (const card of project.cards.filter(card => card.included)) confirm(project, card);
  applyAction(project, {type: 'submitReview'}, 'pm');
  applyAction(project, {type: 'review', result: '通过', comment: '范围、权限和验收一致'}, 'reviewer');
}
function suggestion(card: Card): SuggestionDraft {
  return {summary: '业务要求临时只读七天', issues: [], changes: [
    {field: 'permission', before: card.fields.permission, after: '原负责人保留七天只读权限，到期自动撤权', reason: '经业务补充', evidence: []},
    {field: 'acceptance', before: card.fields.acceptance, after: '原负责人七天内可读不可写，第八天不能访问', reason: '与权限规则保持一致', evidence: []},
  ], dependencies: [{field: 'permission', requires: ['acceptance'], reason: '权限改为保留七天，但验收仍要求立即撤权，权限与验收条件不一致'}]};
}

test('新项目从真实可读示例材料开始；空 PRD 可预览但不能送审', () => {
  const project = createProject('CRM');
  assert.equal(project.materials.length, 4);
  assert.ok(project.materials.every(material => material.text.length > 100));
  assert.equal(project.cards.length, 0);
  assert.match(buildMarkdown(project), /空草稿/);
  assert.throws(() => applyAction(project, {type: 'submitReview'}, 'pm'), /至少需要一张/);
});

test('固定字段、抽取来源及证据验证在变更前完成', () => {
  const project = createProject('CRM');
  const fields = {...completeFields(), freeform: '自定义'} as Fields;
  assert.throws(() => addExtractedCards(project, [draft({fields})], ['crm-kickoff']), /九个字段/);
  assert.throws(() => addExtractedCards(project, [draft(), draft({sourceIds: ['missing']})], ['crm-kickoff']), /未整理/);
  assert.equal(project.cards.length, 0, '失败的整批抽取不能留下半成品');
  assert.throws(() => addExtractedCards(project, [draft({evidence: {goal: [{materialId: 'crm-kickoff', quote: '原文没有这句话'}]}})], ['crm-kickoff']), /原文/);
  const quote = '客户负责人变更与权限变更必须在同一事务完成';
  addExtractedCards(project, [draft({evidence: {quality: [{materialId: 'crm-kickoff', quote}]}})], ['crm-kickoff']);
  assert.equal(project.cards[0].type, '功能要求');
  assert.equal(project.cards[0].provenance.quality[0].quote, quote);
  assert.deepEqual(project.materials[0].cardIds, [project.cards[0].id]);
});

test('角色职责在服务端执行，Agent 与其他角色不能代人确认', () => {
  const {project, card} = setup();
  assert.throws(() => applyAction(project, {type: 'pmConfirm', cardId: card.id}, 'business'), /权限/);
  assert.throws(() => applyAction(project, {type: 'businessConfirm', cardId: card.id, result: '通过', comment: ''}, 'reviewer'), /权限/);
  assert.throws(() => applyAction(project, {type: 'scope', cardId: card.id, included: false, reason: '下期处理'}, 'business'), /权限/);
  assert.throws(() => applyAction(project, {type: 'editCard', cardId: card.id, title: card.title, fields: card.fields, reason: '核对'}, 'reviewer'), /权限/);
  assert.throws(() => applyAction(project, {type: 'pmConfirm', cardId: card.id}, 'agent' as never), /权限/);
  assert.throws(() => applyAction(project, {type: 'businessConfirm', cardId: card.id, result: '通过', comment: ''}, 'business'), /先由产品/);
});

test('产品与业务必须确认同修订同轮；编辑无变化不会升修订或回退', () => {
  const {project, card} = setup();
  clarify(project);
  assert.equal(cardStatus(card), '已确认');
  assert.equal(project.phase, '已明确');
  const round = card.round;
  applyAction(project, {type: 'editCard', cardId: card.id, title: card.title, fields: {...card.fields}, reason: '复核无变化'}, 'pm');
  assert.equal(card.revision, 1);
  assert.equal(card.round, round);
  assert.equal(project.phase, '已明确');
  applyAction(project, {type: 'editCard', cardId: card.id, title: card.title, fields: {...card.fields, permission: '仅允许本部门销售主管执行交接'}, reason: '收紧交接权限'}, 'pm');
  assert.equal(card.revision, 2);
  assert.equal(card.round, round + 1);
  assert.deepEqual(card.approvals, {});
  assert.equal(card.confirmations.length, 2, '旧确认保留为历史证据');
  assert.equal(project.phase, '可讨论');
  assert.equal(cardStatus(card), '可确认');
});

test('未知字段和显式阻断不可确认，解决需记录依据', () => {
  const {project, card} = setup();
  applyAction(project, {type: 'editCard', cardId: card.id, title: card.title, fields: {...card.fields, quality: '待明确'}, reason: '性能需要再确认'}, 'pm');
  assert.throws(() => applyAction(project, {type: 'pmConfirm', cardId: card.id}, 'pm'), /九个字段/);
  applyAction(project, {type: 'editCard', cardId: card.id, title: card.title, fields: completeFields(), reason: '业务补齐性能要求'}, 'pm');
  applyAction(project, {type: 'addBlocker', cardId: card.id, field: 'permission', reason: '是否允许跨部门仍有争议'}, 'reviewer');
  assert.throws(() => applyAction(project, {type: 'pmConfirm', cardId: card.id}, 'pm'), /阻断/);
  assert.throws(() => applyAction(project, {type: 'resolveBlocker', cardId: card.id, blockerId: card.blockers[0].id, reason: '业务已经回复'}, 'business'), /产品经理/);
  assert.throws(() => applyAction(project, {type: 'resolveBlocker', cardId: card.id, blockerId: card.blockers[0].id, reason: ''}, 'pm'), /解决依据/);
  applyAction(project, {type: 'resolveBlocker', cardId: card.id, blockerId: card.blockers[0].id, reason: '业务确认本期仅同部门转交'}, 'pm');
  confirm(project, card);
  assert.equal(cardStatus(card), '已确认');
});

test('暂无法确认保留产品确认，要求修改清确认并回退', () => {
  const {project, card} = setup();
  applyAction(project, {type: 'pmConfirm', cardId: card.id}, 'pm');
  applyAction(project, {type: 'businessConfirm', cardId: card.id, result: '暂无法确认', comment: '需要先核对权限制度'}, 'business');
  assert.ok(card.approvals.pm);
  assert.equal(card.approvals.business, undefined);
  applyAction(project, {type: 'businessConfirm', cardId: card.id, result: '要求修改', comment: '需补充离职人员不能接收'}, 'business');
  assert.deepEqual(card.approvals, {});
  assert.equal(project.phase, '可讨论');
  assert.equal(cardStatus(card), '待澄清');
  assert.equal(card.confirmations.length, 3);
});

test('Agent 建议必须使用同一卡片修订和最新消息，普通讨论不回退', () => {
  const {project, card} = setup();
  clarify(project);
  attachSuggestion(project, card.id, suggestion(card), card.revision, card.messages.length);
  const originalSuggestion = card.suggestion!;
  applyAction(project, {type: 'message', cardId: card.id, text: '补充：这项规则可以在下一期再评估'}, 'business');
  assert.equal(project.phase, '已明确');
  assert.equal(cardStatus(card), '已确认');
  assert.equal(originalSuggestion.status, '已失效');
  assert.throws(() => applyAction(project, {type: 'applySuggestion', cardId: card.id, suggestionId: originalSuggestion.id, decisions: {permission: '采纳', acceptance: '采纳'}}, 'pm'), /过期/);
  assert.throws(() => attachSuggestion(project, card.id, suggestion(card), card.revision, 0), /已经变化/);
  assert.throws(() => attachSuggestion(project, card.id, suggestion(card), 0, card.messages.length), /已经变化/);
});

test('审核选择完整后一次写入；明确的关联冲突才创建具体问题', () => {
  const {project, card} = setup();
  attachSuggestion(project, card.id, suggestion(card), 1, 0);
  const suggestionId = card.suggestion!.id;
  const originalPermission = card.fields.permission;
  assert.throws(() => applyAction(project, {type: 'applySuggestion', cardId: card.id, suggestionId, decisions: {permission: '采纳'}}, 'pm'), /所有变化字段/);
  assert.equal(card.fields.permission, originalPermission);
  assert.equal(card.revision, 1);
  applyAction(project, {type: 'applySuggestion', cardId: card.id, suggestionId, decisions: {permission: '采纳', acceptance: '不采纳'}}, 'pm');
  assert.equal(card.revision, 2);
  assert.match(card.fields.permission, /七天/);
  assert.match(card.fields.acceptance, /立即/);
  assert.equal(card.suggestion!.status, '已写入');
  assert.throws(() => applyAction(project, {type: 'pmConfirm', cardId: card.id}, 'pm'), /阻断/);
  assert.equal(card.blockers[0].reason, '权限改为保留七天，但验收仍要求立即撤权，权限与验收条件不一致');
});

test('全部不采纳不产生新修订，也不使既有确认或阶段失效', () => {
  const {project, card} = setup();
  clarify(project);
  attachSuggestion(project, card.id, suggestion(card), 1, 0);
  applyAction(project, {type: 'applySuggestion', cardId: card.id, suggestionId: card.suggestion!.id, decisions: {permission: '不采纳', acceptance: '不采纳'}}, 'pm');
  assert.equal(card.revision, 1);
  assert.equal(cardStatus(card), '已确认');
  assert.equal(project.phase, '已明确');
});

test('未纳入的新想法不回退；产品纳入才清受影响卡确认，其他卡保持', () => {
  const {project, card} = setup(2);
  clarify(project);
  const other = project.cards[1];
  const oldSnapshot = structuredClone(project.snapshots.at(-1));
  applyAction(project, {type: 'proposeChange', cardId: card.id, text: '希望原负责人保留七天只读'}, 'business');
  assert.equal(project.phase, '已明确');
  assert.equal(cardStatus(card), '已确认');
  applyAction(project, {type: 'acceptChange', cardId: card.id, messageId: card.messages.at(-1)!.id, field: 'permission'}, 'pm');
  assert.equal(project.phase, '可讨论');
  assert.equal(cardStatus(card), '待澄清');
  assert.equal(cardStatus(other), '已确认');
  assert.deepEqual(project.snapshots.at(-1), oldSnapshot, '历史快照不能随当前消息与卡片变更');
});

test('本期范围必须说明原因；全部本期卡确认才可整体评审', () => {
  const {project, card} = setup(2);
  confirm(project, card);
  assert.throws(() => applyAction(project, {type: 'submitReview'}, 'pm'), /全部卡片/);
  const excluded = project.cards[1];
  assert.throws(() => applyAction(project, {type: 'scope', cardId: excluded.id, included: false, reason: ''}, 'pm'), /原因/);
  applyAction(project, {type: 'scope', cardId: excluded.id, included: false, reason: '不属于本期建设范围'}, 'pm');
  assert.equal(cardStatus(excluded), '本期不纳入');
  applyAction(project, {type: 'submitReview'}, 'pm');
  assert.equal(project.phase, '可评审');
  assert.match(project.snapshots.at(-1)!.markdown, /不属于本期建设范围/);
  assert.throws(() => applyAction(project, {type: 'review', result: '通过', comment: ''}, 'pm'), /权限/);
  applyAction(project, {type: 'review', result: '要求修改', comment: '请核对排除边界'}, 'reviewer');
  assert.equal(project.phase, '可讨论');
  assert.equal(cardStatus(card), '已确认', '整体评审拒绝不会任意清空未改变卡片的确认');
  assert.throws(() => applyAction(project, {type: 'submitReview'}, 'pm'), /被退回/);
  applyAction(project, {type: 'scope', cardId: excluded.id, included: false, reason: '跨部门批量导出不属于本期单客转交范围，下期另行评估'}, 'pm');
  applyAction(project, {type: 'submitReview'}, 'pm');
  assert.equal(versionLabel(project), 'V0.0.2');
});

test('两端同版本交付、失败冻结与幂等重试；只有双成功才推进大版本', () => {
  const {project, card} = setup();
  clarify(project);
  assert.equal(versionLabel(project), 'V0.1.0');
  const delivery = beginDelivery(project, 'pm', 'local');
  assert.equal(delivery.snapshot.version, 'V1.0.0');
  assert.equal(versionLabel(project), 'V0.1.0');
  const frozen = structuredClone(delivery.snapshot);
  assert.match(delivery.targets[0].name, /本地验收/);
  assert.throws(() => applyAction(project, {type: 'editCard', cardId: card.id, title: card.title, fields: {...card.fields, goal: '新目标'}, reason: '变更'}, 'pm'), /冻结交付/);
  assert.throws(() => applyAction(project, {type: 'scope', cardId: card.id, included: false, reason: '下期'}, 'pm'), /冻结交付/);
  recordDeliveryResult(project, delivery.id, 'knowledge', {ok: true, receipt: 'local://knowledge/PRD.md'});
  recordDeliveryResult(project, delivery.id, 'teammate', {ok: false, error: '连接超时'});
  assert.equal(project.phase, '已明确');
  assert.equal(versionLabel(project), 'V0.1.0');
  assert.throws(() => beginDelivery(project, 'pm', 'http'), /沿用/);
  applyAction(project, {type: 'message', cardId: card.id, text: '交付后再讨论下一期'}, 'pm');
  const retry = beginDelivery(project, 'pm', 'local');
  assert.equal(retry.id, delivery.id);
  assert.equal(retry.targets[0].attempts, 1);
  assert.equal(retry.targets[1].attempts, 2);
  assert.deepEqual(retry.snapshot, frozen);
  recordDeliveryResult(project, delivery.id, 'knowledge', {ok: false, error: '重复回调不应覆盖成功'});
  assert.equal(delivery.targets[0].status, '成功');
  assert.throws(() => recordDeliveryResult(project, delivery.id, 'teammate', {ok: true}), /回执/);
  recordDeliveryResult(project, delivery.id, 'teammate', {ok: true, receipt: 'local://teammate/PRD.md'});
  assert.equal(project.phase, '已交付');
  assert.equal(versionLabel(project), 'V1.0.0');
  assert.equal(project.snapshots.at(-1)!.markdown, frozen.markdown);
  assert.ok(delivery.completedAt);
});

test('交付后变更形成新轮次，版本递进且历史材料和确认都不变', () => {
  const {project, card} = setup();
  clarify(project);
  const delivery = beginDelivery(project, 'pm', 'local');
  recordDeliveryResult(project, delivery.id, 'knowledge', {ok: true, receipt: '本地知识中台回执'});
  recordDeliveryResult(project, delivery.id, 'teammate', {ok: true, receipt: '本地 TeamMate 回执'});
  const before = structuredClone(delivery.snapshot);
  applyAction(project, {type: 'editCard', cardId: card.id, title: card.title, fields: {...card.fields, permission: '原负责人保留七天只读权限，到期自动撤权', acceptance: '七天内可读不可写，第八天无权访问'}, reason: '经业务明确的七天只读变更'}, 'pm');
  project.materials[0].text += '\n后续材料附注';
  assert.equal(versionLabel(project), 'V1.0.0');
  assert.equal(project.phase, '可讨论');
  confirm(project, card);
  applyAction(project, {type: 'submitReview'}, 'pm');
  assert.equal(versionLabel(project), 'V1.0.1');
  applyAction(project, {type: 'review', result: '通过', comment: '七天只读规则明确'}, 'reviewer');
  assert.equal(versionLabel(project), 'V1.1.0');
  assert.equal(beginDelivery(project, 'pm', 'local').snapshot.version, 'V2.0.0');
  assert.deepEqual(delivery.snapshot, before);
  assert.match(before.cards[0].fields.permission, /立即撤销/);
  assert.equal(before.cards[0].approvals.business!.revision, 1);
});
