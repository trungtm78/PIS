import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { ConfirmDialog, ContextBar, DataTable, SectionCard } from '../../ui';
import type { DataTableColumn } from '../../ui';
import { DemoBadge, Facts, FileList, GridIssues, HashLine, PreviewTable, Signatories, StatePill, refusalText } from './components';
import { useDraft, useDrafts, useFileReader, useStep } from './hooks';
import { saveFile, vietnamDateTime } from './model';
import type { Draft, FileInfo } from './model';
import './rpt.css';

type Action = 'check' | 'approve' | 'issue';

const STEPS: ReadonlyArray<{ action: Action; state: Draft['state']; can: (draft: Draft) => boolean }> = [
  { action: 'check', state: 'DRAFT', can: (draft) => draft.can_check },
  { action: 'approve', state: 'CHECKED', can: (draft) => draft.can_approve },
  { action: 'issue', state: 'APPROVED', can: (draft) => draft.can_issue },
];
const ORDER: readonly Draft['state'][] = ['DRAFT', 'CHECKED', 'APPROVED', 'ISSUED'];

/** The three steps of the flow, each done by someone else: what has been done, what comes now, and the button only for a person who may do it. */
function FlowSteps({ draft, onAct }: { draft: Draft; onAct: (action: Action) => void }) {
  const { t } = useTranslation();
  const reached = ORDER.indexOf(draft.state);
  return (
    <ol className="rpt-flow" data-testid="flow">
      {STEPS.map((step, index) => {
        const done = reached > index;
        const current = reached === index;
        return (
          <li key={step.action} className={done ? 'rpt-flow__step rpt-flow__step--done' : current ? 'rpt-flow__step rpt-flow__step--now' : 'rpt-flow__step'} data-step={step.action} aria-current={current ? 'step' : undefined}>
            <span className="rpt-flow__name">{t(`rpt.draft.step.${step.action}`)}</span>
            <span className="rpt-flow__status">{done ? t('rpt.draft.step.done') : current ? t('rpt.draft.step.now') : t('rpt.draft.step.later')}</span>
            {current && step.can(draft) ? (
              <button type="button" className="ui-button ui-button--primary ui-button--small" data-testid={`act-${step.action}`} onClick={() => onAct(step.action)}>
                {t(`rpt.draft.act.${step.action}`)}
              </button>
            ) : null}
            {current && !step.can(draft) ? <span className="rpt-muted" data-testid={`wait-${step.action}`}>{t(`rpt.draft.wait.${step.action}`)}</span> : null}
          </li>
        );
      })}
    </ol>
  );
}

function DraftDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const { t } = useTranslation();
  const query = useDraft(id);
  const step = useStep();
  const files = useFileReader();
  const [acting, setActing] = useState<Action | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const data = query.data;
  const state = useScreenState({ isLoading: query.isLoading, error: data === undefined ? query.error : undefined, data: data ?? null, isEmpty: () => false });

  const download = (format: FileInfo['format']): void => {
    setBusy(format);
    setNotice(undefined);
    files
      .draftFile(id, format)
      .then((file) => saveFile(file))
      .catch((failure: unknown) => setNotice(refusalText(t, failure)))
      .finally(() => setBusy(null));
  };

  return (
    <SectionCard
      title={data === undefined ? t('rpt.draft.detail.titlePlain') : t('rpt.draft.detail.title', { code: data.layout_code, period: data.period_code })}
      actions={
        <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={onClose}>
          {t('rpt.draft.detail.close')}
        </button>
      }
    >
      <div data-testid="draft-detail">
        <StateBoundary state={state} onRetry={() => void query.refetch()}>
          {data !== undefined && (
            <>
              <DemoBadge mark={data.demo_mark} />
              {data.demo_forms_off ? (
                <p className="callout warning" role="alert" data-testid="demo-off">
                  {t('rpt.draft.demoOff.text')}
                </p>
              ) : null}
              <div className="rpt-state-row">
                <StatePill state={data.state} />
                <span>{t('rpt.draft.detail.version', { version: data.version })}</span>
              </div>
              <Facts
                items={[
                  { label: t('rpt.draft.fact.form'), value: `${data.layout_name} (${data.layout_code} ${data.layout_version})`, testId: 'fact-form' },
                  { label: t('rpt.draft.fact.period'), value: data.period_code, testId: 'fact-period' },
                  { label: t('rpt.draft.fact.source'), value: t(`rpt.common.source.${data.data_source.toLowerCase()}`), testId: 'fact-source' },
                  { label: t('rpt.draft.fact.base'), value: data.base_revision === 0 ? t('rpt.draft.fact.base.none') : t('rpt.draft.fact.base.text', { revision: data.base_revision, next: data.base_revision + 1 }), testId: 'fact-base' },
                  { label: t('rpt.draft.fact.reason'), value: data.reason ?? '–', testId: 'fact-reason' },
                  { label: t('rpt.draft.fact.snapshot'), value: data.snapshot === null ? '–' : t('rpt.draft.fact.snapshot.text', { revision: data.snapshot.revision, cutoff: data.snapshot.cutoff }), testId: 'fact-snapshot' },
                  { label: t('rpt.common.hash.package'), value: <HashLine sha={data.package_sha256} testId="hash-package" />, testId: 'fact-hash' },
                ]}
              />
              <h3>{t('rpt.draft.people.title')}</h3>
              <Signatories draft={data} />
              <h3>{t('rpt.draft.flow.title')}</h3>
              <FlowSteps draft={data} onAct={(action) => { setError(undefined); setActing(action); }} />
              {data.state === 'ISSUED' && data.issue_id !== null ? (
                <p className="callout" role="status" data-testid="issued-link">
                  {t('rpt.draft.issued.text')} <Link to={`/rpt/rpt-03?issue=${data.issue_id}`}>{t('rpt.draft.issued.open')}</Link>
                </p>
              ) : null}
              <h3>{t('rpt.draft.files.title')}</h3>
              {notice === undefined ? null : <p className="callout warning" role="alert">{notice}</p>}
              <FileList files={data.files} onDownload={download} busy={busy} />
              <h3>{t('rpt.draft.issues.title')}</h3>
              <GridIssues issues={data.issues} />
              <h3>{t('rpt.draft.preview.title')}</h3>
              {data.preview === null ? null : <PreviewTable preview={data.preview} />}
              {acting === undefined ? null : (
                <ConfirmDialog
                  open
                  title={t(`rpt.draft.confirm.${acting}.title`)}
                  context={[
                    { label: t('rpt.draft.fact.form'), value: data.layout_code },
                    { label: t('rpt.draft.fact.period'), value: data.period_code },
                  ]}
                  confirmLabel={t(`rpt.draft.act.${acting}`)}
                  cancelLabel={t('rpt.draft.confirm.cancel')}
                  pending={step.isPending}
                  {...(error === undefined ? {} : { error })}
                  onCancel={() => setActing(undefined)}
                  onConfirm={() =>
                    step.mutate(
                      { id, version: data.version, action: acting },
                      { onSuccess: () => setActing(undefined), onError: (failure) => setError(refusalText(t, failure)) },
                    )
                  }
                >
                  <p>{t(`rpt.draft.confirm.${acting}.text`)}</p>
                </ConfirmDialog>
              )}
            </>
          )}
        </StateBoundary>
      </div>
    </SectionCard>
  );
}

/**
 * RPT-02, the drafts of the reports and the flow that issues them (RPT-1 part 2, R17, R18): the list of drafts, and for the chosen one the preview of every cell as the file will show it, the cells the data could not fill
 * and why, the files with their hashes, and the three steps (check, approve, issue) that three different people take in order. The button of a step is shown only to someone who may take it now; the refusals the
 * server can give (a draft that the series has overtaken, a demo form switched off, the same person twice) are said in words.
 */
export default function DraftScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <DraftContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function DraftContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { tenant } = useSession();
  const [params, setParams] = useSearchParams();
  const chosen = params.get('draft') ?? undefined;
  const query = useDrafts(undefined);
  const data = query.data;
  const state = useScreenState({ isLoading: query.isLoading, error: data === undefined ? query.error : undefined, data, isEmpty: (value) => (value as { items: unknown[] }).items.length === 0 });
  const choose = (id: string | undefined): void => setParams(id === undefined ? {} : { draft: id });

  const columns: DataTableColumn<Draft>[] = [
    { key: 'form', header: t('rpt.draft.col.form'), pinned: true, render: (draft) => <strong>{draft.layout_code}</strong> },
    { key: 'period', header: t('rpt.draft.col.period'), render: (draft) => draft.period_code },
    { key: 'state', header: t('rpt.draft.col.state'), render: (draft) => <StatePill state={draft.state} /> },
    { key: 'mark', header: t('rpt.draft.col.mark'), render: (draft) => <DemoBadge mark={draft.demo_mark} /> },
    { key: 'by', header: t('rpt.draft.col.by'), render: (draft) => draft.prepared_by_name ?? '–' },
    { key: 'when', header: t('rpt.draft.col.when'), render: (draft) => vietnamDateTime(draft.created_at) },
    {
      key: 'open',
      header: t('rpt.draft.col.open'),
      render: (draft) => (
        <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid={`open-${draft.id}`} onClick={() => choose(draft.id)}>
          {t('rpt.draft.action.open')}
        </button>
      ),
    },
  ];

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('rpt.draft.page.title')}</h1>
          <p>{t('rpt.draft.page.subtitle')}</p>
        </div>
      </div>
      <ContextBar items={[{ label: t('rpt.draft.context.scope'), value: tenant?.name ?? '–' }]} {...(data === undefined ? {} : { asOf: vietnamDateTime(data.as_of) })} stale={query.isError && data !== undefined} />
      {chosen === undefined ? null : <DraftDetail key={chosen} id={chosen} onClose={() => choose(undefined)} />}
      <StateBoundary state={state} onRetry={() => void query.refetch()}>
        {data !== undefined && (
          <>
            <DataTable caption={t('rpt.draft.table.caption')} columns={columns} rows={data.items as Draft[]} rowKey={(draft) => draft.id} />
            {data.truncated ? <p className="callout" role="status">{t('rpt.common.list.truncated')}</p> : null}
          </>
        )}
      </StateBoundary>
      <p className="prototype-note">{t('rpt.common.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
