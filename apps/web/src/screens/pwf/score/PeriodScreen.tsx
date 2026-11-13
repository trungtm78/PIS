import { useId, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { ConfirmDialog, DataTable, SectionCard } from '../../../ui';
import type { DataTableColumn } from '../../../ui';
import { dayText, stampText } from '../model';
import { FlagList, FlagsNote, PeriodStatusPill, ScoreProblemBanner, SupportNotice } from './components';
import { useComputePeriod, useLockPeriod, useOfficializePeriod, usePeriod, usePeriods, useReloadScores, useScoreCacheGuard, useSignals } from './hooks';
import { scoreFormProblem } from './labels';
import { EMPTY_PERIOD, SCORE_PERMISSIONS, describeScoreProblem, isScoreConflict, mayDo, mayWrite, periodBody, periodLink, rangeText, unitLink, validatePeriod } from './model';
import type { PeriodForm, PeriodPreview, ScorePeriod, ScoreProblem } from './model';
import '../pwf.css';
import './score.css';

/** PWF-14: the period of scoring. A draft is computed for a unit and a policy and can be computed again; locking it takes the snapshot and its hash and opens the window of response; it becomes official when the window has ended or every response was handled. */
export default function PeriodScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <PeriodContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function PeriodContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const [params, setParams] = useSearchParams();
  useScoreCacheGuard();
  const readOnly = mode === 'READ_ONLY';
  const mayRead = mayDo(permissions, SCORE_PERMISSIONS.manage) || mayDo(permissions, SCORE_PERMISSIONS.readUnit) || mayDo(permissions, SCORE_PERMISSIONS.review);
  const canManage = mayWrite(permissions, SCORE_PERMISSIONS.manage, readOnly);
  const periodId = params.get('id');
  const periods = usePeriods({}, mayRead);
  const rows = useMemo(() => (periods.data?.pages ?? []).flatMap((page) => page.items), [periods.data]);
  const period = usePeriod(periodId, mayRead);
  const state = useScreenState({ isLoading: periods.isLoading, error: periods.error, data: periods.data, isEmpty: () => false });
  const screenState = !mayRead ? 'denied' : state;
  const columns: DataTableColumn<ScorePeriod>[] = [
    { key: 'range', header: t('pwfs.period.col.range'), render: (row) => <Link to={periodLink(row.id)}>{rangeText(row.period_from, row.period_to)}</Link> },
    { key: 'status', header: t('pwfs.period.col.status'), render: (row) => <PeriodStatusPill status={row.status} /> },
    { key: 'lines', header: t('pwfs.period.col.lines'), align: 'right', render: (row) => row.line_count },
    { key: 'open', header: t('pwfs.period.col.open'), align: 'right', render: (row) => row.open_response_count },
  ];
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('pwfs.period.title.text')}</h1>
          <p>{t('pwfs.period.subtitle.text')}</p>
        </div>
      </div>
      <SupportNotice />
      <StateBoundary state={screenState} onRetry={() => void periods.refetch()}>
        {canManage ? <ComputeCard onDone={(preview) => setParams({ id: preview.period.id })} /> : null}
        <SectionCard title={t('pwfs.period.list.title')}>
          <DataTable columns={columns} rows={rows} rowKey={(row) => row.id} caption={t('pwfs.period.caption.text')} state={rows.length === 0 ? 'empty' : 'ready'} />
          {periods.hasNextPage ? (
            <button type="button" className="ui-button ui-button--outline ui-button--small" data-action="more-periods" onClick={() => void periods.fetchNextPage()}>
              {t('pwfs.period.more.action')}
            </button>
          ) : null}
        </SectionCard>
        {periodId === null ? null : period.error !== null && period.error !== undefined ? (
          <p className="callout danger" role="alert" data-testid="period-error">
            {t('pwfs.period.notFound.notice')}
          </p>
        ) : period.data === undefined ? null : (
          <Detail period={period.data} canManage={canManage} />
        )}
      </StateBoundary>
      <p className="adm-kit-foot" data-testid="footer">
        {t('gova1.footer.reference', { id: route.id, req: route.req ?? '' })}
      </p>
    </section>
  );
}

function ComputeCard({ onDone }: { onDone: (preview: PeriodPreview) => void }) {
  const { t } = useTranslation();
  const [form, setForm] = useState<PeriodForm>(EMPTY_PERIOD);
  const [attempted, setAttempted] = useState(false);
  const [problem, setProblem] = useState<ScoreProblem | undefined>(undefined);
  const [preview, setPreview] = useState<PeriodPreview | undefined>(undefined);
  const compute = useComputePeriod();
  const problems = validatePeriod(form);
  const set = (patch: Partial<PeriodForm>): void => setForm({ ...form, ...patch });
  const send = async (): Promise<void> => {
    setAttempted(true);
    if (Object.keys(problems).length > 0) return;
    setProblem(undefined);
    try {
      const result = await compute.mutateAsync(periodBody(form));
      setPreview(result);
      onDone(result);
    } catch (error) {
      setProblem(describeScoreProblem(error));
    }
  };
  const field = (name: keyof PeriodForm, label: string, hint?: string): JSX.Element => <PeriodField name={name} label={label} hint={hint} value={form[name]} problem={problems[name]} show={attempted} onChange={(value) => set({ [name]: value })} />;
  return (
    <SectionCard title={t('pwfs.period.compute.title')}>
      <form
        className="pwfs-form"
        data-testid="compute-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <p className="adm-kit-sub">{t('pwfs.period.compute.hint')}</p>
        <div className="pwf-filters">
          {field('unitId', t('pwfs.period.compute.unit.label'))}
          {field('from', t('pwfs.period.compute.from.label'), t('pwfs.period.compute.day.hint'))}
          {field('to', t('pwfs.period.compute.to.label'), t('pwfs.period.compute.day.hint'))}
          {field('policy', t('pwfs.period.compute.policy.label'))}
        </div>
        {problem === undefined ? null : <ScoreProblemBanner problem={problem} />}
        <p className="pwfs-actions">
          <button type="submit" className="ui-button" disabled={compute.isPending} data-action="compute">
            {t('pwfs.period.compute.action')}
          </button>
        </p>
      </form>
      {preview === undefined ? null : <PreviewFacts preview={preview} />}
    </SectionCard>
  );
}

function PeriodField({ name, label, hint, value, problem, show, onChange }: { name: string; label: string; hint?: string | undefined; value: string; problem: Parameters<typeof scoreFormProblem>[1] | undefined; show: boolean; onChange: (value: string) => void }) {
  const { t } = useTranslation();
  const id = useId();
  const invalid = show && problem !== undefined;
  return (
    <div className="pwf-field">
      <label htmlFor={id}>{label}</label>
      <input id={id} type="text" autoComplete="off" value={value} aria-invalid={invalid} aria-describedby={invalid ? `${id}-error` : undefined} data-testid={`field-${name}`} onChange={(event) => onChange(event.target.value)} />
      {hint === undefined ? null : <span className="gova1-hint">{hint}</span>}
      {invalid && problem !== undefined ? (
        <span className="pwf-field__error" id={`${id}-error`} data-testid={`error-${name}`}>
          <span aria-hidden="true">⚠ </span>
          {scoreFormProblem(t, problem)}
        </span>
      ) : null}
    </div>
  );
}

function PreviewFacts({ preview }: { preview: PeriodPreview }) {
  const { t } = useTranslation();
  return (
    <dl className="pwf-facts" data-testid="preview">
      <dt>{t('pwfs.period.preview.rated.label')}</dt>
      <dd>{preview.rated_count}</dd>
      <dt>{t('pwfs.period.preview.small.label')}</dt>
      <dd>{preview.small_sample_count}</dd>
      <dt>{t('pwfs.period.preview.notRated.label')}</dt>
      <dd>{preview.not_rated_count}</dd>
      <dt>{t('pwfs.period.preview.excluded.label')}</dt>
      <dd>{preview.excluded_task_count}</dd>
      <dt>{t('pwfs.period.preview.signals.label')}</dt>
      <dd>{preview.signal_count}</dd>
      <dt>{t('pwfs.period.preview.hash.label')}</dt>
      <dd data-testid="preview-hash">{preview.preview_hash.slice(0, 16)}</dd>
    </dl>
  );
}

type Step = 'lock' | 'officialize' | undefined;

function Detail({ period, canManage }: { period: ScorePeriod; canManage: boolean }) {
  const { t } = useTranslation();
  const { permissions } = useSession();
  const [step, setStep] = useState<Step>(undefined);
  const [problem, setProblem] = useState<ScoreProblem | undefined>(undefined);
  const lock = useLockPeriod();
  const officialize = useOfficializePeriod();
  const recompute = useComputePeriod();
  const reload = useReloadScores();
  const mayReview = mayDo(permissions, SCORE_PERMISSIONS.review);
  const signals = useSignals(period.id, mayReview);
  const signalItems = (signals.data?.pages ?? []).flatMap((page) => page.items);

  const run = async (work: () => Promise<unknown>): Promise<void> => {
    setProblem(undefined);
    try {
      await work();
      setStep(undefined);
    } catch (error) {
      const found = describeScoreProblem(error);
      setProblem(found);
      if (!isScoreConflict(found)) setStep(undefined);
    }
  };
  const context = [
    { label: t('pwfs.period.facts.range.label'), value: rangeText(period.period_from, period.period_to) },
    { label: t('pwfs.period.facts.lines.label'), value: String(period.line_count) },
  ];
  return (
    <>
      <SectionCard title={t('pwfs.period.detail.title', { range: rangeText(period.period_from, period.period_to) })} status={<PeriodStatusPill status={period.status} />}>
        <dl className="pwf-facts" data-testid="period-detail">
          <dt>{t('pwfs.period.facts.policy.label')}</dt>
          <dd>{t('pwfs.period.facts.policy.text', { policy: period.policy_code, version: period.policy_version })}</dd>
          <dt>{t('pwfs.period.facts.hash.label')}</dt>
          <dd data-testid="snapshot-hash">{period.snapshot_hash === null ? t('pwfs.period.facts.noHash.text') : period.snapshot_hash}</dd>
          <dt>{t('pwfs.period.facts.lockedAt.label')}</dt>
          <dd>{stampText(period.locked_at)}</dd>
          <dt>{t('pwfs.period.facts.window.label')}</dt>
          <dd data-testid="window">{period.response_until === null ? '–' : dayText(period.response_until)}</dd>
          <dt>{t('pwfs.period.facts.open.label')}</dt>
          <dd data-testid="open-responses">{period.open_response_count}</dd>
          <dt>{t('pwfs.period.facts.official.label')}</dt>
          <dd>{stampText(period.official_at)}</dd>
          <dt>{t('pwfs.period.facts.lines.label')}</dt>
          <dd>
            {period.line_count} · <Link to={unitLink(period.id)}>{t('pwfs.period.facts.board.link')}</Link>
          </dd>
        </dl>
        {problem === undefined ? null : <ScoreProblemBanner problem={problem} onReload={() => void reload()} />}
        {canManage ? (
          <p className="pwfs-actions">
            {period.status === 'DRAFT' ? (
              <>
                <button
                  type="button"
                  className="ui-button ui-button--outline"
                  disabled={recompute.isPending}
                  data-action="recompute"
                  onClick={() => void run(() => recompute.mutateAsync({ scope_unit_id: period.scope_unit_id, period_from: period.period_from, period_to: period.period_to, policy_code: period.policy_code }))}
                >
                  {t('pwfs.period.recompute.action')}
                </button>
                <button type="button" className="ui-button" data-action="lock" onClick={() => setStep('lock')}>
                  {t('pwfs.period.lock.action')}
                </button>
              </>
            ) : null}
            {period.status === 'LOCKED' ? (
              <button type="button" className="ui-button" data-action="officialize" onClick={() => setStep('officialize')}>
                {t('pwfs.period.officialize.action')}
              </button>
            ) : null}
          </p>
        ) : null}
      </SectionCard>
      <ConfirmDialog
        open={step === 'lock'}
        title={t('pwfs.period.lock.title')}
        context={context}
        confirmLabel={t('pwfs.period.lock.confirm')}
        cancelLabel={t('pwfs.common.cancel.action')}
        pending={lock.isPending}
        onCancel={() => setStep(undefined)}
        onConfirm={() => void run(() => lock.mutateAsync({ id: period.id, version: period.version }))}
      >
        <p>{t('pwfs.period.lock.warning')}</p>
      </ConfirmDialog>
      <ConfirmDialog
        open={step === 'officialize'}
        title={t('pwfs.period.officialize.title')}
        context={context}
        confirmLabel={t('pwfs.period.officialize.confirm')}
        cancelLabel={t('pwfs.common.cancel.action')}
        pending={officialize.isPending}
        onCancel={() => setStep(undefined)}
        onConfirm={() => void run(() => officialize.mutateAsync({ id: period.id, version: period.version }))}
      >
        <p>{t('pwfs.period.officialize.warning')}</p>
      </ConfirmDialog>
      {mayReview ? (
        <SectionCard title={t('pwfs.period.signals.title')}>
          <FlagsNote />
          <StateBoundary state={signals.isLoading ? 'loading' : signals.error === null || signals.error === undefined ? 'default' : 'error'} onRetry={() => void signals.refetch()}>
            {signalItems.length === 0 ? (
              <p className="adm-kit-sub" data-testid="no-signals">
                {t('pwfs.period.signals.none.text')}
              </p>
            ) : (
              <ul className="pwfs-list" data-testid="signals">
                {signalItems.map((item) => (
                  <li key={item.membership_id}>
                    <p>
                      <strong>{item.display_name}</strong>
                    </p>
                    <FlagList flags={item.flags} />
                  </li>
                ))}
              </ul>
            )}
            {signals.hasNextPage ? (
              <button type="button" className="ui-button ui-button--outline" data-action="more-signals" disabled={signals.isFetchingNextPage} onClick={() => void signals.fetchNextPage()}>
                {t('pwfs.period.signals.more.action')}
              </button>
            ) : null}
          </StateBoundary>
        </SectionCard>
      ) : null}
    </>
  );
}
