import test from 'node:test';
import assert from 'node:assert/strict';
import {applyAction, attachSuggestion} from '../server/domain';
import type {FieldChange} from '../shared/types';
import {presentDemoChanges} from '../src/demo-changes';
import {discussionReplayProject} from './fixtures/discussion-replay';

test('原型变化归并同一业务答复，并以实际采纳的版本显示前后正文', () => {
  const {p, c} = discussionReplayProject();
  c.fields.permission = '查看资料前须登记。待明确：成员校验方式，以及首页是否需登录。';
  c.history.push({revision: c.revision, fields: {...c.fields}, reason: '初稿', createdAt: p.createdAt});
  const rule = '正式成员校验通过可查看资料；临时成员复核期间只能访问公开资料';
  applyAction(p, {type: 'message', cardId: c.id, text: rule}, 'business', 'business');
  const message = c.messages.at(-1)!;
  const requested: [FieldChange['field'], string, string][] = [
    ['permission', rule + '。待明确：首页是否需登录。', rule],
    ['scope', '正式成员校验通过可查看资料。临时成员复核期间只能访问公开资料。', rule],
    ['flow', '登记后校验。正式成员校验通过可查看资料；临时成员复核期间只能访问公开资料。', rule],
    ['exception', '临时成员复核期间只能访问公开资料。', '临时成员复核期间只能访问公开资料'],
    ['acceptance', '正式成员校验通过可查看资料；临时成员复核期间只能访问公开资料，按两种场景核对。', rule],
  ];
  const changes = requested.map(([field, after, quote]) => ({
    field, before: c.fields[field], after, reason: '落实业务答复', evidence: [{messageId: message.id, quote}],
  }));
  attachSuggestion(p, c.id, {summary: '明确资料访问规则', issues: [], changes}, c.revision, c.messages.length);
  const draft = presentDemoChanges(c);
  assert.equal(draft.groups.length, 1);
  assert.equal(draft.groups[0].fields.length, 5);
  assert.equal(draft.groups[0].status, '待采纳');
  assert.deepEqual(draft.groups[0].previous, ['查看资料前须登记', '待明确：成员校验方式']);
  assert.match(draft.groups[0].current.join(''), /临时成员复核期间只能访问公开资料/);

  const decisions = Object.fromEntries(changes.map(change => [change.field, '采纳' as const]));
  applyAction(p, {type: 'applySuggestion', cardId: c.id, suggestionId: c.suggestion!.id, decisions,
    overrides: {exception: '临时成员提交复核后可以撤回申请。'}}, 'pm', 'pm');
  const saved = presentDemoChanges(p.cards[0]);
  assert.equal(saved.groups.length, 2);
  assert.equal(saved.groups[0].status, '已采纳');
  assert.equal(saved.groups[0].fields.length, 4);
  assert.deepEqual(saved.groups[1].current, ['临时成员提交复核后可以撤回申请']);
  assert.equal(p.cards[0].approvals.business, undefined);
});

test('同一条消息里不同阈值或不同规则仍分别显示', () => {
  const {p, c} = discussionReplayProject();
  const answer = '采购部门申请金额超过20万元时由财务部审批；工程部门申请金额超过50万元时由财务部审批；保存后支持打印申请。';
  applyAction(p, {type: 'message', cardId: c.id, text: answer}, 'business', 'business');
  const requested: [FieldChange['field'], string][] = [
    ['flow', '采购部门申请金额超过20万元时由财务部审批。'],
    ['permission', '工程部门申请金额超过50万元时由财务部审批。'],
    ['acceptance', '保存后支持打印申请。'],
  ];
  attachSuggestion(p, c.id, {summary: '不同部门的金额阈值与打印', issues: [], changes: requested.map(([field, after]) => ({
    field, before: c.fields[field], after, reason: '落实现行规则', evidence: [{messageId: c.messages[0].id, quote: answer}],
  }))}, c.revision, c.messages.length);
  const view = presentDemoChanges(c);
  assert.equal(view.groups.length, 3);
  assert.equal(view.groups.some(group => group.fields.length > 1), false);
});
