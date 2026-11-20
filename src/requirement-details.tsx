import {useId, useRef, useState} from 'react';
import {Crosshair} from 'lucide-react';
import {personFor} from '../shared/participants';
import {FIELDS, type Action, type Card, type FieldKey, type Fields, type Project, type Role} from '../shared/types';
import {CardHistory} from './card-history';
import {AIOrigin} from './intake-ai-field';
import type {requirementProgress} from './requirement-progress';
import {WorkspaceModal} from './workspace-ui';
import './requirement-details.css';

type Props = {
  card: Card;
  project: Project;
  role: Role;
  busy: boolean;
  progress: ReturnType<typeof requirementProgress>;
  editDisabled: string;
  changeDisabled: string;
  onClose: () => void;
  onLocate: (field: FieldKey) => void;
  onDiscuss: (anchor: string) => void;
  mutate: (action: Action, stamp?: number) => Promise<boolean>;
};

function excerpt(value: string, limit: number) {
  const text = value.replace(/\s+/gu, ' ').trim();
  if (text.length <= limit) return;
  const start = text.slice(0, limit);
  const end = Math.max(start.lastIndexOf('。'), start.lastIndexOf('？'), start.lastIndexOf('！'));
  return (end >= limit * 0.6 ? start.slice(0, end + 1) : start.trimEnd()) + '…';
}

function BriefText({text, limit = 54, expanded, onToggle}: {
  text: string; limit?: number; expanded?: boolean; onToggle?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const preview = excerpt(text, limit);
  const showFull = expanded ?? open;
  return <>
    <p className="rd-text" id={bodyId}>{showFull ? text : preview ?? text}</p>
    {preview && <button type="button" className="rd-link" aria-controls={bodyId} aria-expanded={showFull}
      onClick={onToggle ?? (() => setOpen(!open))}>{showFull ? '收起' : '展开全文'}</button>}
  </>;
}

export function RequirementDetails({
  card, project, role, busy, progress, editDisabled, changeDisabled, onClose, onLocate, onDiscuss, mutate,
}: Props) {
  const [expandedField, setExpandedField] = useState<FieldKey>();
  const [edit, setEdit] = useState<{fields: Fields; reason: string; stamp: number; gaps: string}>();
  const [scopeReason, setScopeReason] = useState('');
  const fieldNodes = useRef<Partial<Record<FieldKey, HTMLElement | null>>>({});
  const {status, step, blockers, questions, gaps, overviewGaps, changes, suggestion, needsNewSuggestion} = progress;
  const overview = card.granularity === '概要';
  const noIssues = !blockers.length && !questions.length && !gaps.length && !overviewGaps.length && status !== '需评估';
  const needsConfirmation = step === '待业务确认' || step === '待发起确认';
  const editionOutdated = edit && project.stamp !== edit.stamp;

  function showField(field: FieldKey) {
    setExpandedField(field);
    const node = fieldNodes.current[field];
    node?.focus({preventScroll: true});
    node?.scrollIntoView({block: 'nearest'});
  }

  async function saveEdits() {
    if (!edit) return;
    const {fields, reason, stamp} = edit;
    const update = {cardId: card.id, fields, title: card.title, reason};
    const action: Action = overview
      ? {...update, type: 'updateOverview', coverageGaps: edit.gaps.split('\n').map(gap => gap.trim()).filter(Boolean)}
      : {...update, type: 'editCard'};
    if (await mutate(action, stamp)) setEdit(undefined);
  }

  return <WorkspaceModal title={card.title} wide className="requirement-details-modal" onClose={onClose}>
    <div className="rd-layout">
      <section className="rd-pending" aria-label="待明确事项">
        <h3>待明确事项</h3>
        <div className="rd-progress">
          <span className="rd-step">{step}</span>
          {needsConfirmation && <button type="button" className="rd-link" onClick={() => onDiscuss(`confirmation-${card.id}`)}>
            @{personFor(step === '待业务确认' ? 'business' : 'pm').name}
          </button>}
        </div>
        {noIssues && <p className="rd-empty">{status === '本期不纳入' ? '本卡已移出本期' : overview ? '请在材料箱拆分为具体需求。' : '暂无待明确事项'}</p>}
        {status === '需评估' && <p className="rd-empty">请先核对需求范围和可行性。</p>}
        {(blockers.length > 0 || overviewGaps.length > 0) && <ul className="rd-list" aria-label="未解决问题">
          {blockers.map(item => <li key={item.id}><BriefText text={item.reason} limit={58}/></li>)}
          {overviewGaps.map((gap, index) => <li key={index}><BriefText text={gap} limit={58}/></li>)}
        </ul>}
        {questions.length > 0 && <ul className="rd-list" aria-label="未回答追问">
          {questions.map(question => <li key={question.id}>
            <div className="rd-item-meta">
              <span>@{personFor(question.role, question.participantId).name} · {question.status === 'deferred' ? '暂缓回答' : '待回复'}</span>
              <button type="button" className="rd-link" onClick={() => onDiscuss(`question-${question.id}`)}>查看对话</button>
            </div>
            <BriefText text={question.question} limit={58}/>
          </li>)}
        </ul>}
        {gaps.length > 0 && <div className="rd-field-gaps">
          <h4>还需明确的字段</h4>
          <div>{gaps.map(([key, label]) => <button type="button" className="rd-chip" key={key}
            onClick={() => showField(key)}>{label}</button>)}</div>
        </div>}
        {suggestion && <button type="button" className="rd-link rd-follow-action" onClick={() => onDiscuss(`suggestion-${suggestion.id}`)}>
          @{personFor('pm').name} 查看待采纳建议
        </button>}
        {needsNewSuggestion && <p className="rd-empty">建议已过期，请按最新讨论重新整理。</p>}
        {changes.length > 0 && <div className="rd-changes">
          <h4>待处理变更</h4>
          {changes.map(message => <div className="rd-change" key={message.id}>
            <BriefText text={message.text}/>
            <details>
              <summary>查看处理操作</summary>
              <p className="co-impact">纳入后本卡确认失效，项目回到可讨论。</p>
              <button type="button" className="small" disabled={!!changeDisabled} title={changeDisabled}
                onClick={() => void mutate({type: 'acceptChange', cardId: card.id, messageId: message.id, field: 'scope'}, project.stamp)}>
                纳入本轮沟通
              </button>
            </details>
          </div>)}
        </div>}
      </section>
      <section className="rd-card" aria-label="需求卡明细">
        <div className="rd-card-heading">
          <h3>需求卡明细 <small>修订 {card.revision}</small></h3>
          {role === 'pm' && <button type="button" className="small" disabled={!edit && !!editDisabled} title={editDisabled}
            onClick={() => setEdit(edit ? undefined : {
              fields: {...card.fields}, reason: '', stamp: project.stamp, gaps: (card.coverageGaps ?? []).join('\n'),
            })}>{edit ? '取消编辑' : '编辑需求'}</button>}
        </div>
        <div className="rd-fields">
          {FIELDS.map(([key, label]) => <section className="rd-field" key={key} tabIndex={-1} aria-label={label}
            ref={node => { fieldNodes.current[key] = node; }}>
            <h4>{label}{!edit && card.included && !overview && <button type="button" className="co-field-locate"
              aria-label={`在原型中定位${label}`} title={`在原型中定位${label}`} onClick={() => onLocate(key)}><Crosshair size={12}/></button>}</h4>
            {edit ? <textarea aria-label={label} rows={3} maxLength={12000} value={edit.fields[key] || ''}
              onChange={event => setEdit({...edit, fields: {...edit.fields, [key]: event.target.value}})}/>
              : <>
                <BriefText text={card.fields[key] || '待明确'} expanded={expandedField === key}
                  onToggle={() => setExpandedField(expandedField === key ? undefined : key)}/>
                <AIOrigin card={card} field={key}/>
              </>}
          </section>)}
        </div>
        {edit && <div className="rd-edit">
          {editionOutdated && <p className="co-inline-note">需求已有更新，请取消编辑后重新打开。</p>}
          {overview && <label>尚待细化的范围<textarea value={edit.gaps} rows={3}
            onChange={event => setEdit({...edit, gaps: event.target.value})} placeholder="每行一项"/></label>}
          <label>修改说明<textarea value={edit.reason} rows={2}
            onChange={event => setEdit({...edit, reason: event.target.value})} placeholder="说明为什么修改"/></label>
          <p className="co-impact">{overview ? '修改后，相关具体卡需重新核对，项目回到可讨论。' : '修改正文后，本卡需重新确认，项目回到可讨论。'}</p>
          <button type="button" className="primary" disabled={!!editDisabled || !edit.reason.trim() || !!editionOutdated}
            title={editDisabled} onClick={() => void saveEdits()}>保存修改</button>
        </div>}
        <CardHistory project={project} card={card}/>
        <details className="co-detail-sources">
          <summary>本期范围</summary>
          <p>{card.included ? '当前纳入本期' : card.exclusionReason}</p>
          {role === 'pm' && <>
            <label>调整理由<input value={scopeReason} onChange={event => setScopeReason(event.target.value)}
              placeholder="说明纳入或排除的理由"/></label>
            <p>调整范围会要求本卡重新确认，项目回到可讨论。</p>
            <button type="button" disabled={busy || !scopeReason.trim()} onClick={async () => {
              if (await mutate({type: 'scope', cardId: card.id, included: !card.included, reason: scopeReason}, project.stamp)) onClose();
            }}>{card.included ? '移出本期' : '纳入本期'}</button>
          </>}
        </details>
      </section>
    </div>
  </WorkspaceModal>;
}
