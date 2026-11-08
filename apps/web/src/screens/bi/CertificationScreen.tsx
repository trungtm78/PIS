import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { Translator } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { ConfirmDialog, ContextBar, DataTable, FilterPanel, MakerCheckerBadge, SectionCard } from '../../ui';
import type { DataTableColumn } from '../../ui';
import { Field } from '../mne/components';
import '../dis/dis.css';
import { CertPill } from './CertPill';
import { useCertificationLog, useCertifications, useTransitionCertification } from './certification-hooks';
import { certProblemMessage, certStatusLabel, moveEffect, moveLabel } from './certification-labels';
import { CERTIFY_PERMISSION, CERT_STATUSES, CERT_TABS, MOVE_NEEDS_NOTE, MOVE_TARGET, NOTE_MIN, PUBLICATION_PATH, REGISTER_PATH, dayOf, describeCertProblem, legalMoves, needsRecertification, noteProblem } from './certification-model';
import type { Certifiable, CertReason, CertStatus, CertTab, MetricCertification, Move, Person } from './certification-model';
import './bi.css';
import './bi-kit.css';

type T = Translator['t'];
const ALL = '';

interface Receipt {
  code: string;
  status: CertStatus;
  version: number;
}

/**
 * BI-19: the certification of the figures leaders read (G3-1). KPIs and datasets are Draft, Confirmed, Certified or Outdated; one person confirms and another certifies (the person who confirmed does not get "Certify"); sending back
 * and making obsolete need words; the version must be the one in force. The built-in KPIs of the platform are certified by the review of the repository and are not moved here. Metrics keep the certification they already have
 * in their registry (a publication request decided by someone else, BI-11): they are read here, never certified a second time. The leader's dashboard and the command center use only certified figures.
 */
export default function CertificationScreen({ route }: ScreenProps) {
  const tenant = useSession().tenant;
  // What is open belongs to one member of one tenant: a switch starts the screen over.
  return <CertificationContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function CertificationContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode, tenant } = useSession();
  const me = tenant?.membershipId;
  const mayMove = (permissions === undefined || permissions.includes(CERTIFY_PERMISSION)) && mode !== 'READ_ONLY';
  const certifications = useCertifications();
  const transition = useTransitionCertification();
  const [tab, setTab] = useState<CertTab>('KPI');
  const [status, setStatus] = useState<CertStatus | typeof ALL>(ALL);
  const [detail, setDetail] = useState<{ subject: 'KPI' | 'DATASET'; key: string } | undefined>(undefined);
  const [asking, setAsking] = useState<{ row: Certifiable; move: Move } | undefined>(undefined);
  const [short, setShort] = useState(false);
  const [refusal, setRefusal] = useState<{ reason: CertReason; field: string } | undefined>(undefined);
  const [receipt, setReceipt] = useState<Receipt | undefined>(undefined);
  const data = certifications.data;
  // A failed refresh after a good answer keeps the last answer on the screen and says it is old; only a screen that never had an answer is an error.
  const state = useScreenState({ isLoading: certifications.isLoading, error: data === undefined ? certifications.error : undefined, data, isEmpty: () => false });
  const stale = data !== undefined && certifications.isRefetchError;

  const matches = (value: CertStatus): boolean => status === ALL || value === status;
  const kpis: Certifiable[] = (data?.kpis ?? []).filter((row) => matches(row.status));
  const datasets: Certifiable[] = (data?.datasets ?? []).filter((row) => matches(row.status));
  const metrics = (data?.metrics ?? []).filter((row) => matches(row.status));
  const counts: Record<CertTab, number> = { KPI: data?.kpis.length ?? 0, DATASET: data?.datasets.length ?? 0, METRIC: data?.metrics.length ?? 0 };
  const chosen = detail === undefined || data === undefined ? undefined : ([...data.kpis, ...data.datasets] as Certifiable[]).find((row) => row.subject === detail.subject && row.key === detail.key);

  const ask = (row: Certifiable, move: Move): void => {
    transition.reset();
    setRefusal(undefined);
    setReceipt(undefined);
    setShort(false);
    setAsking({ row, move });
  };
  const confirm = (note?: string): void => {
    if (asking === undefined || transition.isPending) return;
    const words = note ?? '';
    if (noteProblem(asking.move, words) !== undefined) {
      setShort(true);
      return;
    }
    const { row, move } = asking;
    transition.mutate(
      { row, move, note: words },
      {
        onSuccess: () => {
          setReceipt({ code: row.code, status: MOVE_TARGET[move], version: row.version });
          setAsking(undefined);
        },
        onError: (error) => {
          setRefusal(describeCertProblem(error));
          setAsking(undefined);
        },
      },
    );
  };

  const columns = certColumns(t, me, mayMove, ask, setDetail);
  const metricColumns = metricCertColumns(t);

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('govc.bi.cert.title')}</h1>
          <p>{t('govc.bi.cert.subtitle')}</p>
        </div>
        <div className="mne-actions">
          <Link className="ui-button ui-button--outline" to={REGISTER_PATH}>
            {t('govc.bi.cert.registerLink')}
          </Link>
        </div>
      </div>
      <ContextBar
        items={[
          { label: t('govc.bi.ctx.scope'), value: tenant?.name ?? t('govc.bi.ctx.scope.all') },
          { label: t('govc.bi.ctx.asOf'), value: data === undefined || data.asOf === '' ? t('govc.bi.ctx.none') : dayOf(data.asOf) },
          { label: t('govc.bi.ctx.count'), value: data === undefined ? t('govc.bi.ctx.none') : String(counts.KPI + counts.DATASET + counts.METRIC) },
        ]}
        stale={stale}
        {...(certifications.dataUpdatedAt > 0 ? { asOf: new Date(certifications.dataUpdatedAt).toLocaleString('vi-VN') } : {})}
      />
      <p className="callout" role="note" data-testid="cert-quality-note">
        {t('govc.bi.cert.qualityNote')}
      </p>
      <StateBoundary state={state} onRetry={() => void certifications.refetch()}>
        {stale ? (
          <div className="callout warning" role="status" data-testid="cert-stale">
            <span>{t('govc.bi.cert.stale', { at: new Date(certifications.dataUpdatedAt).toLocaleString('vi-VN') })}</span>{' '}
            <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => void certifications.refetch()}>
              {t('govc.bi.cert.retry')}
            </button>
          </div>
        ) : null}
        {data !== undefined && data.skipped > 0 ? (
          <p className="callout warning" role="status" data-testid="cert-partial">
            {t('govc.bi.cert.partial', { count: data.skipped })}
          </p>
        ) : null}
        {refusal === undefined ? null : (
          <p className="callout warning" role="alert" data-testid="cert-refusal" data-reason={refusal.reason}>
            {certProblemMessage(t, refusal.reason, refusal.field)}
          </p>
        )}
        {receipt === undefined ? null : (
          <p className="callout" role="status" data-testid="cert-receipt">
            {t('govc.bi.receipt.done', { code: receipt.code, status: certStatusLabel(t, receipt.status), version: receipt.version })}
          </p>
        )}
        <FilterPanel applied={status === ALL ? 0 : 1}>
          <Field id="cert-status" label={t('govc.bi.filter.status')} error={undefined}>
            <select id="cert-status" value={status} onChange={(event) => setStatus(event.target.value as CertStatus | typeof ALL)}>
              <option value={ALL}>{t('govc.bi.filter.all')}</option>
              {CERT_STATUSES.map((option) => (
                <option key={option} value={option}>
                  {certStatusLabel(t, option)}
                </option>
              ))}
            </select>
          </Field>
        </FilterPanel>
        <Tabs t={t} tab={tab} counts={counts} onTab={setTab} />
        <div role="tabpanel" id={`cert-panel-${tab}`} aria-labelledby={`cert-tab-${tab}`}>
          {tab === 'KPI' ? (
            <DataTable
              caption={t('govc.bi.table.kpi.aria')}
              columns={columns}
              rows={kpis}
              rowKey={(row) => row.key}
              rowAttrs={(row) => ({ 'data-key': row.key })}
              emptyKind={status === ALL ? 'none' : 'filtered'}
              onClearFilters={() => setStatus(ALL)}
            />
          ) : null}
          {tab === 'DATASET' ? (
            <DataTable
              caption={t('govc.bi.table.dataset.aria')}
              columns={columns}
              rows={datasets}
              rowKey={(row) => row.key}
              rowAttrs={(row) => ({ 'data-key': row.key })}
              emptyKind={status === ALL ? 'none' : 'filtered'}
              onClearFilters={() => setStatus(ALL)}
            />
          ) : null}
          {tab === 'METRIC' ? (
            <>
              <p className="callout" data-testid="cert-metric-note">
                {t('govc.bi.metric.note')}{' '}
                <Link to={PUBLICATION_PATH}>{t('govc.bi.metric.link')}</Link>
              </p>
              <DataTable
                caption={t('govc.bi.table.metric.aria')}
                columns={metricColumns}
                rows={metrics}
                rowKey={(row) => row.key}
                rowAttrs={(row) => ({ 'data-key': row.key })}
                emptyKind={status === ALL ? 'none' : 'filtered'}
                onClearFilters={() => setStatus(ALL)}
              />
            </>
          ) : null}
        </div>
        {chosen === undefined ? null : <Detail row={chosen} onClose={() => setDetail(undefined)} />}
      </StateBoundary>
      <ConfirmDialog
        open={asking !== undefined}
        title={asking === undefined ? '' : t('govc.bi.dialog.title', { action: moveLabel(t, asking.move), code: asking.row.code })}
        context={
          asking === undefined
            ? []
            : [
                { label: t('govc.bi.dialog.kind'), value: asking.row.subject === 'KPI' ? t('govc.bi.tab.kpi') : t('govc.bi.tab.dataset') },
                { label: t('govc.bi.dialog.code'), value: asking.row.code },
                { label: t('govc.bi.dialog.version'), value: String(asking.row.version) },
                { label: t('govc.bi.dialog.change'), value: t('govc.bi.dialog.fromTo', { from: certStatusLabel(t, asking.row.status), to: certStatusLabel(t, MOVE_TARGET[asking.move]) }) },
                { label: t('govc.bi.dialog.effect'), value: moveEffect(t, asking.move) },
                ...(short ? [{ label: t('govc.bi.dialog.problem'), value: t('govc.bi.dialog.noteShort', { min: NOTE_MIN }) }] : []),
              ]
        }
        confirmLabel={asking === undefined ? '' : moveLabel(t, asking.move)}
        cancelLabel={t('govc.bi.dialog.cancel')}
        onConfirm={confirm}
        onCancel={() => setAsking(undefined)}
        pending={transition.isPending}
        reason={asking === undefined ? undefined : { label: MOVE_NEEDS_NOTE[asking.move] ? t('govc.bi.dialog.reason') : t('govc.bi.dialog.note'), required: MOVE_NEEDS_NOTE[asking.move] }}
      />
    </section>
  );
}

function Tabs({ t, tab, counts, onTab }: { t: T; tab: CertTab; counts: Record<CertTab, number>; onTab: (tab: CertTab) => void }) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const label = (value: CertTab): string => (value === 'KPI' ? t('govc.bi.tab.kpi') : value === 'DATASET' ? t('govc.bi.tab.dataset') : t('govc.bi.tab.metric'));
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const index = CERT_TABS.indexOf(tab);
    const next = event.key === 'ArrowRight' ? (index + 1) % CERT_TABS.length : event.key === 'ArrowLeft' ? (index + CERT_TABS.length - 1) % CERT_TABS.length : event.key === 'Home' ? 0 : event.key === 'End' ? CERT_TABS.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    const target = CERT_TABS[next] as CertTab;
    onTab(target);
    refs.current[target]?.focus();
  };
  return (
    <div role="tablist" aria-label={t('govc.bi.tabs.aria')} className="mne-actions" onKeyDown={onKeyDown}>
      {CERT_TABS.map((value) => (
        <button
          key={value}
          type="button"
          role="tab"
          id={`cert-tab-${value}`}
          aria-selected={tab === value}
          aria-controls={`cert-panel-${value}`}
          tabIndex={tab === value ? 0 : -1}
          ref={(node) => {
            refs.current[value] = node;
          }}
          className={tab === value ? 'ui-button ui-button--primary' : 'ui-button ui-button--outline'}
          onClick={() => onTab(value)}
        >
          {label(value)} ({counts[value]})
        </button>
      ))}
    </div>
  );
}

const person = (value: Person | null, none: string): string => (value === null ? none : value.name);

/** The columns the KPI tab and the dataset tab share: what it is, its version, the state in words, who confirmed, who certified, the day, the note and the moves the row may make. */
function certColumns(t: T, me: string | undefined, mayMove: boolean, ask: (row: Certifiable, move: Move) => void, detail: (key: { subject: 'KPI' | 'DATASET'; key: string }) => void): DataTableColumn<Certifiable>[] {
  const none = t('govc.bi.none');
  return [
    {
      key: 'code',
      header: t('govc.bi.column.code'),
      pinned: true,
      render: (row) => (
        <>
          <strong>{row.code}</strong> <span className="sub">{row.subject === 'KPI' ? row.name : row.title}</span>
        </>
      ),
    },
    { key: 'version', header: t('govc.bi.column.version'), align: 'right', render: (row) => (row.subject === 'KPI' && row.builtIn ? t('govc.bi.version.builtIn') : String(row.version)) },
    {
      key: 'status',
      header: t('govc.bi.column.status'),
      render: (row) => (
        <>
          <CertPill status={row.status} />
          {row.subject === 'KPI' && row.builtIn ? (
            <p className="sub" data-testid="cert-builtin">
              {t('govc.bi.kpi.builtIn')}
            </p>
          ) : null}
          {row.subject === 'KPI' && row.unverified ? (
            <p className="sub" data-testid="cert-unverified">
              {t('govc.bi.kpi.unverified')}
            </p>
          ) : null}
          {row.subject === 'DATASET' && needsRecertification(row) ? (
            <p className="sub" data-testid="cert-recertify">
              {t('govc.bi.dataset.changed', { version: row.lastCertifiedVersion ?? 0 })}
            </p>
          ) : null}
        </>
      ),
    },
    { key: 'confirmedBy', header: t('govc.bi.column.confirmedBy'), render: (row) => person(row.confirmedBy, none) },
    { key: 'certifiedBy', header: t('govc.bi.column.certifiedBy'), render: (row) => person(row.certifiedBy, none) },
    { key: 'at', header: t('govc.bi.column.at'), render: (row) => (row.at === null ? none : dayOf(row.at)) },
    { key: 'note', header: t('govc.bi.column.note'), render: (row) => row.note ?? none },
    {
      key: 'actions',
      header: t('govc.bi.column.actions'),
      render: (row) => {
        const moves = mayMove ? legalMoves(row, me) : [];
        const own = row.status === 'CONFIRMED' && row.confirmedBy !== null && row.confirmedBy.id === me;
        return (
          <div className="mne-actions">
            <button type="button" className="ui-button ui-button--outline ui-button--small" aria-label={t('govc.bi.detail.aria', { code: row.code })} onClick={() => detail({ subject: row.subject, key: row.key })}>
              {t('govc.bi.detail.open')}
            </button>
            {moves.map((move) => (
              <button key={move} type="button" className="ui-button ui-button--outline ui-button--small" data-move={move} aria-label={t('govc.bi.move.aria', { action: moveLabel(t, move), code: row.code })} onClick={() => ask(row, move)}>
                {moveLabel(t, move)}
              </button>
            ))}
            {own && mayMove ? (
              <span className="sub" data-testid="cert-own">
                {t('govc.bi.selfNote')}
              </span>
            ) : null}
          </div>
        );
      },
    },
  ];
}

function metricCertColumns(t: T): DataTableColumn<MetricCertification>[] {
  const none = t('govc.bi.none');
  return [
    { key: 'code', header: t('govc.bi.column.code'), pinned: true, render: (row) => <strong>{row.code}</strong> },
    { key: 'revision', header: t('govc.bi.column.revision'), align: 'right', render: (row) => String(row.revision) },
    { key: 'status', header: t('govc.bi.column.status'), render: (row) => <CertPill status={row.status} /> },
    { key: 'registry', header: t('govc.bi.column.registry'), render: (row) => (row.registryStatus === '' ? none : row.registryStatus) },
    { key: 'origin', header: t('govc.bi.column.origin'), render: (row) => (row.origin === '' ? none : row.origin) },
    { key: 'certifiedBy', header: t('govc.bi.column.certifiedBy'), render: (row) => person(row.certifiedBy, none) },
    { key: 'at', header: t('govc.bi.column.at'), render: (row) => (row.at === null ? none : dayOf(row.at)) },
  ];
}

/** The detail of a row: who moved it, the version, and the append-only log of every move (read when the detail is opened; a failed log read is said, the rest of the screen stays). */
function Detail({ row, onClose }: { row: Certifiable; onClose: () => void }) {
  const { t } = useTranslation();
  const log = useCertificationLog(row.subject, row.key);
  const region = useRef<HTMLDivElement>(null);
  useEffect(() => {
    region.current?.focus();
  }, [row.key]);
  const none = t('govc.bi.none');
  return (
    <SectionCard title={t('govc.bi.detail.title', { code: row.code })} actions={<button type="button" className="ui-button ui-button--outline ui-button--small" onClick={onClose}>{t('govc.bi.detail.close')}</button>}>
      <div data-testid="cert-detail" role="region" aria-label={t('govc.bi.detail.title', { code: row.code })} tabIndex={-1} ref={region}>
        <dl className="mne-lines">
          <div>
            <dt>{t('govc.bi.column.status')}</dt>
            <dd>
              <CertPill status={row.status} />
            </dd>
          </div>
          <div>
            <dt>{t('govc.bi.column.version')}</dt>
            <dd>{String(row.version)}</dd>
          </div>
          <div>
            <dt>{t('govc.bi.column.note')}</dt>
            <dd>{row.note ?? none}</dd>
          </div>
        </dl>
        {row.confirmedBy !== null ? <MakerCheckerBadge maker={row.confirmedBy.name} checker={row.certifiedBy?.name ?? null} /> : null}
        <h4>{t('govc.bi.log.title')}</h4>
        {log.isLoading ? (
          <div role="status" aria-busy="true" aria-label={t('govc.bi.log.loading')}>
            <div className="skeleton" />
          </div>
        ) : log.isError ? (
          <div role="alert" data-testid="cert-log-error">
            <span>{t('govc.bi.log.error')}</span>{' '}
            <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => void log.refetch()}>
              {t('govc.bi.cert.retry')}
            </button>
          </div>
        ) : log.data === undefined || log.data.lines.length === 0 ? (
          <p className="sub" data-testid="cert-log-empty">
            {t('govc.bi.log.empty')}
          </p>
        ) : (
          <>
            {log.data.skipped > 0 ? <p className="sub">{t('govc.bi.cert.partial', { count: log.data.skipped })}</p> : null}
            <div className="tablewrap">
              <table className="table" aria-label={t('govc.bi.log.aria', { code: row.code })} data-testid="cert-log">
                <thead>
                  <tr>
                    <th scope="col">{t('govc.bi.column.version')}</th>
                    <th scope="col">{t('govc.bi.column.status')}</th>
                    <th scope="col">{t('govc.bi.log.actor')}</th>
                    <th scope="col">{t('govc.bi.column.at')}</th>
                    <th scope="col">{t('govc.bi.column.note')}</th>
                  </tr>
                </thead>
                <tbody>
                  {log.data.lines.map((line) => (
                    <tr key={`${line.version}:${line.seq}`}>
                      <td>{line.version}</td>
                      <td>
                        <CertPill status={line.status} />
                      </td>
                      <td>{person(line.actor, none)}</td>
                      <td>{dayOf(line.at)}</td>
                      <td>{line.note ?? none}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </SectionCard>
  );
}
