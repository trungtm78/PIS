import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { DataTable, SectionCard, StatusPill } from '../../../ui';
import type { DataTableColumn, Tone } from '../../../ui';
import { StatusBadge } from '../components';
import { ScopeBar } from '../kit';
import { useContract } from '../hooks';
import type { ContractView } from '../model';
import { useMeasurements } from '../measurement/hooks';
import { quantityText } from '../measurement/model';
import type { Measurement } from '../measurement/model';
import { DecideDialog, DraftDialog, RevokeDialog, SubmitDialog } from './AcceptanceDialogs';
import { useAcceptances } from './hooks';
import { statusLabel } from './labels';
import { acceptable, canCreate, remainingVnd, signedAmountText } from './model';
import type { Acceptance } from './model';
import '../ctr.css';

/** The tone of an acceptance: approved is green, refused or withdrawn is amber, waiting for a decision is blue and a draft is neutral. */
function acceptanceTone(status: Acceptance['status']): Tone {
  return status === 'APPROVED' ? 'success' : status === 'REJECTED' || status === 'REVOKED' ? 'warning' : status === 'SUBMITTED' ? 'info' : 'neutral';
}

/** The multiplication sign (U+00D7) between a quantity and its unit price. */
const TIMES = '\u00d7';

/**
 * CTR-12: accept the work done under a contract (ST-CTR-009, CTR 3.4, BR-CTR-05). Approved measurements of a period are drawn up as an acceptance whose lines keep the price of the
 * revision in force on the day; it is sent with the people who sign the paper and decided by someone other than whoever drafted or sent it. Approving needs, where the contract asks for them,
 * approved quality acceptance minutes and no open serious non-conformance on the work, and room in the value of the contract. An approved acceptance is told to payment; it is withdrawn with a
 * reason until a payment request holds it. The server judges every command again.
 */
export default function AcceptanceScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The acceptances and the dialogs belong to one membership: a switch of tenant or of membership starts the screen over.
  return <AcceptanceContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

type Dialog = { kind: 'draft' } | { kind: 'submit' | 'decide' | 'revoke'; id: string };

function AcceptanceContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const [search] = useSearchParams();
  const contractId = search.get('contract');
  const contract = useContract(contractId);
  const acceptances = useAcceptances(contractId);
  // Whoever may read the acceptances and not the measurements still reads the acceptances: only the drafting is missing.
  const measurements = useMeasurements(contractId);
  const state = useScreenState({
    isLoading: contract.isLoading || acceptances.isLoading,
    error: contract.error ?? acceptances.error,
    data: contractId === null ? null : contract.data === undefined || acceptances.data === undefined ? undefined : contract.data,
    isEmpty: (data) => data === null,
  });
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('ctr.acceptance.title')}</h1>
          <p>{t('ctr.acceptance.subtitle')}</p>
        </div>
      </div>
      {contractId === null ? (
        <p className="callout" role="status" data-testid="no-contract">
          {t('ctr.acceptance.none.notice')}
        </p>
      ) : (
        <StateBoundary
          state={state}
          onRetry={() => {
            void contract.refetch();
            void acceptances.refetch();
          }}
        >
          {contract.data === null || contract.data === undefined ? null : <Acceptances contract={contract.data} acceptances={acceptances.data ?? []} measurements={measurements.data} />}
        </StateBoundary>
      )}
      <p className="prototype-note">{t('ctr.acceptance.footer', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

interface AcceptancesProps {
  contract: ContractView;
  acceptances: readonly Acceptance[];
  /** The measurements of the contract; undefined when the caller may not read them. */
  measurements: readonly Measurement[] | undefined;
}

function Acceptances({ contract, acceptances, measurements }: AcceptancesProps) {
  const { t, locale } = useTranslation();
  const { permissions, mode } = useSession();
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  const [done, setDone] = useState<string | undefined>(undefined);
  const candidates = useMemo(() => (measurements === undefined ? [] : acceptable(measurements, acceptances)), [measurements, acceptances]);
  const mayDraft = canCreate(permissions, mode) && contract.status === 'ACTIVE' && candidates.length > 0;
  const close = (): void => setDialog(undefined);
  const finished = (message: string) => (): void => {
    setDone(message);
    close();
  };
  const subject = dialog === undefined || dialog.kind === 'draft' ? undefined : acceptances.find((acceptance) => acceptance.id === dialog.id);
  const money = (amount: string): string => signedAmountText(amount, locale) ?? amount;
  const first = acceptances[0];
  const accepted = first?.contract.acceptedTotalVnd ?? '0';

  const columns: DataTableColumn<Acceptance>[] = [
    {
      key: 'no',
      header: t('ctr.acceptance.column.no'),
      pinned: true,
      render: (acceptance) => (
        <span data-testid="no" data-acceptance={acceptance.id} data-status={acceptance.status}>
          {acceptance.acceptanceNo}
        </span>
      ),
    },
    { key: 'period', header: t('ctr.acceptance.column.period'), render: (acceptance) => <span data-testid="period">{acceptance.period.code}</span> },
    {
      key: 'lines',
      header: t('ctr.acceptance.column.lines'),
      render: (acceptance) => (
        <ul className="ctr-lines" data-testid="lines">
          {acceptance.lines.map((line) => (
            <li key={line.id} data-line={line.id}>
              <strong>{line.businessKey}</strong> · {quantityText(line.quantity, locale)} {line.unitCode} {TIMES} {quantityText(line.unitPrice, locale)} = {money(line.amountVnd)}
            </li>
          ))}
        </ul>
      ),
    },
    { key: 'amount', header: t('ctr.acceptance.column.amount'), align: 'right', render: (acceptance) => <span data-testid="amount">{money(acceptance.amountVnd)}</span> },
    {
      key: 'quality',
      header: t('ctr.acceptance.column.quality'),
      render: (acceptance) => (
        <>
          {acceptance.quality === null ? (
            <span className="sub" data-testid="quality">
              {contract.requiresQualityAcceptance ? t('ctr.acceptance.quality.missing') : t('ctr.acceptance.quality.notAsked')}
            </span>
          ) : (
            <span data-testid="quality">{t('ctr.acceptance.quality.linked', { record: acceptance.quality.recordNo, status: acceptance.quality.status })}</span>
          )}
          {acceptance.openCriticalNcr > 0 && (acceptance.status === 'DRAFT' || acceptance.status === 'SUBMITTED') ? (
            <>
              {' '}
              <span data-testid="ncr-open" role="status">
                <StatusPill tone="warning">{t('ctr.acceptance.ncr.open', { count: acceptance.openCriticalNcr })}</StatusPill>
              </span>
            </>
          ) : null}
        </>
      ),
    },
    {
      key: 'status',
      header: t('ctr.acceptance.column.status'),
      render: (acceptance) => (
        <>
          <span data-testid="status">
            <StatusPill tone={acceptanceTone(acceptance.status)}>{statusLabel(t, acceptance.status)}</StatusPill>
          </span>
          {acceptance.decisionReason === null ? null : (
            <small className="sub" data-testid="decision-reason">
              {acceptance.decisionReason}
            </small>
          )}
          {acceptance.revokeReason === null ? null : (
            <small className="sub" data-testid="revoke-reason">
              {t('ctr.acceptance.revoked.reason', { reason: acceptance.revokeReason })}
            </small>
          )}
        </>
      ),
    },
    {
      key: 'actions',
      header: t('ctr.acceptance.column.actions'),
      render: (acceptance) =>
        mode === 'READ_ONLY' ? null : (
          <div className="ctr-row-actions">
            {acceptance.canSubmit ? (
              <button type="button" className="ui-button ui-button--outline ui-button--small" data-submit={acceptance.id} onClick={() => setDialog({ kind: 'submit', id: acceptance.id })}>
                {t('ctr.acceptance.submit.action')}
              </button>
            ) : null}
            {acceptance.canDecide ? (
              <button type="button" className="ui-button ui-button--primary ui-button--small" data-decide={acceptance.id} onClick={() => setDialog({ kind: 'decide', id: acceptance.id })}>
                {t('ctr.acceptance.decide.action')}
              </button>
            ) : null}
            {acceptance.canRevoke ? (
              <button type="button" className="ui-button ui-button--outline ui-button--small" data-revoke={acceptance.id} onClick={() => setDialog({ kind: 'revoke', id: acceptance.id })}>
                {t('ctr.acceptance.revoke.action')}
              </button>
            ) : null}
          </div>
        ),
    },
  ];

  return (
    <>
      <ScopeBar money extra={[{ label: t('w2pay.ctr.ctx.contract'), value: contract.code }]} />
      <SectionCard
        title={t('ctr.acceptance.contract.title')}
        unit={t('w2pay.ctx.unit')}
        status={<StatusBadge status={contract.status} />}
        actions={
          mayDraft ? (
            <button type="button" className="ui-button ui-button--primary" onClick={() => setDialog({ kind: 'draft' })}>
              {t('ctr.acceptance.draft.action')}
            </button>
          ) : undefined
        }
      >
        <p>
          <strong data-testid="contract-code">{contract.code}</strong>
        </p>
        <dl className="ctr-facts">
          <dt>{t('ctr.acceptance.contract.value')}</dt>
          <dd data-testid="contract-value">{money(contract.contractValueVnd)}</dd>
          <dt>{t('ctr.acceptance.contract.accepted')}</dt>
          <dd data-testid="contract-accepted">{money(accepted)}</dd>
          <dt>{t('ctr.acceptance.contract.remaining')}</dt>
          <dd data-testid="contract-remaining">{money(remainingVnd({ contractValueVnd: contract.contractValueVnd, acceptedTotalVnd: accepted }))}</dd>
        </dl>
        {contract.requiresQualityAcceptance ? (
          <p className="sub" data-testid="quality-required">
            {t('ctr.acceptance.contract.qualityRequired')}
          </p>
        ) : null}
      </SectionCard>
      {done === undefined ? null : (
        <p className="callout" role="status" data-testid="done">
          {done}
        </p>
      )}
      <SectionCard title={t('ctr.acceptance.list.title')} unit={t('w2pay.ctx.unit')}>
        {acceptances.length === 0 ? (
          <p className="sub" data-testid="no-acceptances">
            {t('ctr.acceptance.list.empty')}
          </p>
        ) : (
          <div data-testid="acceptances">
            <DataTable caption={t('ctr.acceptance.list.title')} columns={columns} rows={[...acceptances]} rowKey={(acceptance) => acceptance.id} />
          </div>
        )}
      </SectionCard>
      {dialog?.kind === 'draft' ? <DraftDialog contractId={contract.id} measurements={candidates} onDone={finished(t('ctr.acceptance.done.drafted'))} onClose={close} /> : null}
      {dialog?.kind === 'submit' && subject !== undefined ? <SubmitDialog acceptance={subject} onDone={finished(t('ctr.acceptance.done.submitted'))} onClose={close} /> : null}
      {dialog?.kind === 'decide' && subject !== undefined ? <DecideDialog acceptance={subject} onDone={finished(t('ctr.acceptance.done.decided'))} onClose={close} /> : null}
      {dialog?.kind === 'revoke' && subject !== undefined ? <RevokeDialog acceptance={subject} onDone={finished(t('ctr.acceptance.done.revoked'))} onClose={close} /> : null}
    </>
  );
}
