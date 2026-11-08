import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { ConfirmDialog, ContextBar, DataTable, SectionCard, StatusPill } from '../../ui';
import type { DataTableColumn } from '../../ui';
import { DemoBadge, Facts, FileList, GridIssues, HashLine, Signatories, deliveryLine, refusalText } from './components';
import { useAnswer, useDeliver, useFileReader, useIssue, useIssues } from './hooks';
import { DELIVERY_CHANNELS, REASON_MIN, channelWord, saveFile, vietnamDateTime } from './model';
import type { Delivery, FileInfo, Issue } from './model';
import './rpt.css';

const RECEIVER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,59}$/;

function DeliverDialog({ issue, onClose }: { issue: Issue; onClose: () => void }) {
  const { t } = useTranslation();
  const deliver = useDeliver();
  const [receiver, setReceiver] = useState('');
  const [channel, setChannel] = useState<(typeof DELIVERY_CHANNELS)[number]>('MANUAL');
  const [reference, setReference] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  return (
    <ConfirmDialog
      open
      title={t('rpt.issued.deliver.title', { code: issue.layout_code, period: issue.period_code, revision: issue.revision })}
      context={[{ label: t('rpt.issued.fact.hash'), value: issue.sha256.slice(0, 16) }]}
      confirmLabel={t('rpt.issued.deliver.confirm')}
      cancelLabel={t('rpt.issued.deliver.cancel')}
      pending={deliver.isPending}
      {...(error === undefined ? {} : { error })}
      onCancel={onClose}
      onConfirm={() => {
        if (!RECEIVER.test(receiver)) {
          setError(t('rpt.issued.deliver.receiver.invalid'));
          return;
        }
        deliver.mutate(
          { issueId: issue.id, receiver, channel, reference: reference.trim() === '' ? undefined : reference.trim(), note: undefined },
          { onSuccess: onClose, onError: (failure) => setError(refusalText(t, failure)) },
        );
      }}
    >
      <div className="rpt-period">
        <label>
          {t('rpt.issued.deliver.receiver')}
          <input type="text" maxLength={60} value={receiver} data-testid="deliver-receiver" onChange={(event) => { setError(undefined); setReceiver(event.target.value.trim()); }} />
        </label>
        <label>
          {t('rpt.issued.deliver.channel')}
          <select value={channel} data-testid="deliver-channel" onChange={(event) => setChannel(event.target.value as (typeof DELIVERY_CHANNELS)[number])}>
            {DELIVERY_CHANNELS.map((one) => (
              <option key={one} value={one}>
                {t(`rpt.common.channel.${channelWord(one)}`)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('rpt.issued.deliver.reference')}
          <input type="text" maxLength={200} value={reference} data-testid="deliver-reference" onChange={(event) => setReference(event.target.value)} />
        </label>
      </div>
    </ConfirmDialog>
  );
}

function AnswerDialog({ issue, receiver, outcome, onClose }: { issue: Issue; receiver: string; outcome: 'ACCEPTED' | 'REJECTED'; onClose: () => void }) {
  const { t } = useTranslation();
  const answer = useAnswer();
  const [error, setError] = useState<string | undefined>(undefined);
  return (
    <ConfirmDialog
      open
      title={outcome === 'ACCEPTED' ? t('rpt.issued.answer.accept.title', { receiver }) : t('rpt.issued.answer.reject.title', { receiver })}
      context={[
        { label: t('rpt.issued.deliver.receiver'), value: receiver },
        { label: t('rpt.issued.fact.revision'), value: String(issue.revision) },
      ]}
      confirmLabel={outcome === 'ACCEPTED' ? t('rpt.issued.answer.accept.confirm') : t('rpt.issued.answer.reject.confirm')}
      cancelLabel={t('rpt.issued.deliver.cancel')}
      pending={answer.isPending}
      {...(outcome === 'REJECTED' ? { reason: { label: t('rpt.issued.answer.reject.reason'), required: true, minLength: REASON_MIN, hint: t('rpt.cat.dialog.reason.hint', { min: REASON_MIN }) } } : {})}
      {...(error === undefined ? {} : { error })}
      onCancel={onClose}
      onConfirm={(reason) =>
        answer.mutate({ issueId: issue.id, receiver, outcome, reference: undefined, note: reason?.trim() }, { onSuccess: onClose, onError: (failure) => setError(refusalText(t, failure)) })
      }
    />
  );
}

function IssueDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const { t } = useTranslation();
  const query = useIssue(id);
  const files = useFileReader();
  const [delivering, setDelivering] = useState(false);
  const [answering, setAnswering] = useState<{ receiver: string; outcome: 'ACCEPTED' | 'REJECTED' } | undefined>(undefined);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const data = query.data;
  const state = useScreenState({ isLoading: query.isLoading, error: data === undefined ? query.error : undefined, data: data ?? null, isEmpty: () => false });

  const download = (format: FileInfo['format']): void => {
    setBusy(format);
    setNotice(undefined);
    files
      .issueFile(id, format)
      .then((file) => saveFile(file))
      .catch((failure: unknown) => setNotice(refusalText(t, failure)))
      .finally(() => setBusy(null));
  };

  const answered = (receiver: string, rows: readonly Delivery[]): boolean => rows.some((row) => row.receiver === receiver && row.event !== 'DELIVERED');
  return (
    <SectionCard
      title={data === undefined ? t('rpt.issued.detail.titlePlain') : t('rpt.issued.detail.title', { code: data.layout_code, period: data.period_code, revision: data.revision })}
      actions={
        <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={onClose}>
          {t('rpt.issued.detail.close')}
        </button>
      }
    >
      <div data-testid="issue-detail">
        <StateBoundary state={state} onRetry={() => void query.refetch()}>
          {data !== undefined && (
            <>
              <DemoBadge mark={data.demo_mark} />
              <p className={data.is_current ? 'callout' : 'callout warning'} role="status" data-testid="currency">
                {data.is_current ? t('rpt.issued.current.text') : t('rpt.issued.superseded.text', { revision: data.current_revision })}
              </p>
              <Facts
                items={[
                  { label: t('rpt.issued.fact.form'), value: `${data.layout_name} (${data.layout_code} ${data.layout_version})`, testId: 'fact-form' },
                  { label: t('rpt.issued.fact.period'), value: data.period_code, testId: 'fact-period' },
                  { label: t('rpt.issued.fact.revision'), value: String(data.revision), testId: 'fact-revision' },
                  { label: t('rpt.issued.fact.reason'), value: data.reason ?? '–', testId: 'fact-reason' },
                  { label: t('rpt.issued.fact.snapshot'), value: data.snapshot === null ? '–' : t('rpt.draft.fact.snapshot.text', { revision: data.snapshot.revision, cutoff: data.snapshot.cutoff }), testId: 'fact-snapshot' },
                  { label: t('rpt.issued.fact.issuedAt'), value: vietnamDateTime(data.issued_at), testId: 'fact-issued' },
                  { label: t('rpt.issued.fact.hash'), value: <HashLine sha={data.sha256} testId="hash-package" />, testId: 'fact-hash' },
                ]}
              />
              <h3>{t('rpt.issued.people.title')}</h3>
              <Signatories draft={data} />
              <h3>{t('rpt.issued.files.title')}</h3>
              {notice === undefined ? null : <p className="callout warning" role="alert">{notice}</p>}
              <FileList files={data.files} onDownload={download} busy={busy} />
              <h3>{t('rpt.issued.chain.title')}</h3>
              <ol className="rpt-chain" data-testid="chain">
                {data.chain.map((link) => (
                  <li key={link.id} data-revision={link.revision} aria-current={link.id === data.id ? 'true' : undefined}>
                    <strong>{t('rpt.issued.chain.revision', { revision: link.revision })}</strong> {vietnamDateTime(link.issued_at)} <code>{link.sha256.slice(0, 12)}</code>
                    {link.reason === null ? '' : ` – ${link.reason}`}
                  </li>
                ))}
              </ol>
              <h3>{t('rpt.issued.deliveries.title')}</h3>
              {data.deliveries.length === 0 ? (
                <p className="callout" data-testid="deliveries-empty">{t('rpt.issued.deliveries.empty')}</p>
              ) : (
                <ul className="rpt-deliveries" data-testid="deliveries">
                  {data.deliveries.map((row) => (
                    <li key={row.id} data-event={row.event}>
                      {deliveryLine(t, row)}
                      {row.reference === null ? '' : ` – ${row.reference}`}
                      {row.note === null ? '' : ` – ${row.note}`}
                      {row.event === 'DELIVERED' && !answered(row.receiver, data.deliveries) && data.can_answer ? (
                        <span className="rpt-actions">
                          <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid={`accept-${row.receiver}`} onClick={() => setAnswering({ receiver: row.receiver, outcome: 'ACCEPTED' })}>
                            {t('rpt.issued.answer.accept.action')}
                          </button>
                          <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid={`reject-${row.receiver}`} onClick={() => setAnswering({ receiver: row.receiver, outcome: 'REJECTED' })}>
                            {t('rpt.issued.answer.reject.action')}
                          </button>
                        </span>
                      ) : null}
                      {row.event === 'DELIVERED' && !data.counts_as_accepted ? <span className="rpt-muted" data-testid={`no-accept-${row.receiver}`}> {t('rpt.common.demo.notAccepted')}</span> : null}
                    </li>
                  ))}
                </ul>
              )}
              {data.can_deliver ? (
                <button type="button" className="ui-button ui-button--primary" data-testid="deliver-open" onClick={() => setDelivering(true)}>
                  {t('rpt.issued.deliver.action')}
                </button>
              ) : (
                <p className="rpt-muted" data-testid="deliver-blocked">{data.is_current ? t('rpt.issued.deliver.noRight') : t('rpt.issued.deliver.superseded')}</p>
              )}
              <h3>{t('rpt.issued.issues.title')}</h3>
              <GridIssues issues={data.issues} />
              {delivering ? <DeliverDialog issue={data} onClose={() => setDelivering(false)} /> : null}
              {answering === undefined ? null : <AnswerDialog issue={data} receiver={answering.receiver} outcome={answering.outcome} onClose={() => setAnswering(undefined)} />}
            </>
          )}
        </StateBoundary>
      </div>
    </SectionCard>
  );
}

/**
 * RPT-03, the issued copies of the reports (RPT-1 part 2, R17, R18): the copies by form and period with the whole sha256 of each, whether a later revision replaced it, who prepared, checked, approved and issued it, the chain of
 * revisions with the reasons, the files (checked against their hash when downloaded) and the deliveries to receivers with their answers. A copy made on a DEMO form carries its mark and is never offered for acceptance.
 */
export default function IssuedScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <IssuedContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function IssuedContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { tenant } = useSession();
  const [params, setParams] = useSearchParams();
  const chosen = params.get('issue') ?? undefined;
  const [headsOnly, setHeadsOnly] = useState(true);
  const query = useIssues({ headsOnly, demo: undefined });
  const data = query.data;
  const state = useScreenState({ isLoading: query.isLoading, error: data === undefined ? query.error : undefined, data, isEmpty: (value) => (value as { items: unknown[] }).items.length === 0 });
  const choose = (id: string | undefined): void => setParams(id === undefined ? {} : { issue: id });

  const columns: DataTableColumn<Issue>[] = [
    { key: 'form', header: t('rpt.issued.col.form'), pinned: true, render: (issue) => <strong>{issue.layout_code}</strong> },
    { key: 'period', header: t('rpt.issued.col.period'), render: (issue) => issue.period_code },
    { key: 'revision', header: t('rpt.issued.col.revision'), render: (issue) => issue.revision },
    { key: 'current', header: t('rpt.issued.col.current'), render: (issue) => <StatusPill tone={issue.is_current ? 'success' : 'warning'}>{issue.is_current ? t('rpt.issued.col.current.yes') : t('rpt.issued.col.current.no')}</StatusPill> },
    { key: 'hash', header: t('rpt.issued.col.hash'), render: (issue) => <HashLine sha={issue.sha256} /> },
    { key: 'mark', header: t('rpt.issued.col.mark'), render: (issue) => <DemoBadge mark={issue.demo_mark} /> },
    { key: 'when', header: t('rpt.issued.col.when'), render: (issue) => vietnamDateTime(issue.issued_at) },
    {
      key: 'open',
      header: t('rpt.issued.col.open'),
      render: (issue) => (
        <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid={`open-${issue.id}`} onClick={() => choose(issue.id)}>
          {t('rpt.issued.action.open')}
        </button>
      ),
    },
  ];

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('rpt.issued.page.title')}</h1>
          <p>{t('rpt.issued.page.subtitle')}</p>
        </div>
      </div>
      <ContextBar items={[{ label: t('rpt.issued.context.scope'), value: tenant?.name ?? '–' }]} {...(data === undefined ? {} : { asOf: vietnamDateTime(data.as_of) })} stale={query.isError && data !== undefined} />
      <label className="rpt-filter">
        <input type="checkbox" checked={headsOnly} data-testid="heads-only" onChange={(event) => setHeadsOnly(event.target.checked)} /> {t('rpt.issued.filter.heads')}
      </label>
      {chosen === undefined ? null : <IssueDetail key={chosen} id={chosen} onClose={() => choose(undefined)} />}
      <StateBoundary state={state} onRetry={() => void query.refetch()}>
        {data !== undefined && (
          <>
            <DataTable caption={t('rpt.issued.table.caption')} columns={columns} rows={data.items as Issue[]} rowKey={(issue) => issue.id} />
            {data.truncated ? <p className="callout" role="status">{t('rpt.common.list.truncated')}</p> : null}
          </>
        )}
      </StateBoundary>
      <p className="rpt-muted">
        <Link to="/rpt/rpt-04">{t('rpt.issued.link.log')}</Link>
      </p>
      <p className="prototype-note">{t('rpt.common.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
