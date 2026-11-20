import {isWithdrawnAnswer,isWithdrawalIntent} from '../shared/question-lifecycle';
import {isNoopSuggestion} from '../shared/conclusion-presentation';
import {hasUnresolvedContent} from '../shared/requirement-clarity';
import {participantById,isBusinessOwner,isQuestionRecipient,type ParticipantId,personLabel} from '../shared/participants';
import { randomUUID } from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import { FIELDS, ROLES, cardStatus, versionLabel } from '../shared/types.ts';
import type { Action, Card, ChangeDependency, Confirmation, Delivery, Evidence, ExtractedCard, FieldChange, FieldKey, Fields, IntakeBatch, IntakeCandidate, IntakeDraft, ProblemResolution, Project, Role, Snapshot, SuggestionDraft } from '../shared/types.ts';
import { crmMaterials } from './seed.ts';
import {organizationSchema} from './organization-schema';
import {organizationModules} from '../shared/card-organization';
import {applyPoolAction} from './pool-organization';
import { getChatDisabledReason, type ChatOperation } from '../shared/chat-policy.ts';
import { resolutionDisabledReason } from '../shared/resolution-policy.ts';
import { getSuggestionReview } from '../shared/suggestion-review.ts';
import { concreteCards, intakeAssessment, isOverview, outlineGaps, excludedRequirements } from '../shared/intake-policy.ts';
import {aiReviewFor,aiOriginNote,pendingAIFields,resolvedIntakeFields,splitLegacyAISupplements} from '../shared/intake-fields';
import {aiSupplementsSchema,intakeAIReviewsSchema} from './intake-field-schema';

const now = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}-${randomUUID()}`;
const clone = <T>(value: T): T => structuredClone(value);
const fieldKeys = new Set<string>(FIELDS.map(([key]) => key));
const evidenceText = (value: string) => value.normalize('NFKC').replace(/\s+/gu, '');

function requireRole(actual: Role, allowed: Role[]) {
  if (!allowed.includes(actual)) throw new Error('当前身份没有执行此操作的权限');
}
function text(value: unknown, label: string, required = true): string {
  if (typeof value !== 'string' || (required && !value.trim())) throw new Error(`请填写${label}`);
  return value.trim();
}
function validField(field: string): asserts field is FieldKey {
  if (!fieldKeys.has(field)) throw new Error('只能使用固定的九个需求字段');
}
function validateFields(fields: Fields): Fields {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields) || Object.keys(fields).length !== FIELDS.length) throw new Error('需求正文必须包含固定的九个字段');
  for (const key of Object.keys(fields)) validField(key);
  return Object.fromEntries(FIELDS.map(([key, label]) => [key, text(fields[key], label, false)])) as Fields;
}
function cardFor(project: Project, cardId: string): Card {
  const card = project.cards.find(c => c.id === cardId);
  if (!card) throw new Error('找不到这张需求卡片');
  return card;
}
function audit(project: Project, action: string, role: Role | 'system', detail: string) {
  project.events.push({id: id('event'), action, role, detail, createdAt: now()});
}
function activeDelivery(project: Project) {
  return project.deliveries.find(delivery => !delivery.completedAt);
}
function editable(project: Project) {
  if (activeDelivery(project)) throw new Error('当前 PRD 已冻结交付，请先完成两端交付或重试失败目标，再修改本期需求');
}
function staleSuggestion(card: Card) {
  if (card.suggestion?.status === '待决定') card.suggestion.status = '已失效';
}
function refreshAssessment(card: Card) {
  card.issues = card.blockers.filter(b => !b.resolved).map(b => b.reason);
  card.assessment = card.issues.length || Object.values(card.fields).some(value => !value.trim() || hasUnresolvedContent(value)) ? '待澄清' : '可确认';
}
function invalidate(project: Project, card: Card) {
  card.approvals = {};
  card.round += 1;
  staleSuggestion(card);
  project.phase = '可讨论';
}
function writeRevision(project: Project, card: Card, fields: Fields, title: string, reason: string) {
  const changed = title !== card.title || FIELDS.some(([key]) => fields[key] !== card.fields[key]);
  if (!changed) return false;
  card.fields = clone(fields);
  card.title = title;
  card.revision += 1;
  card.history.push({revision: card.revision, fields: clone(fields), reason, createdAt: now()});
  invalidate(project, card);
  refreshAssessment(card);
  return true;
}
function assertConfirmable(card: Card) {
  if (isOverview(card)) throw new Error('概要卡须先细化为具体卡，不参与产品与业务整卡确认');
  if (!card.included) throw new Error('本期不纳入的卡片不参与确认');
  if (card.blockers.some(b => !b.resolved)) throw new Error('请先解决这张卡片的阻断问题');
  if (card.assessment === '需评估') throw new Error('请先完成需求合理性评估');
  if (FIELDS.some(([key]) => !card.fields[key].trim() || hasUnresolvedContent(card.fields[key]))) throw new Error('请先明确全部九个字段，未知内容不能确认');
}
function confirmation(card: Card, role: 'pm' | 'business', result: Confirmation['result'], comment: string): Confirmation {
  return {id: id('confirmation'), role, revision: card.revision, round: card.round, result, comment, createdAt: now()};
}
function approved(card: Card, role: 'pm' | 'business') {
  const approval = card.approvals[role];
  return approval?.result === '通过' && approval.revision === card.revision && approval.round === card.round;
}
function addProblem(card: Card, field: FieldKey, reason: string) {
  if (!card.blockers.some(b => !b.resolved && b.field === field && b.reason === reason)) card.blockers.push({id: id('blocker'), field, reason, resolved: false, createdAt: now()});
  refreshAssessment(card);
}
function evidenceFor(project: Project, card: Card | undefined, item: Evidence, allowedMaterialIds?: string[]): Evidence {
  const quote = text(item.quote, '来源原文');
  if (item.materialId) {
    const material = project.materials.find(m => m.id === item.materialId);
    if (!material || (allowedMaterialIds && !allowedMaterialIds.includes(item.materialId))) throw new Error('建议引用了不属于本次材料的来源');
    if (!evidenceText(material.text).includes(evidenceText(quote))) throw new Error('材料依据必须引用可核对的原文');
    return {materialId: material.id, quote, location: item.location?.trim() || material.location};
  }
  if (item.messageId && card) {
    if(isWithdrawnAnswer(card,item.messageId))throw new Error('该历史答复已撤回，不能作为当前修改依据');
    const message = card.messages.find(m => m.id === item.messageId);
    if (!message || !evidenceText(message.text).includes(evidenceText(quote))) throw new Error('讨论依据必须来自当前卡片的原始消息');
    return {messageId: message.id, quote, location: item.location?.trim()};
  }
  throw new Error('来源依据缺少有效的材料或消息编号');
}
function validateProblemResolutions(project: Project, card: Card, candidates: ProblemResolution[] | undefined, changes: FieldChange[], issues: string[] = []): ProblemResolution[] {
  if (candidates === undefined) return [];
  if (!Array.isArray(candidates)) throw new Error('问题解决建议必须为列表');
  const seen = new Set<string>();
  // Check whether each proposed conclusion can work with its own field changes before offering it.
  const proposedCard: Card = {...card, suggestion: {id: 'validation', baseRevision: card.revision, messageCount: card.messages.length, summary: '', issues: [], changes, createdAt: '', status: '待决定'}};
  const allAccepted = Object.fromEntries(changes.map(change => [change.field, '采纳'])) as Partial<Record<FieldKey, '采纳'>>;
  return candidates.map(candidate => {
    const disabled = resolutionDisabledReason(proposedCard, candidate, allAccepted);
    if (disabled) throw new Error(disabled);
    if (seen.has(candidate.blockerId)) throw new Error('同一问题不能重复提出解决建议');
    seen.add(candidate.blockerId);
    const blocker = card.blockers.find(item => item.id === candidate.blockerId)!;
    if (issues.some(issue => evidenceText(issue) === evidenceText(blocker.reason))) throw new Error('同一问题同时被列为待明确和可解决，建议存在矛盾，请继续讨论并重新整理');
    return {
      ...(candidate.scopeReview?{scopeReview:{...candidate.scopeReview}}:{}),
      blockerId: candidate.blockerId, resolution: text(candidate.resolution, '问题解决结论'),
      requiredFields: [...candidate.requiredFields], requiredRoles: [...candidate.requiredRoles],
      evidence: candidate.evidence.map(item => evidenceFor(project, card, item)),
    };
  });
}
function validateDependencies(dependencies: ChangeDependency[] | undefined, changes: FieldChange[]): ChangeDependency[] {
  if (dependencies === undefined) return [];
  if (!Array.isArray(dependencies)) throw new Error('字段关联必须为列表');
  const changedKeys = new Set(changes.map(change => change.field));
  const seen = new Set<FieldKey>();
  return dependencies.map(dependency => {
    if (!dependency || typeof dependency !== 'object') throw new Error('字段关联不完整');
    validField(dependency.field);
    if (!changedKeys.has(dependency.field) || seen.has(dependency.field)) throw new Error('字段关联必须指向本轮建议，且同一字段不能重复');
    seen.add(dependency.field);
    if (!Array.isArray(dependency.requires) || !dependency.requires.length || new Set(dependency.requires).size !== dependency.requires.length || dependency.requires.some(key => key === dependency.field || !changedKeys.has(key))) throw new Error('依赖字段必须是本轮其他修改字段，且不能重复');
    const reason = text(dependency.reason, '字段关联冲突原因');
    if (reason.length > 5000) throw new Error('字段关联冲突原因不能超过 5000 字');
    return {field: dependency.field, requires: [...dependency.requires], reason};
  });
}
function reviewContent(cards: Card[], excluded: {id: string; title: string; reason: string}[]) {
  return JSON.stringify({
    cards: cards.map(card => ({id: card.id, title: card.title, type: card.type, fields: FIELDS.map(([key]) => card.fields[key])})).sort((a, b) => a.id.localeCompare(b.id)),
    excluded: excluded.map(card => ({id: card.id, title: card.title, reason: card.reason})).sort((a, b) => a.id.localeCompare(b.id)),
  });
}

export function createProject(name: string): Project {
  const createdAt = now();
  return {id: id('project'), name: text(name, '项目名称'), stamp: 0, phase: '可讨论', version: [0, 0, 0], cards: [], materials: crmMaterials(createdAt), snapshots: [], deliveries: [], events: [], createdAt};
}

export function addExtractedCards(project: Project, drafts: ExtractedCard[], materialIds: string[]): void {
  editable(project);
  if (!Array.isArray(drafts) || !drafts.length) throw new Error('本次未整理出需求卡片，请检查材料后重试');
  if (!materialIds.length || materialIds.some(materialId => !project.materials.some(m => m.id === materialId && m.text.trim()))) throw new Error('请先选择可读取正文的材料');
  const cards = drafts.map(draft => {
    const sourceIds = [...new Set(draft.sourceIds?.length ? draft.sourceIds : materialIds)];
    if (sourceIds.some(sourceId => !materialIds.includes(sourceId))) throw new Error('需求卡片引用了本次未整理的材料');
    if (!['需评估', '待澄清', '可确认'].includes(draft.assessment)) throw new Error('需求评估结果不正确');
    const fields = validateFields(draft.fields);
    const provenance = Object.fromEntries(FIELDS.map(([key]) => [key, (draft.evidence?.[key] || []).map(e => evidenceFor(project, undefined, e, sourceIds))])) as Record<FieldKey, Evidence[]>;
    const card: Card = {...(draft.organization?{organization:organizationSchema.parse(draft.organization)}:{}),id: id('card'), title: text(draft.title, '卡片标题'), type: '功能要求', revision: 1, round: 1, fields, sources: sourceIds, provenance, included: true, exclusionReason: '', assessment: draft.assessment, issues: [], messages: [], blockers: [], approvals: {}, confirmations: [], history: [{revision: 1, fields: clone(fields), reason: '从材料整理初稿', createdAt: now()}]};
    for (const issue of draft.issues || []) addProblem(card, 'scope', text(issue, '待明确问题'));
    if (draft.assessment === '需评估' && !card.blockers.length) addProblem(card, 'scope', '请评估本需求的合理性、本期范围与已有制度是否一致');
    if (draft.assessment === '需评估') card.assessment = '需评估';
    return card;
  });
  project.cards.push(...cards);
  for (const materialId of materialIds) {
    const material = project.materials.find(m => m.id === materialId)!;
    material.cardIds = [...new Set([...material.cardIds, ...cards.filter(c => c.sources.includes(materialId)).map(c => c.id)])];
    material.status = material.location === 'CRM 示例项目材料' ? '已整理' : '已生成候选卡';
  }
  project.phase = '可讨论';
  audit(project, '整理材料', 'system', `从 ${materialIds.length} 份材料形成 ${cards.length} 张需求卡片`);
}

function stringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error(`${label}必须为最多 100 项的列表`);
  const values = value.map(item => text(item, label));
  if (values.some(item => item.length > 5000)) throw new Error(`${label}单项不能超过 5000 字`);
  return [...new Set(values)];
}
function checkedIntakeCandidates(project: Project, candidates: IntakeCandidate[], materialIds: string[]): IntakeDraft[] {
  if (!Array.isArray(candidates) || candidates.length > 100) throw new Error('候选需求卡片必须为最多 100 项的列表');
  if (!materialIds.length || new Set(materialIds).size !== materialIds.length || materialIds.some(materialId => !project.materials.some(material => material.id === materialId && material.text.trim()))) throw new Error('请先选择可读取正文的材料');
  const keys = new Map<string, string>();
  const titles = new Set<string>();
  for (const candidate of candidates) {
    const key = text(candidate.key, '候选卡片编号');
    if (key !== candidate.key || key.length > 120 || keys.has(key)) throw new Error('候选卡片编号必须唯一、不含首尾空格且不超过 120 字');
    keys.set(key, id('draft'));
  }
  return candidates.map(original => {
    const candidate=splitLegacyAISupplements(original);
    if (!['概要', '具体'].includes(candidate.granularity) || !['材料要求', '建议补充'].includes(candidate.origin)) throw new Error('卡片粒度或来源类型不正确');
    if (!['需评估', '待澄清', '可确认'].includes(candidate.assessment)) throw new Error('需求评估结果不正确');
    const title = text(candidate.title, '候选卡片标题');
    if (title.length > 120 || titles.has(evidenceText(title))) throw new Error('同一批次的候选卡片标题须唯一且不超过 120 字');
    titles.add(evidenceText(title));
    const fields = validateFields(candidate.fields);
    if (Object.values(fields).some(value => value.length > 12000)) throw new Error('需求字段不能超过 12000 字');
    if (!Array.isArray(candidate.sourceIds) || !candidate.sourceIds.length || candidate.sourceIds.some(sourceId => !materialIds.includes(sourceId))) throw new Error('候选卡片引用了本次未整理的材料');
    const sourceIds = [...new Set(candidate.sourceIds)];
    const evidence = Object.fromEntries(FIELDS.map(([key]) => [key, (candidate.evidence?.[key] || []).map(item => evidenceFor(project, undefined, item, sourceIds))]));
    const aiSupplements=aiSupplementsSchema.parse(candidate.aiSupplements||{});
    for(const supplement of Object.values(aiSupplements))supplement.evidence=(supplement.evidence||[]).map(item=>evidenceFor(project,undefined,item,sourceIds)) as typeof supplement.evidence;
    const parent = candidate.parentKey ? candidates.find(item => item.key === candidate.parentKey) : undefined;
    if (candidate.parentKey && (!parent || parent.granularity !== '概要' || parent.parentKey || candidate.granularity !== '具体' || parent === candidate)) throw new Error('卡片只允许概要父卡与具体子卡两层关系');
    const related = candidate.relatedCardId ? project.cards.find(card => card.id === candidate.relatedCardId) : project.cards.find(card => evidenceText(card.title) === evidenceText(title));
    if (candidate.relatedCardId && !related) throw new Error('关联的正式需求卡片不存在');
    const issues = stringList(candidate.issues, '待明确问题');
    return {...(candidate.organization?{organization:organizationSchema.parse(candidate.organization)}:{}),id: keys.get(candidate.key)!, ...(parent ? {parentId: keys.get(parent.key)!} : {}), title, fields, sourceIds, evidence, aiSupplements, assessment: intakeAssessment({...candidate, fields, issues}), issues, granularity: candidate.granularity, origin: candidate.origin, rationale: text(candidate.rationale, '粒度判断理由'), coverageGaps: stringList(candidate.coverageGaps, '尚待细化范围'), selected: candidate.origin === '材料要求' && !related, exclusionReason: '', ...(related ? {relatedCardId: related.id} : {})};
  });
}

/** Extraction creates editable candidates only; the formal pool and phase stay unchanged. */
export function attachIntakeBatch(project: Project, candidates: IntakeCandidate[], materialIds: string[]): IntakeBatch {
  editable(project);
  if (project.intakeBatches?.some(batch => batch.materialIds.length === materialIds.length && batch.materialIds.every(materialId => materialIds.includes(materialId)))) throw new Error('这些材料已经生成候选卡片，请在现有批次继续编辑或细化');
  const drafts = checkedIntakeCandidates(project, candidates, materialIds);
  const batch: IntakeBatch = {id: id('intake'), materialIds: [...materialIds], drafts, revision: 1, createdAt: now()};
  project.intakeBatches ||= [];
  project.intakeBatches.push(batch);
  for (const materialId of materialIds) project.materials.find(material => material.id === materialId)!.status = drafts.length ? '已生成候选卡' : '已整理';
  audit(project, '生成材料候选卡', 'system', drafts.length ? `从 ${materialIds.length} 份材料整理 ${drafts.length} 张候选卡，等待产品经理选择入池` : `已分析 ${materialIds.length} 份材料，未识别到可抽取的新需求；可补充业务材料后继续整理`);
  return batch;
}

/** Refining a draft cannot silently overwrite an imported card or already edited children. */
export function attachIntakeRefinement(project: Project, batchId: string, parentDraftId: string, candidates: IntakeCandidate[], expectedBatchRevision: number): IntakeBatch {
  editable(project);
  const batch = project.intakeBatches?.find(item => item.id === batchId);
  if (!batch || batch.revision !== expectedBatchRevision) throw new Error('材料草稿已经变化，请重新打开后细化');
  const parent = batch.drafts.find(draft => draft.id === parentDraftId);
  if (!parent || parent.granularity !== '概要') throw new Error('只有概要卡可以继续细化');
  const drafts = checkedIntakeCandidates(project, candidates, batch.materialIds);
  const proposedParent = candidates.find(candidate => candidate.key === parentDraftId);
  if (!proposedParent || proposedParent.granularity !== '概要' || proposedParent.parentKey || candidates.some(candidate => candidate !== proposedParent && (candidate.granularity !== '具体' || candidate.parentKey !== parentDraftId))) throw new Error('细化结果必须包含原概要和直接关联的具体子卡');
  const formalParent = parent.poolCardId ? cardFor(project, parent.poolCardId) : undefined;
  const source = formalParent ? {title: formalParent.title, fields: formalParent.fields} : parent;
  if (proposedParent.title !== source.title || FIELDS.some(([key]) => proposedParent.fields[key].trim() !== source.fields[key])) throw new Error('细化不能自动改写原概要正文，请先人工编辑');
  const returnedParent = drafts[candidates.indexOf(proposedParent)];
  if (formalParent && JSON.stringify(returnedParent.coverageGaps) !== JSON.stringify(formalParent.coverageGaps || [])) throw new Error('已入池概要的尚待细化范围不能由 Agent 自动改写，请先到需求池编辑正式概要范围，再重新细化');
  const children = drafts.filter(draft => draft !== returnedParent);
  const existingNames = new Set(batch.drafts.filter(draft => draft.id !== parent.id).map(draft => evidenceText(draft.title)));
  if (children.some(child => existingNames.has(evidenceText(child.title)))) throw new Error('细化结果与现有候选卡重复，请保留原卡并重新生成未覆盖范围');
  if (batch.drafts.length + children.length > 100) throw new Error('同一批次最多保留 100 张候选卡');
  for (const child of children) child.parentId = parent.id;
  // Keep the original scope record. AI can add hints but cannot erase human-identified gaps.
  if (!parent.poolCardId) parent.coverageGaps = [...new Set([...parent.coverageGaps, ...returnedParent.coverageGaps])];
  batch.drafts.push(...children);
  batch.revision += 1;
  audit(project, '细化概要候选卡', 'system', `${source.title}：新增 ${children.length} 张具体候选卡，尚未写入需求池`);
  return batch;
}

function saveIntake(project: Project, action: Extract<Action, {type:'saveIntake'}>, role: Role): void {
  requireRole(role, ['pm']); editable(project);
  const batch = project.intakeBatches?.find(item => item.id === action.batchId);
  if (!batch || batch.revision !== action.revision) throw new Error('材料草稿已经变化，请刷新后重新确认');
  if (!Array.isArray(action.drafts) || action.drafts.length !== batch.drafts.length || new Set(action.drafts.map(draft => draft.id)).size !== action.drafts.length) throw new Error('请完整提交本批次草稿，同一草稿不能重复');
  if (typeof action.importSelected !== 'boolean') throw new Error('请选择保存草稿或保存到需求池');
  const draftCopy = clone(batch.drafts).map(draft=>draft.poolCardId?draft:splitLegacyAISupplements(draft));
  const edits: string[] = [];
  for (const update of action.drafts) {
    const draft = draftCopy.find(item => item.id === update.id);
    if (!draft) throw new Error('提交内容含有不属于本批次的草稿');
    const fields = validateFields(update.fields);
    const title = text(update.title, '候选卡片标题');
    if (title.length > 120 || Object.values(fields).some(value => value.length > 12000)) throw new Error('候选卡片标题或字段过长');
    if (typeof update.selected !== 'boolean') throw new Error('候选卡片必须明确选择是否入池');
    const exclusionReason = text(update.exclusionReason, '本期排除理由', false);
    if (exclusionReason.length > 5000) throw new Error('本期排除理由不能超过 5000 字');
    const coverageGaps = stringList(update.coverageGaps, '尚待细化范围');
    const organization = update.organization?organizationSchema.parse(update.organization):draft.organization;
    const aiReviews=intakeAIReviewsSchema.parse(update.aiReviews??draft.aiReviews??{});
    for(const [key] of Object.entries(aiReviews))if(!draft.aiSupplements?.[key as FieldKey])throw new Error('不能为不存在的 AI 补充提交保留或删除决定');
    const aiChanged=!isDeepStrictEqual(aiReviews,draft.aiReviews||{});
    const organizationChanged=JSON.stringify(organization)!==JSON.stringify(draft.organization);
    const changedFields = FIELDS.filter(([key]) => fields[key] !== draft.fields[key]).map(([key]) => key);
    const changed = organizationChanged || title !== draft.title || changedFields.length || update.selected !== draft.selected || exclusionReason !== draft.exclusionReason || JSON.stringify(coverageGaps) !== JSON.stringify(draft.coverageGaps);
    if (draft.poolCardId) {
      if (changed||aiChanged) throw new Error('已入池卡片请到需求池编辑，材料箱不再维护第二份正文');
      continue;
    }
    if (draft.relatedCardId && (aiChanged || organizationChanged || title !== draft.title || changedFields.length || update.selected || JSON.stringify(coverageGaps) !== JSON.stringify(draft.coverageGaps))) throw new Error('已有关联正式卡，请到原卡沟通；材料箱仅可记录已核对覆盖或本期排除的理由');
    if (update.selected && exclusionReason) throw new Error('选中入池的卡片不能同时标记本期排除');
    if (changed) edits.push(`${title}${changedFields.length ? `（调整${changedFields.map(key => FIELDS.find(([field]) => field === key)![1]).join('、')}）` : ''}`);
    for (const key of changedFields) draft.evidence[key] = [];
    draft.editedFields = [...new Set([...(draft.editedFields || []), ...changedFields])];
    Object.assign(draft, {...(organization?{organization}:{}),title, fields, selected: update.selected, exclusionReason, coverageGaps});
    if(draft.aiReviews||update.aiReviews||Object.keys(draft.aiSupplements||{}).length)draft.aiReviews=aiReviews;
    for(const [key,label] of FIELDS){const review=draft.aiReviews?.[key];if(!review)continue;
      if(!aiReviewFor(draft,key)?.decision){delete review.decision;delete review.reviewedText;delete review.reviewedBase;}
      if(review.decision==='保留'&&!review.text.trim())throw new Error(`${label}的 AI 补充为空，请填写内容或选择删除`);
      if(aiChanged&&review.decision)edits.push(`${title}：${review.decision} AI 分析补充（${label}）`);
    }
    draft.assessment = intakeAssessment(draft);
  }
  const selected = action.importSelected ? draftCopy.filter(draft => draft.selected && !draft.poolCardId) : [];
  for (const draft of [...selected]) {
    if (draft.parentId) {
      const parent = draftCopy.find(item => item.id === draft.parentId)!;
      if (parent.exclusionReason) throw new Error('概要已标记本期排除，请先恢复概要后再纳入其子需求');
      if (parent.poolCardId && !cardFor(project, parent.poolCardId).included) throw new Error('所属概要已排除，请先在需求池恢复概要，再保存具体子卡');
      if (!parent.poolCardId && !selected.includes(parent)) {parent.selected = true; selected.push(parent);}
    }
  }
  const existingTitles = new Set(project.cards.map(card => evidenceText(card.title)));
  for (const draft of selected) {
    const pending=pendingAIFields(draft);
    if(pending.length)throw new Error(`“${draft.title}”还有 ${pending.length} 项 AI 分析补充未处理，请逐项选择保留或删除后再加入需求池`);
    if(Object.values(resolvedIntakeFields(draft)).some(value=>value.length>12000))throw new Error(`“${draft.title}”合并后的字段超过 12000 字，请精简后再入池`);
    if (draft.relatedCardId || existingTitles.has(evidenceText(draft.title))) throw new Error(`“${draft.title}”已有关联或同名正式卡，请到原卡沟通，不能重复入池`);
    existingTitles.add(evidenceText(draft.title));
  }
  // Prepare all cards on an isolated copy so any validation failure leaves the project intact.
  const prepared = clone(project);
  const previousCount = prepared.cards.length;
  if (selected.length) addExtractedCards(prepared, selected.map(draft => ({...draft,fields:resolvedIntakeFields(draft), ...(draft.granularity === '概要' ? {assessment: '待澄清' as const, issues: []} : {})})), batch.materialIds);
  const newCards = prepared.cards.slice(previousCount);
  selected.forEach((draft, index) => {draft.poolCardId = newCards[index].id; draft.selected = true;});
  selected.forEach((draft, index) => {
    const card = newCards[index];
    card.granularity = draft.granularity;
    card.intakeDraftId = draft.id;
    for(const [key] of FIELDS){const review=aiReviewFor(draft,key);if(review?.decision!=='保留')continue;
      card.aiOrigins||={};card.aiOrigins[key]={...clone(review.supplement),text:review.text.trim(),fieldValue:card.fields[key],reviewedBy:role,reviewedAt:now()};
    }
    if(card.aiOrigins)card.history[0].reason+='；AI 分析补充经产品经理逐项选择保留';
    if (draft.parentId) card.parentId = draftCopy.find(parent => parent.id === draft.parentId)!.poolCardId;
    if (isOverview(card)) card.coverageGaps = [...new Set([...draft.coverageGaps, ...draft.issues])];
    if (draft.editedFields?.length) card.history[0].reason += `；产品经理调整：${draft.editedFields.map(key => FIELDS.find(([field]) => field === key)![1]).join('、')}`;
  });
  const oldGaps = JSON.stringify(outlineGaps(project));
  const oldExclusions = JSON.stringify(excludedRequirements(project));
  if (action.importSelected) {
    for (const draft of draftCopy) {
      if (batch.drafts.find(item => item.id === draft.id)!.poolCardId) continue;
      draft.acceptedExclusionReason = draft.poolCardId ? '' : draft.exclusionReason;
      draft.acceptedExclusionTitle = draft.acceptedExclusionReason ? draft.title : undefined;
    }
  }
  batch.drafts = draftCopy;
  batch.revision += 1;
  project.cards.push(...newCards);
  if(newCards.some(c=>c.organization))project.moduleOrder=organizationModules(project);
  if (newCards.length) {
    for (const materialId of batch.materialIds) {
      const material = project.materials.find(item => item.id === materialId)!;
      material.cardIds = [...new Set([...material.cardIds, ...newCards.filter(card => card.sources.includes(materialId)).map(card => card.id)])];
      material.status = '已整理';
    }
  }
  // Only changes to formal scope reopen the phase; draft edits alone do not revoke confirmations.
  if (newCards.length || (action.importSelected && (oldGaps !== JSON.stringify(outlineGaps(project)) || oldExclusions !== JSON.stringify(excludedRequirements(project))))) project.phase = '可讨论';
  audit(project, action.importSelected ? '保存候选卡到需求池' : '保存材料草稿', role, `新增 ${newCards.filter(card => !isOverview(card)).length} 张具体卡、${newCards.filter(isOverview).length} 张概要卡；保存不代表产品或业务确认${edits.length ? `；人工调整：${edits.join('、')}` : ''}${draftCopy.some(draft => draft.exclusionReason) ? `；${action.importSelected ? '确认排除' : '草稿排除理由'}：${draftCopy.filter(draft => draft.exclusionReason).map(draft => `${draft.title}（${draft.exclusionReason}）`).join('、')}` : ''}`);
}

/** Also used once on startup to repair pending no-op replies from older versions. */
export function completeNoopSuggestion(card:Card):boolean {
  const suggestion=card.suggestion;
  if(!suggestion||suggestion.status==='已写入'||!isNoopSuggestion(suggestion))return false;
  suggestion.status='已写入';suggestion.processedAt=now();suggestion.decisions={};
  card.messages.push({id:id('message'),role:'agent',text:suggestion.summary,kind:'discussion',createdAt:suggestion.createdAt});
  if(card.messageCount!==undefined)card.messageCount=card.messages.length;
  return true;
}

export function attachSuggestion(project: Project, cardId: string, draft: SuggestionDraft, baseRevision: number, messageCount: number): void {
  const card = cardFor(project, cardId);
  const disabled = getChatDisabledReason('suggest', {project, card, role: 'pm'});
  if (disabled) throw new Error(disabled);
  if (card.revision !== baseRevision || card.messages.length !== messageCount) throw new Error('卡片或讨论已经变化，请重新总结后生成建议');
  const seen = new Set<string>();
  const changes = draft.changes.map(change => {
    validField(change.field);
    if (seen.has(change.field)) throw new Error('同一字段不能重复提出修改建议');
    seen.add(change.field);
    if (change.before !== card.fields[change.field]) throw new Error('建议依据的字段内容已经过期，请重新生成');
    const after = text(change.after, '修改后的字段内容', false);
    return {field: change.field, before: change.before, after, reason: text(change.reason, '修改理由'), evidence: (change.evidence || []).map(item => evidenceFor(project, card, item))};
  }).filter(change => change.before !== change.after);
  const issues = (draft.issues || []).map(issue => text(issue, '未明确事项'));
  const dependencies = validateDependencies(draft.dependencies, changes);
  const problemResolutions = validateProblemResolutions(project, card, draft.problemResolutions, changes, issues);
  card.suggestion = {id: id('suggestion'), baseRevision, messageCount, summary: text(draft.summary, '讨论总结'), issues, changes, dependencies, problemResolutions, createdAt: now(), status: '待决定'};
  if(completeNoopSuggestion(card))audit(project,'记录讨论总结','system',`${card.title}：没有需要采纳的变更，保留原需求与人工确认。`);
  else audit(project, '形成字段建议', 'system', `${card.title}：${changes.length} 个字段变化，${problemResolutions.length} 项问题解决建议，等待产品决定`);
}

export function applyAction(project: Project, action: Action, role: Role, participantId?:ParticipantId): void {
  const person=participantById(participantId);
  if(participantId&&(!person||person.role!==role))throw new Error('人员与角色不匹配');
  if(participantId&&['businessConfirm','review'].includes(action.type)&&!isBusinessOwner(role,participantId))throw new Error('由业务负责人陈敏统一确认，其他成员可在群里补充意见');
  const previousEvents=project.events.length;
  applyParticipantAction(project,action,role,participantId);
  if(participantId)for(const event of project.events.slice(previousEvents))if(event.role===role)event.participantId=participantId;
}
function applyParticipantAction(project: Project, action: Action, role: Role, participantId?:ParticipantId): void {
  if (action.type === 'adoptConclusion') {
    requireRole(role, ['pm']);
    // Preview and commit the same review in one transaction; failed checks never partially write.
    const next = clone(project);
    applyAction(next, {...action, type: 'applySuggestion'}, role,participantId);
    const card = cardFor(next, action.cardId);
    const original = cardFor(project, action.cardId);
    const preservesOriginal = !!original.suggestion?.changes.length && card.revision === original.revision &&
      !card.blockers.some(blocker => blocker.resolved && original.blockers.some(old => old.id === blocker.id && !old.resolved));
    if (!preservesOriginal && !getChatDisabledReason('pmConfirm', {project:next,card,role})) applyAction(next, {type:'pmConfirm',cardId:card.id}, role,participantId);
    Object.assign(project, next);
    return;
  }
  requireRole(role, ['pm', 'business', 'reviewer']);
  if(action.type==='pinChat'||action.type==='setPoolGrouping'||action.type==='renameModule'||action.type==='applyModuleGrouping'){applyPoolAction(project,action,role,participantId);return;}
  if (action.type === 'organizeCard') {
    requireRole(role,['pm']);
    const card=cardFor(project,action.cardId),organization=organizationSchema.parse(action.organization);
    if(JSON.stringify(card.organization)!==JSON.stringify(organization)){
      const modules=organizationModules(project);
      card.organization=organization;
      project.moduleOrder=[...new Set([...modules,...(card.granularity==='概要'?[]:[organization.module])])];
      audit(project,'调整需求组织','pm',`${card.title}：${organization.module} · ${organization.priority}；${organization.reason}。正文与确认保持。`);
    }
    return;
  }
  if (action.type === 'saveIntake') {saveIntake(project, action, role); return;}
  if (action.type === 'updateOverview') {
    requireRole(role, ['pm']); editable(project);
    const card = cardFor(project, action.cardId);
    if (!isOverview(card)) throw new Error('只有概要卡可以调整尚待细化范围');
    const title = text(action.title, '概要标题');
    const fields = validateFields(action.fields);
    if (title.length > 120 || Object.values(fields).some(value => value.length > 12000)) throw new Error('概要标题或字段过长');
    const coverageGaps = stringList(action.coverageGaps, '尚待细化范围');
    const reason = text(action.reason, '概要调整原因');
    const changedFields = FIELDS.filter(([key]) => fields[key] !== card.fields[key]).map(([key]) => key);
    const gapChanged = JSON.stringify(card.coverageGaps || []) !== JSON.stringify(coverageGaps);
    const bodyChanged = writeRevision(project, card, fields, title, reason);
    if (bodyChanged) for (const key of changedFields) card.provenance[key] = [];
    if (gapChanged) {
      card.coverageGaps = coverageGaps;
      if (!bodyChanged) {
        card.revision += 1;
        card.history.push({revision: card.revision, fields: clone(card.fields), reason: `调整尚待细化范围：${reason}`, createdAt: now()});
        invalidate(project, card);
      }
    }
    if (changedFields.length) {
      const labels = changedFields.map(key => FIELDS.find(([field]) => field === key)![1]).join('、');
      for (const child of concreteCards(project).filter(item => item.parentId === card.id && item.included)) {
        addProblem(child, 'scope', `概要“${card.title}”修订 ${card.revision} 的${labels}已变化，请核对本具体需求是否仍与共同范围和约束一致，明确后重新确认`);
        invalidate(project, child);
      }
    }
    if (bodyChanged || gapChanged) audit(project, '调整概要范围', role, `${card.title} · 修订 ${card.revision}：${reason}；尚待细化：${coverageGaps.join('；') || '无'}`);
    return;
  }
  if (action.type === 'submitReview') {
    requireRole(role, ['pm']); editable(project);
    if (project.phase !== '可讨论') throw new Error('仅可讨论阶段可以提交新的整体评审');
    const included = concreteCards(project).filter(c => c.included);
    if (!included.length) throw new Error('至少需要一张本期已确认卡片才能提交评审');
    const gaps = outlineGaps(project);
    if (gaps.length) throw new Error(`概要范围尚未覆盖：${gaps.map(item => `${item.title}（${item.reasons.join('；')}）`).join('、')}`);
    if (included.some(c => cardStatus(c) !== '已确认')) throw new Error('本期全部卡片均完成产品与业务确认后才能提交评审');
    for (const card of included) assertConfirmable(card);
    const lastReviewEvent = project.events.findLast(event => ['整体评审要求修改', '提交整体评审', '整体评审通过'].includes(event.action));
    const rejectedSnapshot = project.snapshots.at(-1);
    if (lastReviewEvent?.action === '整体评审要求修改' && rejectedSnapshot?.phase === '可评审') {
      const excluded = excludedRequirements(project);
      if (reviewContent(included, excluded) === reviewContent(rejectedSnapshot.cards, rejectedSnapshot.excluded)) throw new Error('当前内容和范围与被退回的 PRD 完全一致，请回到需求卡片处理评审退回意见后再提交');
    }
    project.version[2] += 1;
    project.phase = '可评审';
    project.snapshots.push(makeSnapshot(project, '可评审', versionLabel(project)));
    audit(project, '提交整体评审', role, versionLabel(project));
    return;
  }
  if (action.type === 'review') {
    requireRole(role, ['business','reviewer']); editable(project);
    if (project.phase !== '可评审') throw new Error('当前没有待整体评审的 PRD');
    if (action.result !== '通过' && action.result !== '要求修改') throw new Error('请选择正确的评审结果');
    const comment = text(action.comment, '评审意见', action.result === '要求修改');
    if (action.result === '要求修改') {
      project.phase = '可讨论';
      audit(project, '整体评审要求修改', role, comment);
      return;
    }
    const reviewSnapshot = project.snapshots.at(-1);
    if (!reviewSnapshot || reviewSnapshot.phase !== '可评审') throw new Error('缺少本轮评审快照');
    project.version[1] += 1; project.version[2] = 0;
    project.phase = '已明确';
    const snapshot = makeSnapshot(project, '已明确', versionLabel(project), reviewSnapshot);
    snapshot.reviewComment = comment;
    project.snapshots.push(snapshot);
    audit(project, '整体评审通过', role, `${versionLabel(project)} ${comment}`.trim());
    return;
  }
  const card = cardFor(project, action.cardId);
  const operation: ChatOperation | undefined = action.type === 'scope' ? undefined : action.type === 'message' ? 'discuss' : action.type === 'businessConfirm'
    ? action.result === '要求修改' ? 'businessReject' : action.result === '暂无法确认' ? 'businessDefer' : 'businessConfirm'
    : action.type;
  if (operation) {
    const disabled = getChatDisabledReason(operation, {project, card, role,participantId});
    if (disabled) throw new Error(disabled);
  }
  if (action.type === 'message' || action.type === 'proposeChange') {
    const value = text(action.text, action.type === 'message' ? '讨论内容' : '变更诉求');
    if (action.type === 'proposeChange') requireRole(role, ['business']);
    if(action.type==='message'&&action.replyTo&&!card.followUps?.some(q=>q.id===action.replyTo&&(['waiting','deferred'].includes(q.status)&&q.baseRevision===card.revision||q.status==='answered'&&isWithdrawalIntent(action.text))&&isQuestionRecipient(q,role,participantId)))throw new Error('这条追问已更新，请核对最新问题后再回复。');
    card.messages.push({id: id('message'), role, ...(participantId?{participantId}:{}), text: value, kind: action.type === 'message' ? 'discussion' : 'change', createdAt: now(),...(action.type==='message'&&action.replyTo?{replyTo:action.replyTo}:{}),...(action.type==='message'&&action.clientMessageId?{clientMessageId:action.clientMessageId}:{})});
    staleSuggestion(card);
    audit(project, action.type === 'message' ? '卡片讨论' : '提出变更诉求', role, card.title);
    return;
  }
  editable(project);
  switch (action.type) {
    case 'editCard': {
      requireRole(role, ['pm']);
      const fields = validateFields(action.fields);
      const title = text(action.title, '卡片标题');
      const reason = text(action.reason, '修改原因');
      const changedFields = FIELDS.filter(([key]) => fields[key] !== card.fields[key]).map(([key]) => key);
      if (writeRevision(project, card, fields, title, reason)) {
        for (const key of changedFields) card.provenance[key] = [];
        audit(project, '编辑需求卡片', role, `${card.title} · 修订 ${card.revision}：${reason}`);
      }
      break;
    }
    case 'applySuggestion': {
      requireRole(role, ['pm']);
      const suggestion = card.suggestion;
      if (!suggestion || suggestion.id !== action.suggestionId || suggestion.status !== '待决定' || suggestion.baseRevision !== card.revision || suggestion.messageCount !== card.messages.length) throw new Error('这份建议已过期，请根据最新讨论重新生成');
      const decisions = action.decisions;
      if (!decisions || typeof decisions !== 'object' || Array.isArray(decisions)) throw new Error('请提交所有变化字段的审核选择');
      for (const key of Object.keys(decisions)) {
        validField(key);
        if (!suggestion.changes.some(change => change.field === key)) throw new Error('未修改的字段无需决定');
      }
      if (suggestion.changes.some(change => !['采纳', '不采纳'].includes(decisions[change.field] || ''))) throw new Error('请对所有变化字段完成采纳或不采纳决定');
      const accepted = suggestion.changes.filter(change => decisions[change.field] === '采纳');
      const rejected = suggestion.changes.filter(change => decisions[change.field] === '不采纳');
      const overrides: Partial<Record<FieldKey, string>> = {};
      if (action.overrides !== undefined) {
        if (!action.overrides || typeof action.overrides !== 'object' || Array.isArray(action.overrides)) throw new Error('人工调整内容必须按字段提交');
        for (const [key, value] of Object.entries(action.overrides)) {
          validField(key);
          if (!accepted.some(change => change.field === key)) throw new Error('只能调整本轮已选中的建议字段');
          const adjusted = text(value, '人工调整后的字段内容');
          if (adjusted.length > 6000) throw new Error('人工调整后的字段内容不能超过 6000 字');
          overrides[key] = adjusted;
        }
      }
      validateDependencies(suggestion.dependencies, suggestion.changes);
      const review = getSuggestionReview(card, decisions, overrides);
      const selectedIds = action.resolvedBlockerIds ?? [];
      if (!Array.isArray(selectedIds) || selectedIds.some(value => typeof value !== 'string' || !value.trim()) || new Set(selectedIds).size !== selectedIds.length) throw new Error('请选择有效且不重复的问题');
      const selectedCandidates = selectedIds.map(blockerId => {
        const candidate = suggestion.problemResolutions?.find(item => item.blockerId === blockerId);
        if (!candidate) throw new Error('所选问题没有对应的 Agent 解决建议，请重新整理');
        return candidate;
      });
      // Everything below must pass before fields, approvals, stage or blockers are changed.
      const resolutions = validateProblemResolutions(project, card, selectedCandidates, suggestion.changes, suggestion.issues);
      for (const candidate of resolutions) {
        const disabled = resolutionDisabledReason(card, candidate, decisions, overrides);
        if (disabled) throw new Error(disabled);
      }
      const {fields, adjustedFields, dependencyProblems} = review;
      const bodyChanged = review.changedFields.length > 0;
      const knownIssues = new Set(card.blockers.filter(blocker => !blocker.resolved).map(blocker => evidenceText(blocker.reason)));
      const proposedIssues = [...suggestion.issues.map(issue => ({field: 'scope' as FieldKey, reason: text(issue, '未明确事项')})), ...dependencyProblems];
      const newIssues = bodyChanged || resolutions.length ? proposedIssues.filter(issue => {
        const normalized = evidenceText(issue.reason);
        if (knownIssues.has(normalized)) return false;
        knownIssues.add(normalized);
        return true;
      }) : [];
      suggestion.decisions = clone(decisions);
      suggestion.overrides = clone(overrides);
      const adjustmentDetail = adjustedFields.length ? `；人工调整${adjustedFields.map(key => FIELDS.find(([field]) => field === key)![1]).join('、')}` : '';
      if (writeRevision(project, card, fields, card.title, `产品经理审核 Agent 建议${adjustmentDetail}`)) {
        for (const change of accepted) {
          if (review.changedFields.includes(change.field)) {
            card.provenance[change.field] = adjustedFields.includes(change.field) ? [] : clone(change.evidence);
            for(const reference of card.provenance[change.field])if(reference.materialId&&!card.sources.includes(reference.materialId))card.sources.push(reference.materialId);
          }
        }
      }
      for (const issue of newIssues) addProblem(card, issue.field, issue.reason);
      if (!bodyChanged && newIssues.length) invalidate(project, card);
      for (const candidate of resolutions) {
        const blocker = card.blockers.find(item => item.id === candidate.blockerId)!;
        blocker.resolved = true;
        blocker.resolution = candidate.resolution;
        blocker.resolutionEvidence = clone(candidate.evidence);
        for(const reference of candidate.evidence)if(reference.materialId&&!card.sources.includes(reference.materialId))card.sources.push(reference.materialId);
        blocker.resolvedAt = now();
        blocker.resolvedBy = role;
        blocker.resolutionSuggestionId = suggestion.id;
      }
      if (resolutions.length) refreshAssessment(card);
      suggestion.status = '已写入';
      suggestion.processedAt = now();
      audit(project, '决定字段建议', role, `${card.title}：采纳 ${accepted.length} 项，保留 ${rejected.length} 项，解决 ${resolutions.length} 个问题${adjustmentDetail}${resolutions.length ? `：${resolutions.map(item => item.resolution).join('；')}` : ''}`);
      break;
    }
    case 'scope': {
      requireRole(role, ['pm']);
      if (typeof action.included !== 'boolean') throw new Error('本期范围必须为纳入或不纳入');
      const reason = text(action.reason, '范围调整原因');
      if (!action.included && isOverview(card) && project.cards.some(child => child.parentId === card.id && child.included)) throw new Error('概要仍有本期具体子卡，请先逐张处理子卡范围后再排除概要');
      if (action.included && card.parentId && !cardFor(project, card.parentId).included) throw new Error('所属概要已排除，请先恢复概要为本期范围，再纳入具体子卡');
      if (card.included === action.included && (action.included || card.exclusionReason === reason)) break;
      card.included = action.included; card.exclusionReason = action.included ? '' : reason;
      invalidate(project, card);
      audit(project, '调整本期范围', role, `${card.title}：${action.included ? '纳入' : '不纳入'}；${reason}`);
      break;
    }
    case 'addBlocker': {
      validField(action.field);
      const reason = text(action.reason, '阻断原因');
      addProblem(card, action.field, reason); invalidate(project, card);
      audit(project, '记录阻断问题', role, `${card.title}：${reason}`);
      break;
    }
    case 'resolveBlocker': {
      requireRole(role, ['pm']);
      const blocker = card.blockers.find(item => item.id === action.blockerId);
      if (!blocker) throw new Error('找不到该阻断问题');
      const reason = text(action.reason, '解决依据');
      if (blocker.resolved) break;
      blocker.resolved = true; blocker.resolution = reason; blocker.resolvedAt = now(); blocker.resolvedBy = role;
      refreshAssessment(card);
      audit(project, '解决阻断问题', role, `${card.title}：${reason}`);
      break;
    }
    case 'pmConfirm': {
      requireRole(role, ['pm']); assertConfirmable(card);
      if (approved(card, 'pm')) break;
      const record = {...confirmation(card, 'pm', '通过', '产品已核对全部九字段，发起业务确认'),...(participantId?{participantId}:{})};
      card.confirmations.push(record); card.approvals.pm = record;
      audit(project, '产品整卡确认', role, `${card.title} · 修订 ${card.revision} · 第 ${card.round} 轮`);
      break;
    }
    case 'businessConfirm': {
      requireRole(role, ['business']);
      if (!['通过', '要求修改', '暂无法确认'].includes(action.result)) throw new Error('请选择正确的确认结果');
      if (!approved(card, 'pm')) throw new Error('请先由产品经理确认当前修订并发起业务确认');
      if (approved(card, 'business') && action.result === '通过') break;
      if (approved(card, 'business') && action.result === '暂无法确认') throw new Error('当前修订已经确认，如有变化请提出变更或要求修改');
      const comment = text(action.comment, '业务确认意见', action.result !== '通过');
      if (action.result === '通过') assertConfirmable(card);
      const record = {...confirmation(card, 'business', action.result, comment),...(participantId?{participantId}:{})};
      card.confirmations.push(record);
      if (action.result === '要求修改') {
        addProblem(card, 'scope', comment);
        invalidate(project, card);
      } else if (action.result === '暂无法确认') {
        delete card.approvals.business;
      } else card.approvals.business = record;
      audit(project, '业务整卡确认', role, `${card.title}：${action.result}${comment ? `；${comment}` : ''}`);
      break;
    }
    case 'acceptChange': {
      requireRole(role, ['pm']); validField(action.field);
      const message = card.messages.find(item => item.id === action.messageId && item.kind === 'change');
      if (!message) throw new Error('找不到该变更诉求');
      if (message.accepted) throw new Error('该变更已纳入本期沟通');
      message.accepted = true;
      addProblem(card, action.field, `已纳入变更：${message.text}`);
      invalidate(project, card);
      audit(project, '纳入业务变更', role, `${card.title}：${message.text}`);
      break;
    }
    default: throw new Error('不支持的操作');
  }
}

const mdText = (value: string) => value.replace(/[<>]/g, character => character === '<' ? '&lt;' : '&gt;');
export function buildMarkdown(project: Project, cards = concreteCards(project).filter(card => card.included && cardStatus(card) === '已确认'), version = versionLabel(project)): string {
  cards = cards.filter(card => !isOverview(card));
  const lines = [`# ${mdText(project.name)} · 产品需求文档`, '', `版本：${version}`, '', '## 目标与本期范围', '', ...(cards.length ? cards.map(card => `- **${mdText(card.title)}**：${mdText(card.fields.goal)}`) : ['当前尚无本期已确认需求，本页为待明确的空草稿。']), '', '## 已确认需求', ''];
  for (const card of cards) {
    lines.push(`### ${mdText(card.title)}`, '', `需求编号：${card.id} · 类型：${card.type} · 修订：${card.revision} · 确认轮次：${card.round}`, '');
    for (const [key, label] of FIELDS) {
      lines.push(`#### ${label}`, '', mdText(card.fields[key]), '');
      const aiNote=aiOriginNote(card,key);if(aiNote)lines.push(`> ${mdText(aiNote)}`,'');
      const evidence = card.provenance[key];
      if (evidence?.length) {
        lines.push('依据：');
        for (const source of evidence) {
          const material = project.materials.find(item => item.id === source.materialId);
          const message = card.messages.find(item => item.id === source.messageId);
          const reference = material ? `${material.name}（${source.location || material.location}，${material.id}）` : message ? `本卡讨论 ${message.id} · ${personLabel(message)}` : '来源记录';
          lines.push(`- ${mdText(reference)}：“${mdText(source.quote)}”`);
        }
        lines.push('');
      }
    }
    lines.push('确认依据：');
    for (const role of ['pm', 'business'] as const) {
      const record = card.approvals[role];
      if (record) lines.push(`- ${ROLES[role]}：${record.result} · 修订 ${record.revision} · 第 ${record.round} 轮 · ${record.createdAt}（${record.id}）`);
    }
    lines.push('', `关联材料：${card.sources.map(sourceId => mdText(project.materials.find(m => m.id === sourceId)?.name || sourceId)).join('、') || '无'}`, '');
  }
  lines.push('## 本期不纳入', '');
  const excluded = excludedRequirements(project);
  lines.push(...(excluded.length ? excluded.map(card => `- ${mdText(card.title)}（${card.id}）：${mdText(card.reason)}`) : ['无。']));
  lines.push('', '## 文档使用说明', '', '本 PRD 由已确认需求卡片生成。修改请回到需求卡片处理，重新确认与评审后形成新版本。知识中台和 TeamMate 仅接收本最终 PRD；原始材料、讨论和中间建议保留在需求协作平台。', '');
  return lines.join('\n');
}

function makeSnapshot(project: Project, phase: Snapshot['phase'], version: string, base?: Snapshot): Snapshot {
  const cards = clone(base?.cards || concreteCards(project).filter(card => card.included && cardStatus(card) === '已确认'));
  const materials = clone(base?.materials || project.materials);
  const excluded = clone(base?.excluded || excludedRequirements(project));
  const frozenProject = {...project, intakeBatches: [], materials, cards: [...cards, ...excluded.map(item => ({id: item.id, title: item.title, included: false, exclusionReason: item.reason} as Card))]};
  return {id: id('snapshot'), version, phase, createdAt: now(), cards, excluded, materials, markdown: buildMarkdown(frozenProject, cards, version), ...(base?.reviewComment !== undefined ? {reviewComment: base.reviewComment} : {})};
}

export function beginDelivery(project: Project, role: Role, mode: 'http' | 'local'): Delivery {
  requireRole(role, ['pm']);
  if (!['http', 'local'].includes(mode)) throw new Error('交付模式不正确');
  if (project.phase !== '已明确') throw new Error('只有整体评审通过、处于已明确阶段的 PRD 才能交付');
  const existing = activeDelivery(project);
  if (existing) {
    if (existing.mode !== mode) throw new Error('重试必须沿用本轮冻结交付模式');
    for (const target of existing.targets) {
      if (target.status === '失败' || target.status === '待交付') {
        target.status = '交付中'; target.attempts += 1; target.updatedAt = now(); delete target.error;
      }
    }
    audit(project, '重试冻结交付', role, `${existing.snapshot.version} · ${mode === 'local' ? '本地验收' : '接口交付'}`);
    return existing;
  }
  const base = project.snapshots.at(-1);
  if (!base || base.phase !== '已明确' || base.version !== versionLabel(project)) throw new Error('缺少与当前版本一致的已明确 PRD 快照');
  const version = `V${project.version[0] + 1}.0.0`;
  const delivery: Delivery = {id: id('delivery'), snapshot: makeSnapshot(project, '已交付', version, base), createdAt: now(), mode, targets: [
    {key: 'knowledge', name: mode === 'local' ? '知识中台（本地验收）' : '知识中台', status: '交付中', attempts: 1},
    {key: 'teammate', name: mode === 'local' ? 'TeamMate（本地验收）' : 'TeamMate', status: '交付中', attempts: 1},
  ]};
  project.deliveries.push(delivery);
  audit(project, '发起冻结交付', role, `${version} · ${mode === 'local' ? '本地验收，不代表外部平台已接收' : '接口交付'}`);
  return delivery;
}

export function recordDeliveryResult(project: Project, deliveryId: string, targetKey: 'knowledge' | 'teammate', result: {ok: boolean; receipt?: string; error?: string}): void {
  const delivery = project.deliveries.find(item => item.id === deliveryId);
  if (!delivery) throw new Error('找不到该交付记录');
  const target = delivery.targets.find(item => item.key === targetKey);
  if (!target) throw new Error('交付目标不正确');
  if (target.status === '成功') return;
  if (target.status !== '交付中') throw new Error('该目标尚未发起交付或重试');
  if (result.ok && !result.receipt?.trim()) throw new Error('成功交付必须保存可核对的回执');
  target.status = result.ok ? '成功' : '失败'; target.updatedAt = now();
  if (result.ok) { target.receipt = result.receipt!.trim(); delete target.error; }
  else target.error = result.error?.trim() || '接收失败，请检查连接后重试';
  audit(project, '记录交付结果', 'system', `${delivery.snapshot.version} · ${target.name}：${target.status}`);
  if (delivery.targets.every(item => item.status === '成功')) {
    delivery.completedAt = now();
    project.version = delivery.snapshot.version.slice(1).split('.').map(Number) as [number, number, number];
    project.phase = '已交付';
    project.snapshots.push(clone(delivery.snapshot));
    audit(project, '完成 PRD 交付', 'system', `${delivery.snapshot.version}${delivery.mode === 'local' ? '（本地验收）' : ''}`);
  }
}
