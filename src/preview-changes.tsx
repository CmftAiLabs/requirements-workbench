import {ChevronDown, Crosshair} from 'lucide-react';
import type {DemoRevision, DemoView} from '../shared/generated-demo';
import type {FieldKey} from '../shared/types';
import type {presentDemoChanges} from './demo-changes';

type Changes = ReturnType<typeof presentDemoChanges>;

function PreviewUpdateDetails({view, revisions}: {view: DemoView; revisions: DemoRevision[]}) {
  const revision = view.revision;
  if (!revision) return null;
  const check = revision.verification;
  const previous = revisions.find(item => item.id === revision.parentId);
  const changedModules = revision.modules?.filter(module => !previous?.modules
    || !previous.modules.some(item => item.id === module.id && item.artifactId === module.artifactId));
  const modules = changedModules?.length ? changedModules : revision.modules;
  const moduleAction = !changedModules?.length ? '沿用上版的' : previous?.modules ? '更新' : '涉及';
  const checkText = check?.status === 'passed' ? `检查 ${check.passed}/${check.total} 通过`
    : check?.status === 'pending' ? '后台检查中'
    : check?.status === 'needs-attention' ? '检查待核对'
    : check?.status === 'interrupted' ? '检查中断'
    : revision.checksPassed ? `已通过 ${revision.checksPassed} 项检查` : '';
  const syncText = view.stale ? '待同步' : view.draft ? '需求草稿' : '已同步';
  return <details className="co-preview-update-details">
    <summary>
      <span>原型 r{revision.number} · {syncText}</span>
      <span data-attention={check?.status === 'needs-attention' || check?.status === 'interrupted'}>{checkText}<ChevronDown size={13}/></span>
    </summary>
    <div className="co-preview-update-body">
      {!!modules?.length && <div>
        <strong>{moduleAction} {modules.length} 个模块</strong>
        <ul className="co-preview-module-list">{modules.map(module => <li key={module.id}>{module.name}</li>)}</ul>
      </div>}
      {!!check?.errors.length && <div>
        <strong>检查记录</strong>
        {check.errors.map((error, index) => <pre key={index} className="co-preview-check-error">{error.slice(0, 1800)}</pre>)}
      </div>}
      {revision.summary && <details><summary>生成记录 <ChevronDown size={12}/></summary><p>{revision.summary}</p></details>}
      {revision.assumptions.length > 0 && <details>
        <summary>原型假设 · {revision.assumptions.length} <ChevronDown size={12}/></summary>
        <ul>{revision.assumptions.map((assumption, index) => <li key={index}>{assumption}</li>)}</ul>
      </details>}
    </div>
  </details>;
}

export function PreviewChanges({changes, view, revisions, canLocate, locate}: {
  changes: Changes;
  view: DemoView | null;
  revisions: DemoRevision[];
  canLocate: (field: FieldKey) => boolean;
  locate: (field: FieldKey) => void;
}) {
  return <div className="co-preview-changes-body">
    {changes.groups.map(group => <article key={group.id} className="co-preview-change-group">
      <header>
        <h3>{group.title}</h3>
        <span className="co-preview-change-status" data-draft={changes.draft}>{group.status}</span>
      </header>
      <dl className="co-preview-change-comparison">
        <div className="co-preview-before">
          <dt>原先</dt>
          <dd>{group.previous.length ? group.previous.map((part, index) => <p key={index}>{part}</p>) : <p>此前未写明此项。</p>}</dd>
        </div>
        <div className="co-preview-after">
          <dt>{changes.draft ? '建议' : '现在'}</dt>
          <dd>{group.current.length ? group.current.map((part, index) => <p key={index}>{part}</p>) : <p>{changes.draft ? '建议移除此项内容。' : '已移除此项内容。'}</p>}</dd>
        </div>
      </dl>
      <details className="co-preview-linked-fields">
        <summary><span>查看关联字段 <b>{group.fields.length}</b></span><ChevronDown size={13}/></summary>
        <div className="co-preview-field-list">
          {group.fields.map(field => <div key={field.field} className="co-preview-field">
            <details>
              <summary>{field.label}<ChevronDown size={12}/></summary>
              <dl>
                <dt>原文</dt><dd>{field.before || '原文为空'}</dd>
                <dt>{changes.draft ? '建议全文' : '当前原文'}</dt><dd>{field.after || '当前为空'}</dd>
              </dl>
            </details>
            {canLocate(field.field) && <button type="button" aria-label={`在原型中定位${field.label}`}
              title="在原型中定位" onClick={() => locate(field.field)}><Crosshair size={13}/>定位</button>}
          </div>)}
        </div>
      </details>
    </article>)}
    {!changes.groups.length && <p className="co-preview-no-changes">这张卡片本轮暂无字段变化。</p>}
    {view?.revision && <PreviewUpdateDetails view={view} revisions={revisions}/>}
  </div>;
}
