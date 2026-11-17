import test from 'node:test';
import assert from 'node:assert/strict';
import { addExtractedCards, applyAction, attachSuggestion, createProject } from '../server/domain.ts';
import { actionSchema } from '../server/validation.ts';
import { resolutionDisabledReason } from '../shared/resolution-policy.ts';
import { cardStatus } from '../shared/types.ts';
import type { Fields, ProblemResolution, SuggestionDraft } from '../shared/types.ts';

const fields: Fields = {goal: '责任清晰', scope: '本部门单个客户转交', flow: '主管选择接收人后交接', permission: '原负责人保留 30 天只读', exception: '失败全部回滚', data: '交接记录保留一年', constraint: '使用现有权限服务', quality: '负责人和权限原子更新', acceptance: '交接后原负责人有 30 天只读'};
function setup() {
  const project = createProject('问题与字段一起审核');
  addExtractedCards(project, [{title: '客户交接', fields: {...fields}, sourceIds: ['crm-kickoff'], assessment: '可确认', issues: [], evidence: {}}], ['crm-kickoff']);
  const card = project.cards[0];
  applyAction(project, {type: 'addBlocker', cardId: card.id, field: 'permission', reason: '保留只读与立即撤权存在冲突'}, 'reviewer');
  applyAction(project, {type: 'message', cardId: card.id, text: '业务确认立即撤权，不保留 30 天只读。'}, 'business');
  applyAction(project, {type: 'message', cardId: card.id, text: '评审确认立即撤权符合权限制度。'}, 'reviewer');
  const candidate: ProblemResolution = {blockerId: card.blockers[0].id, resolution: '交接后立即撤销原负责人权限，不保留只读。', requiredFields: ['permission', 'acceptance'], requiredRoles: ['business', 'reviewer'], evidence: card.messages.map(message => ({messageId: message.id, quote: message.text}))};
  const draft: SuggestionDraft = {summary: '业务和评审确认立即撤权', issues: [], changes: [
    {field: 'permission', before: card.fields.permission, after: '交接后立即撤销原负责人权限', reason: '业务和评审明确', evidence: candidate.evidence},
    {field: 'acceptance', before: card.fields.acceptance, after: '交接成功后原负责人立即无权访问', reason: '与权限规则保持一致', evidence: candidate.evidence},
  ], problemResolutions: [candidate]};
  const attach = () => attachSuggestion(project, card.id, draft, card.revision, card.messages.length);
  const action = (resolvedBlockerIds: string[] = [candidate.blockerId]) => ({type: 'applySuggestion' as const, cardId: card.id, suggestionId: card.suggestion!.id, decisions: {permission: '采纳' as const, acceptance: '采纳' as const}, resolvedBlockerIds});
  return {project, card, draft, candidate, attach, action};
}

test('一次人工采纳原子更新正文与选中问题，留下结论依据，整卡确认仍独立', () => {
  const {project, card, candidate, attach, action} = setup();
  attach();
  assert.equal(card.blockers[0].resolved, false, '生成建议不能自动关闭问题');
  assert.equal(resolutionDisabledReason(card, candidate, action().decisions), '');
  const round = card.round;
  applyAction(project, action(), 'pm');
  assert.equal(card.revision, 2);
  assert.equal(card.round, round + 1);
  assert.equal(card.fields.permission, '交接后立即撤销原负责人权限');
  const blocker = card.blockers[0];
  assert.equal(blocker.resolved, true);
  assert.equal(blocker.resolution, candidate.resolution);
  assert.deepEqual(blocker.resolutionEvidence, card.suggestion!.problemResolutions![0].evidence);
  assert.equal(blocker.resolvedBy, 'pm');
  assert.ok(blocker.resolvedAt);
  assert.equal(blocker.resolutionSuggestionId, card.suggestion!.id);
  assert.deepEqual(card.approvals, {});
  assert.equal(cardStatus(card), '可确认');
  assert.equal(project.phase, '可讨论');
  applyAction(project, {type: 'pmConfirm', cardId: card.id}, 'pm');
  applyAction(project, {type: 'businessConfirm', cardId: card.id, result: '通过', comment: ''}, 'business');
  assert.equal(cardStatus(card), '已确认');
});

test('问题未经选择保持待解决，兼容未包含 resolvedBlockerIds 的旧请求', () => {
  for (const omit of [false, true]) {
    const {project, card, attach, action} = setup(); attach();
    const request = action([]);
    if (omit) delete (request as {resolvedBlockerIds?: string[]}).resolvedBlockerIds;
    applyAction(project, request, 'pm');
    assert.equal(card.revision, 2);
    assert.equal(card.blockers[0].resolved, false);
    assert.equal(cardStatus(card), '待澄清');
  }
});

test('部分拒绝依赖字段时不能关闭问题，正文、确认、阶段和建议均保持原样', () => {
  const {project, card, candidate, attach, action} = setup(); attach();
  const request = {...action(), decisions: {permission: '采纳', acceptance: '不采纳'} as const};
  assert.match(resolutionDisabledReason(card, candidate, request.decisions), /验收条件/);
  const before = structuredClone(project);
  assert.throws(() => applyAction(project, request, 'pm'), /验收条件/);
  assert.deepEqual(project, before);
  applyAction(project, {...request, resolvedBlockerIds: []}, 'pm');
  assert.equal(card.revision, 2);
  assert.equal(card.blockers[0].resolved, false);
  assert.equal(card.blockers.length, 1, '保留未解决问题，无明确关联冲突时不创建泛化核对任务');
});

test('只关闭问题不增加正文修订，不自动推进阶段或代替确认', () => {
  const {project, card, draft, attach, action} = setup();
  card.fields.permission = '交接后立即撤销原负责人权限';
  card.fields.acceptance = '交接成功后原负责人立即无权访问';
  draft.changes = [];
  attach();
  const original = {revision: card.revision, round: card.round, phase: project.phase, version: [...project.version], history: structuredClone(card.history), approvals: structuredClone(card.approvals)};
  applyAction(project, {...action(), decisions: {}}, 'pm');
  assert.equal(card.blockers[0].resolved, true);
  assert.equal(card.revision, original.revision);
  assert.equal(card.round, original.round);
  assert.equal(project.phase, original.phase);
  assert.deepEqual(project.version, original.version);
  assert.deepEqual(card.history, original.history);
  assert.deepEqual(card.approvals, original.approvals);
  assert.equal(cardStatus(card), '可确认');
});

test('人工调整问题关联字段后，旧结论不能直接关闭问题；未选问题可保留继续沟通', () => {
  const {project, card, candidate, attach, action} = setup(); attach();
  const request = {...action(), overrides: {permission: '原负责人保留七天只读'}};
  assert.match(resolutionDisabledReason(card, candidate, request.decisions, request.overrides), /人工调整.*重新总结/);
  const before = structuredClone(project);
  assert.throws(() => applyAction(project, request, 'pm'), /人工调整.*重新总结/);
  assert.deepEqual(project, before);
  applyAction(project, {...request, resolvedBlockerIds: []}, 'pm');
  assert.equal(card.fields.permission, request.overrides.permission);
  assert.equal(card.blockers[0].resolved, false);
  assert.deepEqual(card.provenance.permission, []);
});

test('覆盖与 Agent 建议相同只做空白规范化，不妨碍已有依据的问题关闭', () => {
  const {project, card, candidate, attach, action} = setup(); attach();
  const request = {...action(), overrides: {permission: ` ${card.suggestion!.changes[0].after} `}};
  assert.equal(resolutionDisabledReason(card, candidate, request.decisions, request.overrides), '');
  applyAction(project, request, 'pm');
  assert.equal(card.blockers[0].resolved, true);
  assert.equal(card.provenance.permission.length, 2);
});

test('非产品身份、过期建议及未知/重复问题全部拒绝且不留下部分写入', () => {
  for (const role of ['business', 'reviewer'] as const) {
    const {project, attach, action} = setup(); attach(); const before = structuredClone(project);
    assert.throws(() => applyAction(project, action(), role), /产品经理/);
    assert.deepEqual(project, before);
  }
  for (const mutate of [(ids: string[]) => [...ids, 'missing'], (ids: string[]) => [...ids, ...ids]]) {
    const {project, attach, action} = setup(); attach(); const before = structuredClone(project);
    assert.throws(() => applyAction(project, action(mutate(action().resolvedBlockerIds)), 'pm'), /问题/);
    assert.deepEqual(project, before);
  }
  const {project, card, attach, action} = setup(); attach(); const request = action();
  applyAction(project, {type: 'message', cardId: card.id, text: '业务补充另一种场景'}, 'business');
  const before = structuredClone(project);
  assert.throws(() => applyAction(project, request, 'pm'), /过期/);
  assert.deepEqual(project, before);
});

test('无效候选、无效来源和缺少所需角色不能生成解决建议', () => {
  const cases: Array<(state: ReturnType<typeof setup>) => void> = [
    ({candidate}) => {candidate.blockerId = 'unknown';},
    ({card}) => {card.blockers[0].resolved = true;},
    ({draft, candidate}) => {draft.problemResolutions!.push(structuredClone(candidate));},
    ({candidate}) => {candidate.resolution = '';},
    ({candidate}) => {candidate.requiredFields = [];},
    ({candidate}) => {candidate.requiredFields = ['acceptance'];},
    ({candidate}) => {candidate.requiredFields = ['permission', 'permission'];},
    ({candidate}) => {candidate.requiredRoles = [];},
    ({candidate}) => {candidate.requiredRoles = ['business', 'business'];},
    ({candidate}) => {candidate.evidence.pop();},
    ({candidate}) => {candidate.evidence[0].messageId = 'another-card-message';},
    ({candidate}) => {candidate.evidence[0].quote = '不存在的原文';},
    ({card}) => {card.messages[0].role = 'agent';},
    ({card}) => {card.messages[0].kind = 'change'; card.messages[0].accepted = false;},
    ({candidate}) => {candidate.evidence[0].materialId = 'crm-kickoff';},
    ({candidate}) => {candidate.evidence.push({materialId: 'missing', quote: '不存在的材料'});},
    ({candidate}) => {candidate.evidence.push({materialId: 'crm-kickoff', quote: '材料没有这句话'});},
    ({draft}) => {draft.changes[1].after = '验收条件待明确';},
  ];
  for (const mutate of cases) {
    const state = setup(); mutate(state);
    const before = structuredClone(state.project);
    assert.throws(state.attach, /./, mutate.toString());
    assert.deepEqual(state.project, before, '候选校验失败不能留下建议或审计记录');
  }
});

test('提交时复核结论依据及所有选中问题，后一个无效不允许前一个先写入', () => {
  const state = setup(); const {project, card, candidate, attach, action} = state;
  applyAction(project, {type: 'addBlocker', cardId: card.id, field: 'acceptance', reason: '验收条件存在冲突'}, 'reviewer');
  state.draft.problemResolutions!.push({...structuredClone(candidate), blockerId: card.blockers[1].id});
  attach();
  card.suggestion!.problemResolutions![1].evidence[0].quote = '被篡改的原文';
  const before = structuredClone(project);
  assert.throws(() => applyAction(project, action(card.blockers.map(blocker => blocker.id)), 'pm'), /原文/);
  assert.deepEqual(project, before);
  card.suggestion!.problemResolutions![1].evidence[0].quote = candidate.evidence[0].quote;
  card.suggestion!.changes[1].after = '待补充';
  const beforeUnknown = structuredClone(project);
  assert.throws(() => applyAction(project, action(card.blockers.map(blocker => blocker.id)), 'pm'), /待明确/);
  assert.deepEqual(project, beforeUnknown);
});

test('已纳入变更可作依据，宽窄字符与空白按统一规则校验', () => {
  const {project, card, candidate, attach, action} = setup();
  card.messages[0].kind = 'change'; card.messages[0].accepted = true;
  card.messages[0].text = '业务确认立即撤权，不保留３０天只读。';
  candidate.evidence[0].quote = '业务确认立即撤权，不保留 30 天只读。';
  attach(); applyAction(project, action(), 'pm');
  assert.equal(card.blockers[0].resolved, true);
});

test('预览 helper 遇到不完整候选安全返回提示；HTTP schema 保留显式问题选择', () => {
  const {card, candidate, attach, action} = setup(); attach();
  for (const broken of [null, {}, {...candidate, evidence: null}, {...candidate, requiredFields: ['invalid']}, {...candidate, requiredRoles: ['pm']}, {...candidate, evidence: [null]}]) {
    assert.ok(resolutionDisabledReason(card, broken as ProblemResolution, {}));
  }
  const parsed = actionSchema.parse(action());
  assert.equal(parsed.type, 'applySuggestion');
  if (parsed.type === 'applySuggestion') assert.deepEqual(parsed.resolvedBlockerIds, [candidate.blockerId]);
  assert.equal(actionSchema.safeParse(action([candidate.blockerId, candidate.blockerId])).success, false);
  const legacy = {...action()}; delete (legacy as {resolvedBlockerIds?: string[]}).resolvedBlockerIds;
  assert.equal(actionSchema.safeParse(legacy).success, true);
});

test('Agent 不能同时将同一问题列为未明确和可解决；未明确事项按现存问题精确去重', () => {
  const {project, card, draft, attach, action} = setup();
  draft.issues = [card.blockers[0].reason, '另有独立场景需要继续讨论'];
  const before = structuredClone(project);
  assert.throws(attach, /矛盾/);
  assert.deepEqual(project, before);
  draft.problemResolutions = [];
  attach(); applyAction(project, action([]), 'pm');
  assert.equal(card.blockers.filter(blocker => blocker.reason === draft.issues[0]).length, 1);
  assert.equal(card.blockers[0].resolved, false);
  assert.ok(card.blockers.some(blocker => !blocker.resolved && blocker.reason === draft.issues[1]));
});

test('仅关闭旧问题时新发现事项仍需落库并失效一次，不增加正文修订', () => {
  const {project, card, draft, attach, action} = setup();
  for (const change of draft.changes) card.fields[change.field] = change.after;
  draft.changes = [];
  draft.issues = ['离职接收人场景需继续讨论', ' 离职 接收人场景需继续讨论 '];
  attach();
  const before = {revision: card.revision, round: card.round, history: structuredClone(card.history)};
  applyAction(project, {...action(), decisions: {}}, 'pm');
  assert.equal(card.blockers[0].resolved, true);
  assert.equal(card.blockers.filter(blocker => !blocker.resolved).length, 1, '同一新事项只创建一次');
  assert.equal(card.blockers[1].reason, draft.issues[0]);
  assert.equal(card.revision, before.revision);
  assert.equal(card.round, before.round + 1);
  assert.deepEqual(card.history, before.history);
  assert.deepEqual(card.approvals, {});
  assert.equal(card.suggestion!.status, '已写入');
  assert.equal(project.phase, '可讨论');
  assert.equal(cardStatus(card), '待澄清');
  assert.throws(() => applyAction(project, {type: 'pmConfirm', cardId: card.id}, 'pm'), /阻断/);
});

test('只关闭且未明确事项已存在时不重复失效；全不采纳且不关闭仍无变化', () => {
  for (const closeProblem of [true, false]) {
    const {project, card, draft, attach, action} = setup();
    for (const change of draft.changes) card.fields[change.field] = change.after;
    draft.changes = [];
    draft.issues = ['已有质量问题'];
    if (closeProblem) applyAction(project, {type: 'addBlocker', cardId: card.id, field: 'quality', reason: ' 已有 质量问题 '}, 'reviewer');
    attach();
    const before = {revision: card.revision, round: card.round, blockerCount: card.blockers.length, approvals: structuredClone(card.approvals)};
    applyAction(project, {...action(closeProblem ? [card.blockers[0].id] : []), decisions: {}}, 'pm');
    assert.equal(card.blockers.length, before.blockerCount);
    assert.equal(card.blockers[0].resolved, closeProblem);
    assert.equal(card.revision, before.revision);
    assert.equal(card.round, before.round);
    assert.deepEqual(card.approvals, before.approvals);
  }
});

test('仅关闭问题也必须在任何状态写入前校验新发现事项', () => {
  const {project, card, draft, attach, action} = setup();
  for (const change of draft.changes) card.fields[change.field] = change.after;
  draft.changes = [];
  attach();
  card.suggestion!.issues = [''];
  const before = structuredClone(project);
  assert.throws(() => applyAction(project, {...action(), decisions: {}}, 'pm'), /未明确事项/);
  assert.deepEqual(project, before);
});

test('问题级核对允许采纳采购平台规则，同时保留品牌缺口；变更后不能复用旧核对',async()=>{
 const {resolutionScopeBasis}=await import('../shared/resolution-scope');
 const {project,card,draft,candidate,attach,action}=setup();
 const gap='；品牌长度上限与校验提示文案待明确。';
 card.blockers[0].reason='采购平台是否在申请列表展示';card.blockers[0].field='flow';
 candidate.requiredFields=['flow'];candidate.requiredRoles=['business'];candidate.resolution='采购平台在列表展示，未选择时使用统一空值占位。';
 card.messages.push({id:'platform-decision',role:'business',text:candidate.resolution,createdAt:new Date().toISOString()});candidate.evidence=[{messageId:'platform-decision',quote:candidate.resolution}];
 card.fields.flow='采购平台是否在列表展示待明确'+gap;
 applyAction(project,{type:'addBlocker',cardId:card.id,field:'flow',reason:'品牌长度上限与校验提示文案待明确'},'pm');
 draft.changes=[{field:'flow',before:card.fields.flow,after:candidate.resolution+gap,reason:'业务决定',evidence:candidate.evidence}];
 candidate.scopeReview={basis:resolutionScopeBasis(card,candidate,{...card.fields,flow:draft.changes[0].after})};
 attach();const accepted={flow:'采纳' as const};
 assert.equal(resolutionDisabledReason(card,card.suggestion!.problemResolutions![0],accepted),'');
 const changed=structuredClone(card);changed.suggestion!.changes[0].after='采购平台是否展示待明确'+gap;
 assert.match(resolutionDisabledReason(changed,changed.suggestion!.problemResolutions![0],accepted),/重新核对/);
 applyAction(project,{...action(),decisions:accepted},'pm');
 assert.equal(card.blockers[0].resolved,true);assert.equal(card.blockers[1].resolved,false);assert.match(card.fields.flow,/品牌长度上限与校验提示文案待明确/);
 assert.throws(()=>applyAction(project,{type:'pmConfirm',cardId:card.id},'pm'),/阻断问题|明确全部/);
});
