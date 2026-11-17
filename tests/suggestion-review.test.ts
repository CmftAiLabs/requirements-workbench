import test from 'node:test';
import assert from 'node:assert/strict';
import { addExtractedCards, applyAction, attachSuggestion, createProject } from '../server/domain.ts';
import { actionSchema } from '../server/validation.ts';
import { getSuggestionReview } from '../shared/suggestion-review.ts';
import type { Action, ChangeDependency, Fields, SuggestionDraft } from '../shared/types.ts';

function setup() {
  const project = createProject('默认采用与例外审核');
  const fields: Fields = {goal: '客户交接后责任明确', scope: '单客户交接', flow: '选择接收人后提交', permission: '立即撤销原负责人访问权限', exception: '失败回滚', data: '记录交接原因', constraint: '依赖现有权限系统', quality: '50 并发', acceptance: '交接后原负责人无权访问'};
  addExtractedCards(project, [{title: '客户交接', fields, sourceIds: ['crm-kickoff'], assessment: '可确认', issues: [], evidence: {}}], ['crm-kickoff']);
  const card = project.cards[0];
  applyAction(project, {type: 'message', cardId: card.id, text: '补充交接责任说明，性能按 100 并发。'}, 'business');
  const evidence = [{messageId: card.messages[0].id, quote: card.messages[0].text}];
  const draft: SuggestionDraft = {summary: '补充目标与性能', issues: [], changes: [
    {field: 'goal', before: fields.goal, after: '客户交接后责任、跟进归属明确', reason: '补充目标', evidence},
    {field: 'quality', before: fields.quality, after: '100 并发', reason: '业务补充', evidence},
  ]};
  const attach = () => attachSuggestion(project, card.id, draft, card.revision, card.messages.length);
  const action = (): Extract<Action, {type: 'applySuggestion'}> => ({type: 'applySuggestion', cardId: card.id, suggestionId: card.suggestion!.id, decisions: {goal: '采纳', quality: '采纳'}, resolvedBlockerIds: []});
  return {project, card, draft, attach, action};
}

test('建议生成不隐式写入；旧建议无依赖时独立部分采纳不制造新问题', () => {
  const {project, card, attach, action} = setup();
  const fields = structuredClone(card.fields);
  attach();
  assert.deepEqual(card.fields, fields);
  assert.deepEqual(card.suggestion!.dependencies, []);
  delete card.suggestion!.dependencies;
  const request = {...action(), decisions: {goal: '采纳', quality: '不采纳'} as const};
  const preview = getSuggestionReview(card, request.decisions);
  assert.deepEqual(preview.changedFields, ['goal']);
  assert.deepEqual(preview.dependencyProblems, []);
  applyAction(project, request, 'pm');
  assert.deepEqual(card.fields, preview.fields);
  assert.equal(card.fields.quality, fields.quality);
  assert.equal(card.blockers.length, 0);
  applyAction(project, {type: 'pmConfirm', cardId: card.id}, 'pm');
  assert.ok(card.approvals.pm);
});

test('明确依赖的部分采纳只新增具体冲突，并按已有问题的归一化原因去重', () => {
  for (const existing of [false, true]) {
    const {project, card, draft, attach, action} = setup();
    const reason = '目标增加性能承诺，但质量要求仍为 50 并发';
    draft.dependencies = [{field: 'goal', requires: ['quality'], reason}];
    if (existing) applyAction(project, {type: 'addBlocker', cardId: card.id, field: 'scope', reason: ` ${reason.replace('增加', '增 加')} `}, 'reviewer');
    attach();
    const request = {...action(), decisions: {goal: '采纳', quality: '不采纳'} as const};
    const preview = getSuggestionReview(card, request.decisions);
    assert.deepEqual(preview.dependencyProblems, [{field: 'goal', requires: ['quality'], reason}]);
    applyAction(project, request, 'pm');
    assert.equal(card.blockers.length, 1);
    assert.throws(() => applyAction(project, {type: 'pmConfirm', cardId: card.id}, 'pm'), /阻断/);
  }
});

test('人工调整保存最终正文并清空该字段来源，不将 Agent 原引文伪装为新依据', () => {
  const {project, card, attach, action} = setup(); attach();
  const request = {...action(), overrides: {goal: '  人工确认客户交接与后续责任归属  '}};
  const preview = getSuggestionReview(card, request.decisions, request.overrides);
  assert.deepEqual(preview.adjustedFields, ['goal']);
  applyAction(project, request, 'pm');
  assert.deepEqual(card.fields, preview.fields);
  assert.equal(card.fields.goal, '人工确认客户交接与后续责任归属');
  assert.deepEqual(card.provenance.goal, []);
  assert.equal(card.provenance.quality.length, 1);
  assert.equal(card.suggestion!.overrides!.goal, card.fields.goal);
  assert.match(card.history.at(-1)!.reason, /人工调整业务目标/);
  assert.match(project.events.at(-1)!.detail, /人工调整业务目标/);
});

test('人工覆盖恢复原文视为 no-op，保留确认、阶段、正文修订和来源', () => {
  const {project, card, draft, attach, action} = setup();
  applyAction(project, {type: 'pmConfirm', cardId: card.id}, 'pm');
  applyAction(project, {type: 'businessConfirm', cardId: card.id, result: '通过', comment: ''}, 'business');
  applyAction(project, {type: 'submitReview'}, 'pm');
  applyAction(project, {type: 'review', result: '通过', comment: '通过'}, 'reviewer');
  draft.dependencies = [{field: 'goal', requires: ['quality'], reason: '目标与质量承诺不一致'}];
  attach();
  const before = {fields: structuredClone(card.fields), revision: card.revision, round: card.round, phase: project.phase, approvals: structuredClone(card.approvals), provenance: structuredClone(card.provenance)};
  const request = {...action(), decisions: {goal: '采纳', quality: '不采纳'} as const, overrides: {goal: card.fields.goal}};
  assert.deepEqual(getSuggestionReview(card, request.decisions, request.overrides).dependencyProblems, []);
  applyAction(project, request, 'pm');
  assert.equal(card.revision, before.revision);
  assert.equal(card.round, before.round);
  assert.equal(project.phase, before.phase);
  assert.deepEqual(card.fields, before.fields);
  assert.deepEqual(card.approvals, before.approvals);
  assert.deepEqual(card.provenance, before.provenance);
  assert.equal(card.blockers.length, 0);
});

test('依赖字段虽勾选但人工恢复原文仍不能消除具体关联冲突', () => {
  const {project, card, draft, attach, action} = setup();
  draft.dependencies = [{field: 'goal', requires: ['quality'], reason: '新增目标与仍保留的旧性能承诺不一致'}];
  attach();
  const request = {...action(), overrides: {quality: card.fields.quality}};
  assert.equal(getSuggestionReview(card, request.decisions, request.overrides).dependencyProblems.length, 1);
  applyAction(project, request, 'pm');
  assert.equal(card.blockers[0].reason, draft.dependencies[0].reason);
});

test('人工覆盖仅允许本轮已采纳字段，非法输入完整预检且不留下部分写入', () => {
  for (const overrides of [null, [], {scope: '越界字段'}, {goal: ''}, {goal: '  '}, {goal: 'a'.repeat(6001)}, {goal: 42}, {unknown: '非法字段'}]) {
    const {project, attach, action} = setup(); attach();
    const before = structuredClone(project);
    const request = {...action(), overrides} as Action;
    assert.throws(() => applyAction(project, request, 'pm'));
    assert.deepEqual(project, before);
  }
  const {project, attach, action} = setup(); attach();
  const before = structuredClone(project);
  const request = {...action(), decisions: {goal: '不采纳', quality: '采纳'} as const, overrides: {goal: '保留字段不能覆盖'}};
  assert.throws(() => applyAction(project, request, 'pm'), /已选中/);
  assert.deepEqual(project, before);
  const parsed = actionSchema.parse({...action(), overrides: {goal: '  确定内容  '}});
  assert.equal(parsed.type === 'applySuggestion' && parsed.overrides?.goal, '确定内容');
  assert.equal(actionSchema.safeParse({...action(), overrides: {goal: '  '}}).success, false);
  assert.equal(actionSchema.safeParse({...action(), overrides: {unknown: '非法'}}).success, false);
});

test('畸形字段依赖在替换已有建议前完整验证', () => {
  for (const dependencies of [null, [{}], [{field: 'scope', requires: ['quality'], reason: '无修改'}], [{field: 'goal', requires: ['goal'], reason: '自依赖'}], [{field: 'goal', requires: ['scope'], reason: '非本轮字段'}], [{field: 'goal', requires: ['quality', 'quality'], reason: '重复'}], [{field: 'goal', requires: ['quality'], reason: ''}], [{field: 'goal', requires: ['quality'], reason: '重复源'}, {field: 'goal', requires: ['quality'], reason: '重复源'}]]) {
    const {project, draft, attach} = setup(); attach();
    const before = structuredClone(project);
    draft.dependencies = dependencies as ChangeDependency[];
    assert.throws(attach);
    assert.deepEqual(project, before);
  }
});
