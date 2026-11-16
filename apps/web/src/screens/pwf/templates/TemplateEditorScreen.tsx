import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import type { ScreenState } from '../../../states/StateBoundary';
import { ConfirmDialog, StatusPill } from '../../../ui';
import { useCatalogue, useEffective } from '../../adm/governance/hooks';
import { statusText } from '../../adm/governance/labels';
import { REASON_MAX, REASON_MIN, describeRefusal, isDay } from '../../adm/governance/model';
import { useUnits } from '../../adm/members/hooks';
import { useProjectTypeNames } from '../hooks';
import { describeProblem, PERMISSIONS, PATHS, RULE_PERMISSIONS, TEMPLATE_RULE_TYPE, editorLink, holds, todayInVietnam } from '../model';
import { ApplyLineBar } from './ApplyLine';
import { ASSIGNMENT_RULE_CODE, ASSIGNMENT_RULE_TYPE, NO_APPLY_CHANGE, hasApplyChange } from './assignment-model';
import type { ApplyChange } from './assignment-model';
import { workflowCodeFrom } from './codes-model';
import { Diagram, ServerChecks } from './Diagram';
import { browserDraftStore, clearLocalDrafts, dropLocalDraft, draftOfTemplate, findLocalDraft, saveLocalDraft, templateOfDraft } from './draft-store';
import type { DraftScope, LocalDraft } from './draft-store';
import { unitChoices } from './editor-choices';
import { cellOfProblem } from './editor-choices';
import { useEditorSource } from './editor-source';
import type { EditorSource } from './editor-source';
import { problemMapOf, problemWord } from './fields';
import { HistoryDrawer } from './HistoryDrawer';
import { useDebouncedValue } from './hooks';
import { CommitFailure, useTemplateCommit } from './lifecycle';
import { useLivePreview } from './live-preview';
import { useLiveValidation } from './live-validation';
import { PasteDialog } from './PasteDialog';
import { StepDrawer } from './StepDrawer';
import { StepsTable } from './StepsTable';
import { storeRefusalText } from './store';
import { lineOf, lineOfProblem, linesOf, settleAll, unverifiedRows } from './table-model';
import { localProblems, paramsOfTemplate, readTemplate, stepsOf } from './template-model';
import type { Template, TemplateProblem } from './template-model';
import '../pwf.css';
import './templates.css';
import './editor.css';

/**
 * PWF-02: the editor of a workflow procedure, one screen. A header with the name, the kind of project, the version and its state; the line "Áp cho"; one table in which a row is a step and every cell is written where it is
 * read; the diagram under it, drawn by the server from the table. A procedure in force is read only: a new draft is made from it. Saving a draft, submitting it for approval and the approval by a different person go
 * through the rule store (maker and checker), and what a person is writing is kept on the device until it is saved (R70).
 */
export default function TemplateEditorScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <EditorEntry key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function EditorEntry({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions } = useSession();
  const mayUse = holds(permissions, PERMISSIONS.templateManage);
  const source = useEditorSource(mayUse);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const reason = useRef<string>('');
  const state: ScreenState = !mayUse ? 'denied' : source.state === 'loading' ? 'loading' : source.state === 'error' ? 'error' : source.state === 'missing' ? 'empty' : 'default';
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <StateBoundary state={state} onRetry={source.retry}>
        <Editor key={source.key} route={route} source={source} notice={notice} onNotice={setNotice} reason={reason} />
      </StateBoundary>
      <p className="adm-kit-foot" data-testid="footer">
        {t('gova1.footer.reference', { id: route.id, req: route.req ?? '' })}
      </p>
    </section>
  );
}

interface EditorProps extends ScreenProps {
  source: EditorSource;
  notice: string | undefined;
  onNotice: (notice: string | undefined) => void;
  /** The reason of the last save: asked once, then kept for the next quick save of the same procedure. */
  reason: { current: string };
}

const baseLabel = (source: EditorSource): string => (source.base.kind === 'rule' ? `v${source.base.version.version}` : source.base.kind === 'default' ? 'default' : source.base.start);

function Editor({ source, notice, onNotice, reason }: EditorProps) {
  const { t, locale } = useTranslation();
  const navigate = useNavigate();
  const { tenant, permissions, mode } = useSession();
  const me = tenant?.membershipId;
  const writable = mode !== 'READ_ONLY';
  const mayUse = holds(permissions, PERMISSIONS.templateManage);
  const canStore = writable && (permissions === undefined || permissions.includes(RULE_PERMISSIONS.manage));
  const canApprove = writable && (permissions === undefined || permissions.includes(RULE_PERMISSIONS.approve));
  const mayReadRegister = permissions === undefined || permissions.includes(RULE_PERMISSIONS.read);

  // ---- what is on screen ------------------------------------------------------------------------------------------------------------------------------------------
  const [edited, setEdited] = useState<Template | undefined>(undefined);
  const template = edited ?? source.template;
  const [forking, setForking] = useState(false);
  const isNew = source.base.kind === 'new';
  const isDraft = source.base.kind === 'rule' && source.base.version.status === 'DRAFT';
  const canEdit = mayUse && writable && (isNew || isDraft || forking);
  const [apply, setApply] = useState<ApplyChange>(NO_APPLY_CHANGE);
  const [attempted, setAttempted] = useState(false);
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const [focusKey, setFocusKey] = useState<string | undefined>(undefined);
  const [openLine, setOpenLine] = useState<string | undefined>(undefined);
  const [panel, setPanel] = useState<'history' | undefined>(undefined);
  const [renaming, setRenaming] = useState(false);
  const [pasting, setPasting] = useState(source.base.kind === 'new' && source.base.start === 'paste' && canEdit);
  const [sampleStart, setSampleStart] = useState(() => todayInVietnam());
  const [undo, setUndo] = useState<{ before: Template; after: Template } | undefined>(undefined);
  const change = useCallback((next: Template): void => setEdited(next), []);
  const touch = useCallback((key: string): void => setTouched((old) => (old.has(key) ? old : new Set([...old, key]))), []);
  // A row taken away can be put back until the next edit: the table says "removed" just before it changes, and the change that follows is the one the undo undoes.
  const removal = useRef<Template | undefined>(undefined);
  const removed = useCallback((before: Template): void => {
    removal.current = before;
  }, []);
  const tableChange = useCallback((next: Template): void => {
    setEdited(next);
    const before = removal.current;
    removal.current = undefined;
    setUndo(before === undefined ? undefined : { before, after: next });
  }, []);

  const name = template.name.trim();
  const local = useMemo(() => localProblems(template), [template]);
  const problems = useMemo(() => problemMapOf(local), [local]);
  const baseKey = useMemo(() => JSON.stringify(paramsOfTemplate(source.template)), [source.template]);
  const key = useMemo(() => JSON.stringify(paramsOfTemplate(template)), [template]);
  const dirty = edited !== undefined && key !== baseKey;

  // ---- the checks of the server -----------------------------------------------------------------------------------------------------------------------------------
  const live = useLivePreview({ template, start: sampleStart, facts: {}, enabled: mayUse && isDay(sampleStart), blocked: local.length > 0 });
  const validation = useLiveValidation(template, mayUse && local.length === 0);
  const ladders = useMemo(() => {
    const found = new Map<string, { green: number | null; yellow: number; red: number }>();
    for (const task of live.result?.preview.tasks ?? []) if (task.band_thresholds !== undefined) found.set(task.task_code, { green: task.band_thresholds.green_days, yellow: task.band_thresholds.yellow_days, red: task.band_thresholds.red_days });
    return found;
  }, [live.result]);
  const unknownDocuments = (validation.current ? (validation.result?.value.findings ?? []) : []).filter((finding) => finding.code === 'LEGAL_DOCUMENT_UNKNOWN' && finding.severity === 'ERROR');

  // ---- who receives a step, and what "Áp cho" points at ---------------------------------------------------------------------------------------------------
  const unitsRead = useUnits(mayUse).data;
  const tenantUnits = useMemo(() => unitsRead ?? [], [unitsRead]);
  const typeNames = useProjectTypeNames(mayUse);
  const assignment = useEffective(ASSIGNMENT_RULE_TYPE, ASSIGNMENT_RULE_CODE, undefined, mayUse);
  const catalogue = useCatalogue(mayUse);
  const takenCodes = catalogue.data?.find((one) => one.ruleType === TEMPLATE_RULE_TYPE)?.codes.map((one) => one.code) ?? [];
  const code = source.code !== '' ? source.code : name === '' ? '' : workflowCodeFrom(name, takenCodes);
  const inForce = useMemo(() => (source.effective === null ? undefined : readTemplate(source.effective.params)), [source.effective]);
  const lockedCodes = useMemo(() => new Set(inForce === undefined ? [] : [...stepsOf(inForce).map((step) => step.code), ...inForce.tasks.map((task) => task.code)]), [inForce]);
  const units = useMemo(() => unitChoices(t, template, tenantUnits, []), [t, template, tenantUnits]);

  // ---- the draft kept on the device (R70) -------------------------------------------------------------------------------------------------------------------------
  const scope: DraftScope | undefined = useMemo(() => (tenant === undefined ? undefined : { tenantId: tenant.id, membershipId: tenant.membershipId, code: source.code === '' ? '~new' : source.code }), [tenant, source.code]);
  const label = baseLabel(source);
  const [found, setFound] = useState<{ state: 'same' | 'conflict'; draft: LocalDraft } | undefined>(undefined);
  const looked = useRef(false);
  useEffect(() => {
    if (looked.current || scope === undefined || !mayUse || !writable) return;
    looked.current = true;
    const result = findLocalDraft(browserDraftStore(), scope, label);
    if (result.state === 'same') {
      setEdited(templateOfDraft(result.draft));
      setApply(result.draft.apply ?? NO_APPLY_CHANGE);
      setForking(true);
      setFound({ state: 'same', draft: result.draft });
    } else if (result.state === 'conflict') setFound({ state: 'conflict', draft: result.draft });
  }, [scope, label, mayUse, writable]);
  const settledKey = useDebouncedValue(key + JSON.stringify(apply), 600);
  const latest = useRef({ template, apply });
  latest.current = { template, apply };
  useEffect(() => {
    if (scope === undefined || !canEdit || !dirty) return;
    saveLocalDraft(browserDraftStore(), scope, draftOfTemplate(latest.current.template, label, new Date(), latest.current.apply));
    // The draft follows the table after the person stops typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settledKey]);
  const forget = (): void => {
    if (scope !== undefined) dropLocalDraft(browserDraftStore(), scope);
    else clearLocalDrafts(browserDraftStore());
  };

  // ---- save and submit --------------------------------------------------------------------------------------------------------------------------------------------
  const commit = useTemplateCommit();
  const [dialog, setDialog] = useState<'draft' | 'submit' | undefined>(undefined);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [from, setFrom] = useState(() => todayInVietnam());
  const halfway = useRef<{ key: string; id: string | undefined; mappingId: string | undefined } | undefined>(undefined);
  const superseded = source.base.kind === 'rule' && source.base.version.status === 'DRAFT' && source.base.version.createdBy === me ? source.base.version : undefined;
  const nextVersion = Math.max(0, ...source.versions.map((version) => version.version)) + 1;

  const guard = (): boolean => {
    setAttempted(true);
    return local.length === 0 && code !== '';
  };
  const ask = (mode: 'draft' | 'submit'): void => {
    if (!guard()) return;
    setFailure(undefined);
    if (mode === 'draft' && reason.current.trim().length >= REASON_MIN && isDay(from)) {
      void run('draft', reason.current);
      return;
    }
    setDialog(mode);
  };
  const run = async (mode: 'draft' | 'submit', why: string): Promise<void> => {
    setPending(true);
    setFailure(undefined);
    const settled = settleAll(template);
    const settledKeyNow = JSON.stringify(paramsOfTemplate(settled));
    const reuse = halfway.current !== undefined && halfway.current.key === settledKeyNow ? { id: halfway.current.id as string, mappingId: halfway.current.mappingId } : undefined;
    try {
      const result = await commit({ template: settled, code, reason: why, effectiveFrom: from, submit: mode === 'submit', apply, assignmentParams: assignment.data?.params ?? {}, supersede: superseded, reuse: reuse?.id === undefined ? undefined : reuse });
      halfway.current = undefined;
      reason.current = why;
      forget();
      setDialog(undefined);
      onNotice(result.submitted ? t('pwfx.saved.submitted', { version: nextVersion }) : t('pwfx.saved.draft', { version: nextVersion }));
      navigate(editorLink(code, result.id), { replace: true });
    } catch (error) {
      const failed = error instanceof CommitFailure ? error : undefined;
      if (failed?.done.id !== undefined) halfway.current = { key: settledKeyNow, id: failed.done.id, mappingId: failed.done.mappingId };
      const cause = failed === undefined ? error : failed.cause;
      setFailure(storeRefusalText(t, describeRefusal(cause), describeProblem(cause)));
      if (dialog === undefined) setDialog(mode);
    } finally {
      setPending(false);
    }
  };

  // ---- reading the screen -----------------------------------------------------------------------------------------------------------------------------------------
  const lines = linesOf(template);
  const shown = (problem: TemplateProblem): boolean => attempted || (lineOfProblem(template, problem.path) !== undefined && touched.has(lineOfProblem(template, problem.path)?.key ?? ''));
  const visibleProblems = local.filter(shown);
  const rowNumber = (path: string): string | undefined => lineOfProblem(template, path)?.number;
  const jump = (problem: TemplateProblem): void => {
    const row = lineOfProblem(template, problem.path);
    if (row === undefined) {
      if (problem.path === 'name') setRenaming(true);
      return;
    }
    const cell = cellOfProblem(problem.path);
    if (cell === 'details') {
      setOpenLine(row.key);
      return;
    }
    const target = document.querySelector<HTMLElement>(`[data-line="${CSS.escape(row.key)}"] [data-field="${cell}"]`);
    target?.scrollIntoView?.({ block: 'center' });
    target?.focus();
  };
  const unverified = unverifiedRows(template);
  const stateWord = source.base.kind === 'new' ? t('pwfx.state.new') : source.base.kind === 'default' ? t('pwfx.state.default') : forking ? t('pwfx.state.draft.new') : source.base.version.phase === 'IN_FORCE' ? t('pwfx.state.inForce') : statusText(t, source.base.version.status);
  const versionWord = source.base.kind === 'rule' && !forking ? t('pwfx.version.number', { version: source.base.version.version }) : t('pwfx.version.number', { version: nextVersion });
  const typeText = template.project_type === null ? t('pwfx.type.any') : (typeNames.get(template.project_type) ?? template.project_type);
  const savedAt = found?.state === 'same' ? new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' }).format(new Date(found.draft.savedAt)) : '';

  return (
    <>
      <Link className="pwfx-crumb" to={PATHS.library} data-testid="link-library">
        ← {t('pwfx.title.back')}
      </Link>
      <div className="heading pwfx-head">
        <div>
          <h1 id="screen-title" data-testid="template-title">
            {name === '' ? t('pwfx.title.new') : name}
          </h1>
          <p className="pwfx-sub" data-testid="template-sub">
            {t('pwfx.sub.type', { type: typeText })} · {versionWord} · <StatusPill tone={canEdit ? 'info' : 'neutral'}>{stateWord}</StatusPill>
            {code === '' ? null : <span className="pwf-code"> {code}</span>}
          </p>
        </div>
        <div className="pwfx-buttons">
          {canEdit ? (
            <button type="button" className="ui-button ui-button--outline" aria-expanded={renaming} data-testid="rename" onClick={() => setRenaming(!renaming)}>
              {t('pwfx.action.rename')}
            </button>
          ) : null}
          {source.code === '' ? null : (
            <button type="button" className="ui-button ui-button--outline" data-testid="history" onClick={() => setPanel('history')}>
              {t('pwfx.action.history')}
            </button>
          )}
          {canEdit ? (
            <>
              <button type="button" className="ui-button ui-button--outline" disabled={!canStore || pending} data-testid="save-draft" onClick={() => ask('draft')}>
                {t('pwfx.action.saveDraft')}
              </button>
              <button type="button" className="ui-button ui-button--primary" disabled={!canStore || pending || unknownDocuments.length > 0} data-testid="submit" onClick={() => ask('submit')}>
                {t('pwfx.action.submit')}
              </button>
            </>
          ) : mayUse && writable && canStore ? (
            <button type="button" className="ui-button ui-button--primary" data-testid="new-draft" onClick={() => setForking(true)}>
              {t('pwfx.action.newDraft')}
            </button>
          ) : null}
        </div>
      </div>

      {notice === undefined ? null : (
        <p className="callout success" role="status" data-testid="notice">
          {notice}{' '}
          <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => onNotice(undefined)}>
            {t('pwfx.notice.close')}
          </button>
        </p>
      )}
      {source.fromMissing ? (
        <p className="callout warning" role="status" data-testid="from-missing">
          {t('pwf.templates.editor.fromMissing.text')}
        </p>
      ) : null}
      {canEdit ? null : (
        <p className="callout" role="status" data-testid="read-only">
          {!mayUse || !writable ? t('pwf.templates.editor.readOnly.text') : source.base.kind === 'rule' && source.base.version.status === 'SUBMITTED' ? t('pwfx.readOnly.submitted') : t('pwfx.readOnly.inForce')}
        </p>
      )}
      {canEdit && !canStore ? (
        <p className="callout" role="status" data-testid="no-store">
          {t('pwf.templates.editor.noStore.text')}
        </p>
      ) : null}
      {found?.state === 'same' ? (
        <p className="callout" role="status" data-testid="restored">
          {t('pwfx.local.restored', { at: savedAt })}{' '}
          <button
            type="button"
            className="ui-button ui-button--outline ui-button--small"
            data-testid="discard-local"
            onClick={() => {
              forget();
              setEdited(undefined);
              setApply(NO_APPLY_CHANGE);
              setForking(false);
              setFound(undefined);
            }}
          >
            {t('pwfx.local.discard')}
          </button>
        </p>
      ) : null}
      {found?.state === 'conflict' ? (
        <div className="callout warning" role="alert" data-testid="local-conflict">
          <p>{t('pwfx.local.conflict', { base: found.draft.base, now: label })}</p>
          <p className="pwfx-buttons">
            <button
              type="button"
              className="ui-button ui-button--primary ui-button--small"
              data-testid="keep-local"
              onClick={() => {
                setEdited(templateOfDraft(found.draft));
                setApply(found.draft.apply ?? NO_APPLY_CHANGE);
                setForking(true);
                setFound(undefined);
              }}
            >
              {t('pwfx.local.keep')}
            </button>
            <button
              type="button"
              className="ui-button ui-button--outline ui-button--small"
              data-testid="drop-local"
              onClick={() => {
                forget();
                setFound(undefined);
              }}
            >
              {t('pwfx.local.drop')}
            </button>
          </p>
        </div>
      ) : null}

      {renaming && canEdit ? (
        <div className="pwfx-rename" data-testid="rename-form">
          <div className="pwf-field">
            <label htmlFor="pwfx-name">{t('pwfx.rename.name')}</label>
            <input id="pwfx-name" type="text" autoComplete="off" maxLength={200} value={template.name} aria-invalid={attempted && name === ''} data-testid="field-name" onChange={(event) => change({ ...template, name: event.target.value })} />
            {attempted && problems.get('name') !== undefined ? <span className="pwfx-cell-error">{problemWord(t, problems.get('name') ?? 'required')}</span> : null}
          </div>
          <div className="pwf-field">
            <label htmlFor="pwfx-type">{t('pwfx.rename.type')}</label>
            <select id="pwfx-type" value={template.project_type ?? ''} data-testid="field-project-type" onChange={(event) => change({ ...template, project_type: event.target.value === '' ? null : event.target.value })}>
              <option value="">{t('pwfx.type.any')}</option>
              {[...new Set([...typeNames.keys(), ...(template.project_type === null ? [] : [template.project_type])])].map((value) => (
                <option key={value} value={value}>
                  {typeNames.get(value) ?? value}
                </option>
              ))}
            </select>
          </div>
        </div>
      ) : null}
      {isNew && !renaming && name === '' && canEdit ? (
        <p className="callout" role="status">
          {t('pwfx.name.first')}{' '}
          <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => setRenaming(true)}>
            {t('pwfx.action.rename')}
          </button>
        </p>
      ) : null}

      <ApplyLineBar templateCode={source.code} rule={assignment.data?.params} change={apply} onChange={setApply} disabled={!canEdit || !canStore} typeNames={typeNames} />

      {unverified === 0 ? null : (
        <p className="callout warning" role="status" data-testid="unverified-note">
          <span aria-hidden="true">⚠ </span>
          {t('pwfx.unverified.note', { count: unverified })}
        </p>
      )}
      {unknownDocuments.length === 0 ? null : (
        <p className="callout danger" role="alert" data-testid="unapproved-documents">
          <span aria-hidden="true">⛔ </span>
          {t('pwfx.unapproved.note', { count: unknownDocuments.length })}
        </p>
      )}
      {visibleProblems.length === 0 ? null : (
        <div className="callout danger" role="alert" data-testid="problem-summary">
          <p>{t('pwfx.summary.count', { count: visibleProblems.length })}</p>
          <ul>
            {visibleProblems.slice(0, 12).map((problem) => (
              <li key={`${problem.path}:${problem.problem}`}>
                <button type="button" className="pwfx-link" data-testid="jump" onClick={() => jump(problem)}>
                  {rowNumber(problem.path) === undefined ? t('pwfx.summary.template') : t('pwfx.summary.row', { row: rowNumber(problem.path) ?? '' })}: {problemWord(t, problem.problem)}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <section className="pwfx-card" aria-labelledby="pwfx-table-title">
        <header className="pwfx-card__head">
          <h2 id="pwfx-table-title">{t('pwfx.table.title')}</h2>
          <span className="pwfx-totals" data-testid="totals">
            {t('pwfx.table.totals', { steps: lines.filter((line) => !line.child).length, days: template.tasks.reduce((sum, task) => sum + (Number.isFinite(task.duration_working_days) ? task.duration_working_days : 0), 0) })}
          </span>
        </header>
        <StepsTable
          template={template}
          onChange={tableChange}
          onRemoved={removed}
          disabled={!canEdit}
          problems={local}
          showAll={attempted}
          touched={touched}
          onTouch={touch}
          tenantUnits={tenantUnits}
          ladders={ladders}
          focusKey={focusKey}
          onFocused={() => setFocusKey(undefined)}
          onFocusRequest={setFocusKey}
          onOpenDetails={setOpenLine}
        />
        <p className="pwfx-tools">
          {canEdit ? (
            <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid="paste" onClick={() => setPasting(true)}>
              {t('pwfx.paste.open')}
            </button>
          ) : null}
          {undo !== undefined && undo.after === template ? (
            <button
              type="button"
              className="ui-button ui-button--outline ui-button--small"
              data-testid="undo"
              onClick={() => {
                setEdited(undo.before);
                setUndo(undefined);
              }}
            >
              {t('pwfx.table.undo')}
            </button>
          ) : null}
        </p>
      </section>

      <Diagram template={template} live={live} start={sampleStart} onStart={setSampleStart} blockedBy={local.length} />
      <ServerChecks result={validation.result?.value} current={validation.current} pending={validation.pending} error={validation.error} rowOf={(path) => (path.startsWith('tasks:') ? lines.find((line) => template.tasks.some((task) => task.code === path.slice(6) && line.taskIndexes.includes(template.tasks.indexOf(task))))?.number : rowNumber(path))} />

      {openLine === undefined || lineOf(template, openLine) === undefined ? null : (
        <StepDrawer template={template} lineKey={openLine} onChange={(next) => setEdited(next)} onClose={() => setOpenLine(undefined)} disabled={!canEdit} lockedCodes={lockedCodes} mayReadRegister={mayReadRegister} />
      )}
      {panel === 'history' && source.code !== '' ? <HistoryDrawer code={source.code} canManage={canStore} canApprove={canApprove} writable={writable} onClose={() => setPanel(undefined)} /> : null}
      {pasting ? (
        <PasteDialog
          template={template}
          phases={template.phases.map((phase) => ({ code: phase.code, name: phase.name }))}
          units={units}
          onClose={() => setPasting(false)}
          onAdd={(next, added) => {
            setPasting(false);
            setEdited(settleAll(next));
            onNotice(t('pwfx.paste.added', { count: added }));
          }}
        />
      ) : null}
      {dialog === undefined ? null : (
        <ConfirmDialog
          open
          title={dialog === 'submit' ? t('pwfx.dialog.submit.title') : t('pwfx.dialog.draft.title')}
          context={[
            { label: t('pwfx.dialog.object'), value: name },
            { label: t('pwfx.dialog.version'), value: t('pwfx.version.number', { version: nextVersion }) },
            ...(dialog === 'submit' ? [{ label: t('pwfx.dialog.checker'), value: t('pwfx.dialog.checker.value') }] : []),
            ...(hasApplyChange(apply) && dialog === 'submit' ? [{ label: t('pwfx.dialog.apply'), value: t('pwfx.dialog.apply.value', { added: apply.added.length, removed: apply.removed.length }) }] : []),
            ...(unverified > 0 ? [{ label: t('pwfx.dialog.unverified'), value: t('pwfx.dialog.unverified.value', { count: unverified }) }] : []),
          ]}
          confirmLabel={dialog === 'submit' ? t('pwfx.action.submit') : t('pwfx.action.saveDraft')}
          cancelLabel={t('gova1.common.cancel')}
          pending={pending}
          confirmDisabled={!isDay(from)}
          reason={{ label: t('pwfx.dialog.reason'), required: true, minLength: REASON_MIN, hint: t('gova1.dialog.reason.hint', { min: REASON_MIN, max: REASON_MAX }) }}
          {...(failure === undefined ? {} : { error: failure })}
          onConfirm={(why) => void run(dialog, (why ?? '').slice(0, REASON_MAX))}
          onCancel={() => {
            setDialog(undefined);
            setFailure(undefined);
          }}
        >
          <div className="pwf-field">
            <label htmlFor="pwfx-from">{t('pwfx.dialog.from')}</label>
            <input id="pwfx-from" type="date" value={from} min={todayInVietnam()} aria-invalid={!isDay(from)} data-testid="effective-from" onChange={(event) => setFrom(event.target.value)} />
            <span className="pwf-hint">{t('pwfx.dialog.from.hint')}</span>
          </div>
        </ConfirmDialog>
      )}
    </>
  );
}
