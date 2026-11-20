import test from 'node:test';
import assert from 'node:assert/strict';
import {applyAction, attachSuggestion} from '../server/domain';
import {prototypeTitlePatch} from '../server/demo-title-patch';
import {demoInputKey, validateDemoProposal} from '../server/demo-schema';
import {cardReminders} from '../shared/discussion-reminders';
import {interfaceTitleSuggestion, readInterfaceTitleChange} from '../shared/interface-title';
import {discussionReplayProject} from './fixtures/discussion-replay';

test('产品明确提出页头改名，业务负责人确认后写入本项并同步原型', () => {
  const {p, c} = discussionReplayProject('会务测试');
  c.title = '大会基础信息浏览';
  c.organization = {module: '首页模块', priority: '正常沟通', reason: '测试需求'};
  applyAction(p, {type: 'addBlocker', cardId: c.id, field: 'permission', reason: '另有名单访问规则待明确。'}, 'pm', 'pm');
  const previous = structuredClone(p);
  const originalFlow = c.fields.flow;
  applyAction(p, {type: 'message', cardId: c.id, text: '大会首页改成招蛇大会更合适'}, 'pm', 'pm');
  const draft = interfaceTitleSuggestion(c);
  assert.ok(draft);
  assert.equal(draft.changes[0].after, originalFlow + '\n页头标题由「大会首页」改为「招蛇大会」。');
  attachSuggestion(p, c.id, draft, c.revision, c.messages.length);
  assert.equal(c.suggestion?.reviewRole, 'business');
  assert.deepEqual(cardReminders(p, c).map(item => [item.kind, item.participantId]), [['confirm', 'business']]);
  const action = {type: 'confirmProductSuggestion' as const, cardId: c.id, suggestionId: c.suggestion!.id};
  assert.throws(() => applyAction(p, {...action, type: 'adoptConclusion', decisions: {flow: '采纳'}}, 'pm', 'pm'), /业务负责人确认/);
  assert.throws(() => applyAction(p, action, 'business', 'business-operations'), /业务负责人/);
  assert.equal(c.fields.flow, originalFlow);

  const files = {
    'src/App.tsx': 'export default function App(){return <><header><span>会</span><strong data-testid="page-title">大会首页</strong></header><main>当前报名状态</main></>}',
    'src/styles.css': 'header{color:#345}',
  };
  const proposal = {files: [], deletePaths: [], bindings: [{cardId:c.id,field:'flow' as const,testId:'page-title'}], checks: [], summary: '首页', assumptions: []};
  const patch = prototypeTitlePatch(p, previous, files, proposal);
  assert.ok(patch);
  const preview = validateDemoProposal(patch, p, files, true).files;
  assert.match(preview['src/App.tsx'], /<span>会<\/span><strong data-testid="page-title">招蛇大会<\/strong>/);
  assert.equal(preview['src/styles.css'], files['src/styles.css']);
  const draftInput = demoInputKey(p);

  applyAction(p, action, 'business', 'business');
  assert.equal(c.suggestion?.processedBy, 'business');
  assert.match(c.fields.flow, /招蛇大会/);
  assert.equal(c.title, '大会基础信息浏览');
  assert.equal(c.revision, 2);
  assert.deepEqual(c.approvals, {});
  assert.equal(c.blockers[0].resolved, false);
  assert.equal(demoInputKey(p), draftInput);
  assert.throws(() => applyAction(p, action, 'business', 'business'), /已经处理|过期/);

  c.fields.data += ' 增加报名编号。';
  assert.equal(prototypeTitlePatch(p, previous, files, proposal), undefined);
});

test('区分明确的界面改名、卡片改名和不确定表述', () => {
  assert.deepEqual(readInterfaceTitleChange('页头标题「采购首页」改为「采购工作台」'), {before: '采购首页', after: '采购工作台'});
  assert.equal(readInterfaceTitleChange('需求卡片标题改为招蛇大会'), undefined);
  assert.equal(readInterfaceTitleChange('大会首页要不要改成招蛇大会？'), undefined);
  assert.equal(readInterfaceTitleChange('不要把大会首页改成招蛇大会'), undefined);
});
