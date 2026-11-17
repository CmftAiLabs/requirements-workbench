import test from 'node:test';
import assert from 'node:assert/strict';
import { getChatDisabledReason, type ChatOperation } from '../shared/chat-policy.ts';
import { cardStatus } from '../shared/types.ts';
import type { Fields, Role } from '../shared/types.ts';
import { addExtractedCards, applyAction, attachSuggestion, beginDelivery, createProject } from '../server/domain.ts';

const fields: Fields = {goal: '责任清晰', scope: '同部门单个客户，不含批量', flow: '主管选择接收人后提交', permission: '交接后原负责人撤权', exception: '失败回滚', data: '保存交接记录一年', constraint: '现有权限服务', quality: '事务一致', acceptance: '成功后原负责人不能访问'};
function setup() {
  const project = createProject('沟通权限测试');
  addExtractedCards(project, [{title: '客户转交', fields: {...fields}, sourceIds: ['crm-kickoff'], assessment: '可确认', issues: [], evidence: {}}], ['crm-kickoff']);
  const card = project.cards[0];
  const reason = (operation: ChatOperation, role: Role = 'pm', extra = {}) => getChatDisabledReason(operation, {project, card, role, ...extra});
  const proposal = () => attachSuggestion(project, card.id, {summary: '业务提出七天只读', issues: [], changes: [{field: 'permission', before: card.fields.permission, after: '原负责人保留七天只读权限', reason: '业务补充规则', evidence: []}]}, card.revision, card.messages.length);
  const freeze = () => {
    applyAction(project, {type: 'pmConfirm', cardId: card.id}, 'pm');
    applyAction(project, {type: 'businessConfirm', cardId: card.id, result: '通过', comment: ''}, 'business');
    applyAction(project, {type: 'submitReview'}, 'pm');
    applyAction(project, {type: 'review', result: '通过', comment: '审核通过'}, 'reviewer');
    return beginDelivery(project, 'pm', 'local');
  };
  return {project, card, reason, proposal, freeze};
}

test('沟通群角色权限明确，角色原因优先于冻结和处理中状态', () => {
  const {project, card, reason, freeze} = setup();
  for (const role of ['pm', 'business', 'reviewer'] as const) {
    assert.equal(reason('discuss', role), '');
    assert.equal(reason('addBlocker', role), '');
    assert.equal(reason('suggest', role), '', '参与者均可请求 Agent，正式采纳仍仅产品经理');
  }
  for (const operation of ['editCard', 'acceptChange', 'applySuggestion', 'resolveBlocker', 'pmConfirm'] as const) {
    for (const role of ['business', 'reviewer'] as const) assert.match(reason(operation, role), /仅产品经理/);
  }
  for (const operation of ['proposeChange', 'businessConfirm', 'businessReject', 'businessDefer'] as const) {
    for (const role of ['pm', 'reviewer'] as const) assert.match(reason(operation, role), /仅业务人员/);
  }
  freeze();
  assert.match(reason('editCard', 'business', {busy: true}), /仅产品经理/);
  assert.match(reason('businessConfirm', 'reviewer', {busy: true}), /仅业务人员/);
  assert.match(getChatDisabledReason('discuss', {project, card, role: 'agent' as never}), /身份/);
});

test('冻结交付仅保留普通讨论和提出变更，所有写卡与确认均服务端拒绝', () => {
  const {project, card, reason, freeze, proposal} = setup(); freeze();
  assert.equal(reason('discuss', 'reviewer'), '');
  assert.equal(reason('proposeChange', 'business'), '');
  for (const operation of ['addBlocker', 'acceptChange', 'editCard', 'applySuggestion', 'suggest', 'resolveBlocker', 'pmConfirm'] as const) assert.match(reason(operation), /冻结交付/);
  for (const operation of ['businessConfirm', 'businessReject', 'businessDefer'] as const) assert.match(reason(operation, 'business'), /冻结交付/);
  const original = structuredClone(project.deliveries[0].snapshot);
  applyAction(project, {type: 'message', cardId: card.id, text: '讨论下一期方向'}, 'reviewer');
  applyAction(project, {type: 'proposeChange', cardId: card.id, text: '下一期希望保留只读权限'}, 'business');
  assert.equal(project.phase, '已明确'); assert.deepEqual(project.deliveries[0].snapshot, original);
  assert.throws(() => applyAction(project, {type: 'addBlocker', cardId: card.id, field: 'permission', reason: '需要讨论'}, 'reviewer'), /冻结交付/);
  assert.throws(proposal, /冻结交付/, '先启动后回来的异步建议也不能写入已冻结项目');
});

test('产品确认门槛覆盖九字段、阻断、需评估及待决定和过期建议', () => {
  const {project, card, reason, proposal} = setup();
  assert.equal(reason('pmConfirm'), '');
  for (const marker of ['', '待明确', '待澄清', '待确认', '未确定', '未知', '待补充']) {
    card.fields.quality = marker; assert.match(reason('pmConfirm'), /质量要求/);
    assert.throws(() => applyAction(project, {type: 'pmConfirm', cardId: card.id}, 'pm'), /九个字段/);
  }
  card.fields.quality = fields.quality;
  card.assessment = '需评估'; assert.match(reason('pmConfirm'), /评估/); card.assessment = '可确认';
  applyAction(project, {type: 'addBlocker', cardId: card.id, field: 'permission', reason: '存在权限争议'}, 'reviewer');
  assert.match(reason('pmConfirm'), /阻断/);
  assert.throws(() => applyAction(project, {type: 'resolveBlocker', cardId: card.id, blockerId: card.blockers[0].id, reason: '已核对'}, 'business'), /产品经理/);
  applyAction(project, {type: 'resolveBlocker', cardId: card.id, blockerId: card.blockers[0].id, reason: '业务已说明，产品核对当前字段与回答一致'}, 'pm');
  proposal(); assert.match(reason('pmConfirm'), /尚待决定/);
  assert.throws(() => applyAction(project, {type: 'pmConfirm', cardId: card.id}, 'pm'), /尚待决定/);
  applyAction(project, {type: 'message', cardId: card.id, text: '补充一条情况'}, 'business');
  assert.match(reason('pmConfirm'), /过期/); assert.match(reason('applySuggestion'), /过期/);
  proposal();
  applyAction(project, {type: 'applySuggestion', cardId: card.id, suggestionId: card.suggestion!.id, decisions: {permission: '不采纳'}}, 'pm');
  assert.equal(reason('pmConfirm'), ''); assert.equal(card.revision, 1);
});

test('当前修订同轮确认、重复确认与业务拒绝/暂缓分别判断', () => {
  const {project, card, reason, proposal} = setup();
  for (const operation of ['businessConfirm', 'businessReject', 'businessDefer'] as const) assert.match(reason(operation, 'business'), /先由产品经理/);
  applyAction(project, {type: 'pmConfirm', cardId: card.id}, 'pm');
  assert.match(reason('pmConfirm'), /等待业务/); assert.equal(reason('businessConfirm', 'business'), '');
  proposal();
  assert.match(reason('businessConfirm', 'business'), /尚待决定/);
  assert.equal(reason('businessReject', 'business'), ''); assert.equal(reason('businessDefer', 'business'), '');
  assert.throws(() => applyAction(project, {type: 'businessConfirm', cardId: card.id, result: '通过', comment: ''}, 'business'), /尚待决定/);
  applyAction(project, {type: 'businessConfirm', cardId: card.id, result: '暂无法确认', comment: '需要核对制度'}, 'business');
  assert.ok(card.approvals.pm); assert.equal(card.approvals.business, undefined);
  applyAction(project, {type: 'applySuggestion', cardId: card.id, suggestionId: card.suggestion!.id, decisions: {permission: '不采纳'}}, 'pm');
  applyAction(project, {type: 'businessConfirm', cardId: card.id, result: '通过', comment: '当前规则准确'}, 'business');
  assert.equal(cardStatus(card), '已确认'); assert.match(reason('pmConfirm'), /无需重复/); assert.match(reason('businessConfirm', 'business'), /无需重复/);
  assert.match(reason('businessDefer', 'business'), /已经确认/);
  assert.equal(reason('businessReject', 'business'), '', '已确认内容仍可明确要求修改并触发回退');
  card.round += 1;
  assert.match(reason('businessConfirm', 'business'), /本轮业务确认/, '旧确认轮次不能继续通过');
  card.round -= 1; card.revision += 1;
  assert.match(reason('businessConfirm', 'business'), /当前修订/, '旧修订确认不能继续通过');
});

test('业务要求修改不被待决定建议阻挡，后端清确认回退', () => {
  const {project, card, proposal} = setup();
  applyAction(project, {type: 'pmConfirm', cardId: card.id}, 'pm'); proposal();
  applyAction(project, {type: 'businessConfirm', cardId: card.id, result: '要求修改', comment: '当前交接规则还缺离职场景'}, 'business');
  assert.deepEqual(card.approvals, {}); assert.equal(project.phase, '可讨论'); assert.equal(card.suggestion!.status, '已失效');
});

test('AI 建议门槛正确处理模型、执行状态、本期范围和可选参数', () => {
  const {project, card, reason} = setup();
  assert.equal(reason('suggest'), '', '未传模型状态不能被解释为未配置');
  assert.equal(reason('suggest', 'pm', {modelConfigured: true, agentRunning: false}), '');
  assert.match(reason('suggest', 'pm', {modelConfigured: false}), /模型服务/);
  assert.match(reason('suggest', 'pm', {agentRunning: true}), /正在整理/);
  assert.match(reason('discuss', 'reviewer', {busy: true}), /正在保存/);
  assert.equal(reason('discuss', 'reviewer', {agentRunning: true}), '', '普通讨论允许继续，新的发言会让旧建议失效');
  applyAction(project, {type: 'scope', cardId: card.id, included: false, reason: '安排到下一期'}, 'pm');
  assert.match(reason('suggest'), /本期不纳入/); assert.match(reason('pmConfirm'), /本期不纳入/);
  assert.equal(reason('editCard'), '', '共享规则不额外禁止维护池内非本期卡片');
});

test('无需修改的总结作为普通回应，不需要采纳且不增加修订', () => {
  const {project, card, reason} = setup();
  attachSuggestion(project, card.id, {summary: '材料与讨论已一致，没有字段改动', issues: [], changes: []}, 1, 0);
  assert.equal(reason('pmConfirm'), '');assert.equal(card.suggestion!.status,'已写入');
  assert.equal(card.messages.at(-1)?.text,'材料与讨论已一致，没有字段改动');
  assert.deepEqual(card.approvals,{});
  assert.equal(card.revision, 1); assert.equal(reason('pmConfirm'), ''); assert.match(reason('applySuggestion'), /已经处理/);
});
