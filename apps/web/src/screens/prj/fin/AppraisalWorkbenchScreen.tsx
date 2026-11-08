import { ApiError } from '@machvon/api-client';
import { FIN_DEFAULT_SCENARIOS } from '@machvon/kernel/src/fin-defaults.ts';
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { Translator } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { AuditLine, ConfirmDialog, ContextBar, KpiTile, MakerCheckerBadge, SectionCard, StatusPill, StickyActions } from '../../../ui';
import { InputsPanel } from './InputsPanel';
import { ResultsPanel } from './ResultsPanel';
import { useAppraisal, useApproveAppraisal, useCreateAppraisal, useExportAppraisal, useReturnAppraisal, useRunAppraisal, useSubmitAppraisal, useUpdateInputs } from './hooks';
import { LIST_PATH, asOfText, draftOf, draftProblems, idFrom, inputsBody, sameDraft, saveFile, startScenarios, workbenchPath } from './model';
import type { Appraisal, Draft } from './model';
import './fin.css';

type T = Translator['t'];
type Message = { tone: 'ok' | 'error'; text: string };

const statusTone = (status: string): 'neutral' | 'info' | 'success' => (status === 'APPROVED' ? 'success' : status === 'SUBMITTED' ? 'info' : 'neutral');

/** The words of a refusal: the code of the server, and for a missing input the first one named. */
function refusalText(t: T, error: unknown): string {
  if (!(error instanceof ApiError)) return t('fin1.error.failed');
  const missing = error.extensions?.missing;
  if (error.code === 'APPRAISAL_ASSUMPTION_MISSING' && Array.isArray(missing)) return t('fin1.error.missing', { count: missing.length });
  if (error.code === 'APPRAISAL_RESULTS_STALE') return t('fin1.error.stale');
  if (error.code === 'SELF_APPROVAL_DENIED') return t('fin1.error.selfApproval');
  return t('fin1.error.refused', { code: error.code });
}

/**
 * PRJ-24: the workbench of an appraisal of the effectiveness of an investment (lane FIN-1, AI.06). Inputs on top, typed by people with the source and owner of each; the results below, computed by the server with
 * the verified formula module (exact decimals), each with the "i" of its formula; scenarios in tabs; sensitivity with the tornado and the switching values; the file that carries formulas and inputs to Excel for
 * cross-checking. A draft is edited and computed, then submitted; someone other than its maker approves it and the results are frozen with their hash and the formula version. The AI assistant may explain the
 * results later; it never produces an input. Every state of the design is here: loading, nothing opened, not found, denied, error with retry, stale results, submitting, a version conflict to compare and choose,
 * a receipt after each command, and an approved appraisal that is read-only with the reason.
 */
export default function AppraisalWorkbenchScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <WorkbenchContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function WorkbenchContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { tenant, mode } = useSession();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const id = idFrom(params.get('appraisal'));
  const query = useAppraisal(id);
  const state = useScreenState({ isLoading: query.isLoading, error: query.error, data: query.data, isEmpty: () => false });
  const view = query.data ?? undefined;
  const [draft, setDraft] = useState<Draft | undefined>(undefined);
  const [message, setMessage] = useState<Message | undefined>(undefined);
  const [conflict, setConflict] = useState(false);
  const [deciding, setDeciding] = useState<'approve' | 'return' | undefined>(undefined);
  const update = useUpdateInputs();
  const run = useRunAppraisal();
  const submit = useSubmitAppraisal();
  const approve = useApproveAppraisal();
  const giveBack = useReturnAppraisal();
  const exportFile = useExportAppraisal();
  const create = useCreateAppraisal();
  const writable = mode !== 'READ_ONLY';
  const me = tenant?.membershipId ?? '';
  const busy = update.isPending || run.isPending || submit.isPending || approve.isPending || giveBack.isPending || exportFile.isPending || create.isPending;

  const saved = view === undefined ? undefined : draftOf(view);
  const current = draft ?? saved;
  const dirty = current !== undefined && saved !== undefined && !sameDraft(current, saved);
  const problems = current === undefined ? [] : draftProblems(current);
  const editable = view !== undefined && writable && view.status === 'DRAFT' && view.actions.updateInputs;

  const fail = (error: unknown): void => {
    if (error instanceof ApiError && error.code === 'VERSION_CONFLICT') setConflict(true);
    setMessage({ tone: 'error', text: refusalText(t, error) });
  };
  const receipt = (view: Appraisal, say: (params: { code: string; time: string }) => string): void => setMessage({ tone: 'ok', text: say({ code: view.code, time: new Date().toISOString().slice(11, 16) }) });
  const reload = (): void => {
    setDraft(undefined);
    setConflict(false);
    setMessage(undefined);
    void query.refetch();
  };

  const save = async (appraisal: Appraisal): Promise<number | undefined> => {
    if (current === undefined) return undefined;
    try {
      const done = (await update.mutateAsync({ id: appraisal.id, version: appraisal.version, body: inputsBody(current) })) as { resource_version?: number };
      setDraft(undefined);
      return done.resource_version;
    } catch (error) {
      fail(error);
      return undefined;
    }
  };
  const saveOnly = async (appraisal: Appraisal): Promise<void> => {
    if ((await save(appraisal)) !== undefined) receipt(appraisal, (params) => t('fin1.done.saved', params));
  };
  const compute = async (appraisal: Appraisal): Promise<void> => {
    let version = appraisal.version;
    if (dirty) {
      const next = await save(appraisal);
      if (next === undefined) return;
      version = next;
    }
    try {
      await run.mutateAsync({ id: appraisal.id, version });
      receipt(appraisal, (params) => t('fin1.done.computed', params));
    } catch (error) {
      fail(error);
    }
  };
  const send = (appraisal: Appraisal): void => {
    submit.mutate(
      { id: appraisal.id, version: appraisal.version },
      { onSuccess: () => receipt(appraisal, (params) => t('fin1.done.submitted', params)), onError: fail },
    );
  };
  const download = (appraisal: Appraisal, format: 'CSV' | 'XLSX' | 'DOCX'): void => {
    exportFile.mutate(
      { id: appraisal.id, format },
      {
        onSuccess: (file) => {
          saveFile(file.file_name, file.media_type, file.content_base64);
          setMessage({ tone: 'ok', text: t('fin1.done.exported', { file: file.file_name, hash: file.sha256.slice(0, 12) }) });
        },
        onError: fail,
      },
    );
  };
  const revise = (appraisal: Appraisal): void => {
    create.mutate(
      { body: { title: appraisal.title, kind: appraisal.kind, revise_of: appraisal.id } },
      {
        onSuccess: (done) => {
          if (done.resource_id !== undefined) navigate(workbenchPath(done.resource_id));
        },
        onError: fail,
      },
    );
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('fin1.work.title')}</h1>
          <p>{t('fin1.work.subtitle')}</p>
        </div>
        <div className="actions">
          <Link to={LIST_PATH} className="ui-button ui-button--outline">
            {t('fin1.work.backToList')}
          </Link>
        </div>
      </div>
      <ContextBar
        items={[
          { label: t('fin1.ctx.scope'), value: view === undefined ? (tenant?.name ?? t('fin1.ctx.scope.all')) : `${view.ownerUnit.name} (${view.ownerUnit.code})` },
          ...(view === undefined ? [] : [{ label: t('fin1.ctx.appraisal'), value: `${view.code} · ${t('fin1.ctx.revision', { revision: view.revision })}` }]),
          ...(view === undefined || (view.project === null && view.package === null && view.contract === null) ? [] : [{ label: t('fin1.ctx.link'), value: [view.project?.code, view.package?.code, view.contract?.code].filter((part): part is string => part !== undefined).join(' · ') }]),
        ]}
        unit={t('fin1.unit.vnd')}
        {...(view === undefined ? {} : { asOf: asOfText(view.asOf) })}
      />
      {id === undefined ? (
        <p className="callout" data-testid="no-target">
          {t('fin1.work.noTarget')}
        </p>
      ) : (
        <StateBoundary state={state} onRetry={() => void query.refetch()}>
          {view === undefined || current === undefined ? (
            <p className="callout" data-testid="missing">
              {t('fin1.work.missing')}
            </p>
          ) : (
            <>
              {message === undefined ? null : (
                <p className={message.tone === 'ok' ? 'callout' : 'callout fin1-error'} role={message.tone === 'ok' ? 'status' : 'alert'} data-testid="message">
                  {message.text}
                </p>
              )}
              {conflict ? (
                <div className="callout fin1-warn" role="alert" data-testid="conflict">
                  <p>{t('fin1.conflict.text', { name: view.updatedBy.name ?? '', time: asOfText(view.updatedAt) })}</p>
                  <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={reload} data-testid="conflict-reload">
                    {t('fin1.conflict.reload')}
                  </button>
                  <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => setConflict(false)} data-testid="conflict-keep">
                    {t('fin1.conflict.keep')}
                  </button>
                </div>
              ) : null}

              <SectionCard title={view.title} status={<StatusPill tone={statusTone(view.status)}>{t(`fin1.status.${view.status.toLowerCase()}`)}</StatusPill>}>
                <div data-testid="status-line">
                  <KpiTile label={t('fin1.work.kind')} value={t(`fin1.kind.${view.kind === 'FINANCIAL' ? 'financial' : 'nonFinancial'}`)} sub={t('fin1.work.version', { version: view.version })} />
                </div>
                {view.status === 'APPROVED' ? (
                  <p className="callout" role="status" data-testid="readonly-reason">
                    {t('fin1.work.approvedReadonly', { name: view.approvedBy?.name ?? '', time: asOfText(view.approvedAt) })}
                  </p>
                ) : null}
                {view.status === 'SUBMITTED' ? (
                  <p className="callout" role="status" data-testid="submitted-note">
                    {t('fin1.work.submittedNote', { name: view.submittedBy?.name ?? '' })}
                  </p>
                ) : null}
                {view.status === 'DRAFT' && view.decisionReason !== null ? (
                  <p className="callout fin1-warn" role="status" data-testid="returned-reason">
                    {t('fin1.work.returned', { reason: view.decisionReason })}
                  </p>
                ) : null}
                {view.status === 'DRAFT' && view.missingAssumptions.length > 0 ? (
                  <p className="callout" role="status" data-testid="missing-inputs">
                    {t('fin1.work.missingInputs', { count: view.missingAssumptions.length })}
                  </p>
                ) : null}
                <AuditLine
                  items={[
                    { label: t('fin1.audit.maker'), value: `${view.createdBy.name ?? ''} · ${asOfText(view.createdAt)}` },
                    { label: t('fin1.audit.edited'), value: `${view.updatedBy.name ?? ''} · ${asOfText(view.updatedAt)}` },
                    ...(view.submittedBy === null ? [] : [{ label: t('fin1.audit.submitted'), value: `${view.submittedBy.name ?? ''} · ${asOfText(view.submittedAt)}` }]),
                    ...(view.approvedBy === null ? [] : [{ label: t('fin1.audit.approved'), value: `${view.approvedBy.name ?? ''} · ${asOfText(view.approvedAt)}` }]),
                  ]}
                />
                <MakerCheckerBadge maker={view.createdBy.name ?? view.createdBy.id.slice(0, 8)} checker={view.approvedBy === null ? null : (view.approvedBy.name ?? view.approvedBy.id.slice(0, 8))} />
              </SectionCard>

              <InputsPanel
                appraisal={view}
                draft={current}
                editable={editable && !busy}
                me={me}
                problems={problems}
                onChange={setDraft}
                onAddDefaults={() => setDraft({ ...current, scenarios: [...current.scenarios, ...startScenarios(FIN_DEFAULT_SCENARIOS, current.scenarios.map((scenario) => scenario.code))] })}
              />

              <ResultsPanel appraisal={view} report={view.results?.report ?? null} editingScenarios={current.scenarios.filter((scenario) => scenario.code !== '').map((scenario) => ({ code: scenario.code, label: scenario.label === '' ? scenario.code : scenario.label }))} />

              {writable ? (
                <StickyActions
                  primary={
                    editable ? (
                      <button type="button" className="ui-button ui-button--primary" disabled={busy || problems.length > 0} onClick={() => void compute(view)} data-testid="compute">
                        {run.isPending ? t('fin1.common.sending') : t('fin1.actions.compute')}
                      </button>
                    ) : view.actions.approve ? (
                      <button type="button" className="ui-button ui-button--primary" disabled={busy} onClick={() => setDeciding('approve')} data-testid="approve">
                        {t('fin1.actions.approve')}
                      </button>
                    ) : view.actions.revise ? (
                      <button type="button" className="ui-button ui-button--primary" disabled={busy} onClick={() => revise(view)} data-testid="revise">
                        {create.isPending ? t('fin1.common.sending') : t('fin1.actions.revise')}
                      </button>
                    ) : (
                      <span />
                    )
                  }
                  secondary={[
                    ...(editable
                      ? [
                          <button key="save" type="button" className="ui-button ui-button--outline" disabled={busy || !dirty || problems.length > 0} onClick={() => void saveOnly(view)} data-testid="save">
                            {update.isPending ? t('fin1.common.sending') : t('fin1.actions.save')}
                          </button>,
                        ]
                      : []),
                    ...(view.actions.submit
                      ? [
                          <button key="submit" type="button" className="ui-button ui-button--outline" disabled={busy || dirty || !view.resultsFresh || view.missingAssumptions.length > 0} onClick={() => send(view)} data-testid="submit">
                            {submit.isPending ? t('fin1.common.sending') : t('fin1.actions.submit')}
                          </button>,
                        ]
                      : []),
                    ...(view.actions.return
                      ? [
                          <button key="return" type="button" className="ui-button ui-button--outline" disabled={busy} onClick={() => setDeciding('return')} data-testid="return">
                            {t('fin1.actions.return')}
                          </button>,
                        ]
                      : []),
                    ...(view.actions.export
                      ? [
                          <button key="csv" type="button" className="ui-button ui-button--outline" disabled={busy} onClick={() => download(view, 'CSV')} data-testid="export-csv">
                            {t('fin1.actions.exportCsv')}
                          </button>,
                          <button key="xlsx" type="button" className="ui-button ui-button--outline" disabled={busy} onClick={() => download(view, 'XLSX')} data-testid="export-xlsx">
                            {t('fin1.actions.exportXlsx')}
                          </button>,
                          <button key="docx" type="button" className="ui-button ui-button--outline" disabled={busy} onClick={() => download(view, 'DOCX')} data-testid="export-docx">
                            {t('fin1.actions.exportDocx')}
                          </button>,
                        ]
                      : []),
                  ]}
                />
              ) : null}
              {writable && !editable && view.status === 'DRAFT' ? (
                <p className="muted" data-testid="no-edit-right">
                  {t('fin1.work.noEditRight')}
                </p>
              ) : null}
              {view.actions.export ? <p className="muted">{t('fin1.actions.exportNote')}</p> : null}

              <ConfirmDialog
                open={deciding !== undefined}
                title={deciding === 'return' ? t('fin1.decide.return.title') : t('fin1.decide.approve.title')}
                context={[
                  { label: t('fin1.ctx.appraisal'), value: `${view.code} · ${view.title}` },
                  { label: t('fin1.decide.hash'), value: (view.resultHash ?? '').slice(0, 16) },
                  { label: t('fin1.decide.formula'), value: view.formulaVersion ?? '' },
                ]}
                confirmLabel={deciding === 'return' ? t('fin1.actions.return') : t('fin1.actions.approve')}
                cancelLabel={t('fin1.common.cancel')}
                pending={approve.isPending || giveBack.isPending}
                reason={{ label: t('fin1.decide.reason'), required: deciding === 'return' }}
                onCancel={() => setDeciding(undefined)}
                onConfirm={(reason) => {
                  if (deciding === 'return') {
                    if (reason === undefined || reason.trim() === '') return;
                    giveBack.mutate(
                      { id: view.id, version: view.version, reason: reason.trim() },
                      {
                        onSuccess: () => {
                          setDeciding(undefined);
                          receipt(view, (params) => t('fin1.done.returned', params));
                        },
                        onError: (error) => {
                          setDeciding(undefined);
                          fail(error);
                        },
                      },
                    );
                    return;
                  }
                  approve.mutate(
                    { id: view.id, version: view.version, ...(reason === undefined || reason.trim() === '' ? {} : { reason: reason.trim() }) },
                    {
                      onSuccess: () => {
                        setDeciding(undefined);
                        receipt(view, (params) => t('fin1.done.approved', params));
                      },
                      onError: (error) => {
                        setDeciding(undefined);
                        fail(error);
                      },
                    },
                  );
                }}
              />
            </>
          )}
        </StateBoundary>
      )}
      <p className="prototype-note">{t('fin1.work.footer', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
