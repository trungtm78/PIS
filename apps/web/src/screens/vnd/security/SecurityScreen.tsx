import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { DataTable, SectionCard, StatusPill } from '../../../ui';
import { PartialNotice, PolicyInfo, ReadOnlyNote, ReceiptNote, Screen, ScreenFooter, ScreenHead, StaleNotice, UnverifiedPill, useIdParam, useReceipt, useWriter } from '../shared/vnd-ui';
import { camel, dayText, vietnamStamp } from '../shared/vnd-model';
import { ConfirmDialog, DecideForfeitDialog, ProposeForfeitDialog, ReceiveDialog, RejectDialog, ReleaseDialog, WithdrawForfeitDialog } from './security-dialogs';
import { useSecurities, useSecurityDetail } from './security-hooks';
import { PERMISSION, SECURITY_STATES, expiryTone, isUuid, money, securityTone, shortfallOf } from './security-model';
import type { SecurityRow, SecurityStanding } from './security-model';

const NONE = '–';

type Dialog = { kind: 'receive' } | { kind: 'confirm' | 'reject' | 'propose' | 'withdraw' | 'decide' | 'release'; row: SecurityRow };

/**
 * VND-09, the bid security register. A bid security is received by one person, confirmed with the issuer by another, and ends released, expired or forfeited; a forfeiture is proposed by one person and decided by another on a
 * decision paper. The amount the package asks is the base times the factor of the ledger of bid conduct (three times for a contractor with a posted event); both are kept as of the day the security was received. Choosing a
 * package and a contractor shows whether what was lodged meets what is asked. The numbers come from the rule `VENDOR_BID_SECURITY`, which is a starting value nobody confirmed.
 */
export default function SecurityScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  const packageId = useIdParam('package');
  const contractorId = useIdParam('contractor');
  return <SecurityContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} packageId={packageId} contractorId={contractorId} />;
}

function SecurityContent({ route, packageId, contractorId }: ScreenProps & { packageId: string | undefined; contractorId: string | undefined }) {
  const { t } = useTranslation();
  const writer = useWriter();
  const [pack, setPack] = useState(packageId ?? '');
  const [contractor, setContractor] = useState(contractorId ?? '');
  const [state, setState] = useState('');
  const filters = { packageId: isUuid(pack) ? pack.trim() : '', contractorId: isUuid(contractor) ? contractor.trim() : '', state };
  const query = useSecurities(filters);
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  const [ledgerOf, setLedgerOf] = useState<string | undefined>(undefined);
  const receipt = useReceipt();
  const data = query.data;
  const screenState = useScreenState({ isLoading: query.isLoading, error: data === undefined ? query.error : undefined, data, isEmpty: () => false });
  const refreshFailed = query.isError && data !== undefined;
  const done = (what: string): void => {
    setDialog(undefined);
    receipt.show(t('vnd.receipt.done.text', { what, time: vietnamStamp(new Date().toISOString()) }));
  };
  const canWrite = writer.can(PERMISSION.securityWrite);
  const canConfirm = writer.can(PERMISSION.securityConfirm);
  const canPropose = writer.can(PERMISSION.forfeitPropose);
  const filtered = pack !== '' || contractor !== '' || state !== '';

  return (
    <Screen route={route}>
      <ScreenHead
        title={t('vnd.security.page.title')}
        subtitle={t('vnd.security.page.subtitle')}
        asOf={data?.as_of}
        stale={refreshFailed}
        actions={
          canWrite ? (
            <button type="button" className="ui-button ui-button--primary" data-testid="receive-security" onClick={() => setDialog({ kind: 'receive' })}>
              {t('vnd.security.receive.action')}
            </button>
          ) : undefined
        }
      />
      <ReadOnlyNote show={writer.readOnly} />
      <ReceiptNote text={receipt.receipt} />
      {refreshFailed && <StaleNotice onRetry={() => void query.refetch()} />}
      <StateBoundary state={screenState} onRetry={() => void query.refetch()}>
        {data !== undefined && (
          <div className="vnd-page">
            <SectionCard title={t('vnd.security.section.register.title')} status={data.policy.unverified ? <UnverifiedPill /> : undefined}>
              <p className="vnd-note vnd-row" data-testid="security-rule">
                <span>{t('vnd.security.rule.text', { margin: String(data.policy.params.validity_margin_days ?? '–') })}</span>
                <PolicyInfo name={t('vnd.security.figure.rule.name')} policy={data.policy} />
              </p>
              <div className="vnd-filters">
                <label>
                  {t('vnd.security.filter.package.label')}
                  <input type="text" value={pack} onChange={(event) => setPack(event.target.value)} />
                </label>
                <label>
                  {t('vnd.security.filter.contractor.label')}
                  <input type="text" value={contractor} onChange={(event) => setContractor(event.target.value)} />
                </label>
                <label>
                  {t('vnd.security.filter.state.label')}
                  <select value={state} onChange={(event) => setState(event.target.value)}>
                    <option value="">{t('vnd.register.filter.any.option')}</option>
                    {SECURITY_STATES.map((code) => (
                      <option key={code} value={code}>
                        {t(`vnd.security.state.${camel(code)}.name`)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {data.standing !== null && <StandingCard standing={data.standing} policyName={t('vnd.security.figure.standing.name')} policy={data.policy} />}
              <DataTable<SecurityRow>
                caption={t('vnd.security.table.caption')}
                rows={data.items}
                rowKey={(row) => row.id}
                rowAttrs={(row) => ({ 'data-security-id': row.id })}
                state={data.items.length === 0 ? 'empty' : 'ready'}
                emptyKind={filtered ? 'filtered' : 'none'}
                onClearFilters={() => {
                  setPack('');
                  setContractor('');
                  setState('');
                }}
                severity={(row) => (row.expiry_facet === 'EXPIRED' ? 'URGENT' : row.expiry_facet === 'SECOND' ? 'ACTION' : null)}
                columns={[
                  {
                    key: 'contractor',
                    header: t('vnd.security.column.contractor'),
                    pinned: true,
                    render: (row) => (
                      <span className="vnd-stack">
                        <Link to={`/vnd/vnd-02?contractor=${row.contractor_id}`}>{row.contractor_name}</Link>
                        <span className="vnd-days">{t('vnd.security.package.text', { code: row.package_code })}</span>
                      </span>
                    ),
                  },
                  {
                    key: 'letter',
                    header: t('vnd.security.column.letter'),
                    render: (row) => (
                      <span className="vnd-stack">
                        <span>{t(`vnd.security.kind.${camel(row.kind)}.name`)}</span>
                        <span className="vnd-days">{t('vnd.security.letter.text', { issuer: row.issuer, no: row.security_no })}</span>
                      </span>
                    ),
                  },
                  {
                    key: 'amount',
                    header: t('vnd.security.column.amount'),
                    render: (row) => (
                      <span className="vnd-stack" data-testid="security-amount">
                        <span>{money(row.amount)}</span>
                        {row.required_amount !== null && <span className="vnd-days">{t('vnd.security.required.text', { amount: money(row.required_amount), factor: row.factor_applied })}</span>}
                        {shortfallOf(row) > 0 && <StatusPill tone="danger">{t('vnd.security.shortfall.text', { amount: money(shortfallOf(row)) })}</StatusPill>}
                      </span>
                    ),
                  },
                  {
                    key: 'valid',
                    header: t('vnd.security.column.valid'),
                    render: (row) => (
                      <span className="vnd-stack">
                        <span>{dayText(row.valid_until)}</span>
                        {row.expiry_facet !== null && <StatusPill tone={expiryTone(row.expiry_facet)}>{t(`vnd.security.expiry.${camel(row.expiry_facet)}.name`)}</StatusPill>}
                      </span>
                    ),
                  },
                  {
                    key: 'state',
                    header: t('vnd.security.column.state'),
                    render: (row) => (
                      <span className="vnd-stack">
                        <StatusPill tone={securityTone(row.state)}>{t(`vnd.security.state.${camel(row.state)}.name`)}</StatusPill>
                        {row.confirmed_at !== null && <span className="vnd-days">{t('vnd.security.confirmed.text', { reference: row.issuer_reference ?? NONE, time: vietnamStamp(row.confirmed_at) })}</span>}
                        {row.state === 'FORFEITED' && row.conduct_behaviour !== null && <span className="vnd-days">{t('vnd.security.conduct.text', { behaviour: t(`vnd.behaviour.${camel(row.conduct_behaviour)}.name`) })}</span>}
                        {row.state === 'FORFEIT_PROPOSED' && row.forfeit_reason_code !== null && <span className="vnd-days">{t(`vnd.security.reason.${camel(row.forfeit_reason_code)}.name`)}</span>}
                      </span>
                    ),
                  },
                  {
                    key: 'actions',
                    header: t('vnd.security.column.actions'),
                    render: (row) => (
                      <span className="vnd-row">
                        {!writer.readOnly && row.may_confirm && (
                          <>
                            <button type="button" className="ui-button ui-button--primary ui-button--small" data-testid="confirm-security" onClick={() => setDialog({ kind: 'confirm', row })}>
                              {t('vnd.security.confirm.action')}
                            </button>
                            <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid="reject-security" onClick={() => setDialog({ kind: 'reject', row })}>
                              {t('vnd.security.reject.action')}
                            </button>
                          </>
                        )}
                        {!writer.readOnly && canPropose && row.state === 'CONFIRMED' && (
                          <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid="propose-forfeit" onClick={() => setDialog({ kind: 'propose', row })}>
                            {t('vnd.security.propose.action')}
                          </button>
                        )}
                        {!writer.readOnly && canPropose && row.state === 'FORFEIT_PROPOSED' && !row.may_decide_forfeit && (
                          <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid="withdraw-forfeit" onClick={() => setDialog({ kind: 'withdraw', row })}>
                            {t('vnd.security.withdraw.action')}
                          </button>
                        )}
                        {!writer.readOnly && row.may_decide_forfeit && (
                          <button type="button" className="ui-button ui-button--primary ui-button--small" data-testid="decide-forfeit" onClick={() => setDialog({ kind: 'decide', row })}>
                            {t('vnd.security.decide.action')}
                          </button>
                        )}
                        {!writer.readOnly && canWrite && (row.state === 'CONFIRMED' || row.state === 'RECEIVED') && (
                          <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid="release-security" onClick={() => setDialog({ kind: 'release', row })}>
                            {t('vnd.security.release.action')}
                          </button>
                        )}
                        <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid="open-ledger" aria-pressed={ledgerOf === row.id} onClick={() => setLedgerOf(ledgerOf === row.id ? undefined : row.id)}>
                          {t('vnd.security.ledger.action')}
                        </button>
                      </span>
                    ),
                  },
                ]}
              />
              {canConfirm || canPropose || canWrite ? null : <p className="vnd-note">{t('vnd.security.readonly.text')}</p>}
            </SectionCard>
            {ledgerOf !== undefined && <Ledger id={ledgerOf} onClose={() => setLedgerOf(undefined)} />}
          </div>
        )}
      </StateBoundary>
      {dialog?.kind === 'receive' && <ReceiveDialog initialPackage={filters.packageId} initialContractor={filters.contractorId} onClose={() => setDialog(undefined)} onDone={() => done(t('vnd.security.receive.title'))} />}
      {dialog?.kind === 'confirm' && <ConfirmDialog row={dialog.row} onClose={() => setDialog(undefined)} onDone={() => done(t('vnd.security.confirm.title'))} />}
      {dialog?.kind === 'reject' && <RejectDialog row={dialog.row} onClose={() => setDialog(undefined)} onDone={() => done(t('vnd.security.reject.title'))} />}
      {dialog?.kind === 'propose' && <ProposeForfeitDialog row={dialog.row} onClose={() => setDialog(undefined)} onDone={() => done(t('vnd.security.propose.title'))} />}
      {dialog?.kind === 'withdraw' && <WithdrawForfeitDialog row={dialog.row} onClose={() => setDialog(undefined)} onDone={() => done(t('vnd.security.withdraw.title'))} />}
      {dialog?.kind === 'decide' && <DecideForfeitDialog row={dialog.row} onClose={() => setDialog(undefined)} onDone={() => done(t('vnd.security.decide.title'))} />}
      {dialog?.kind === 'release' && <ReleaseDialog row={dialog.row} onClose={() => setDialog(undefined)} onDone={() => done(t('vnd.security.release.title'))} />}
      <ScreenFooter route={route} />
    </Screen>
  );
}

/** What the package asks of the bidder and whether what was lodged meets it: the amount with its factor, the day it must hold until, and the gaps in words. */
function StandingCard({ standing, policyName, policy }: { standing: SecurityStanding; policyName: string; policy: SecurityRowPolicy }) {
  const { t } = useTranslation();
  return (
    <div className="callout" data-testid="security-standing" data-satisfied={standing.satisfied ? 'true' : 'false'}>
      <p className="vnd-row">
        <strong>{t('vnd.security.standing.title')}</strong>
        <PolicyInfo name={policyName} policy={policy} />
        <StatusPill tone={standing.satisfied ? 'success' : standing.enforcement === 'WARN' ? 'warning' : 'danger'}>{standing.satisfied ? t('vnd.security.standing.met.name') : t('vnd.security.standing.notMet.name')}</StatusPill>
      </p>
      <p>{t('vnd.security.standing.required.text', { amount: money(standing.required_amount), factor: standing.factor, until: dayText(standing.must_hold_until) })}</p>
      {standing.factor_until !== null && <p className="vnd-days">{t('vnd.security.standing.factor.text', { until: dayText(standing.factor_until) })}</p>}
      {standing.gaps.length > 0 && (
        <ul className="vnd-list" data-testid="security-gaps">
          {standing.gaps.map((gap) => (
            <li key={gap}>{t(`vnd.security.gap.${camel(gap)}.name`)}</li>
          ))}
          {standing.shortfall > 0 && <li>{t('vnd.security.shortfall.text', { amount: money(standing.shortfall) })}</li>}
        </ul>
      )}
    </div>
  );
}

type SecurityRowPolicy = NonNullable<ReturnType<typeof useSecurities>['data']>['policy'];

/** The ledger of one security: every move with who made it and when; a part that cannot be read is said in place. */
function Ledger({ id, onClose }: { id: string; onClose: () => void }) {
  const { t } = useTranslation();
  const detail = useSecurityDetail(id);
  return (
    <SectionCard title={t('vnd.security.ledger.title')}>
      <p className="vnd-row">
        <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid="close-ledger" onClick={onClose}>
          {t('vnd.security.ledger.close.action')}
        </button>
      </p>
      {detail.isLoading && (
        <p className="vnd-none" role="status" aria-busy="true" data-testid="ledger-loading">
          {t('states.loading.label')}
        </p>
      )}
      {detail.isError && <PartialNotice text={t('vnd.security.ledger.error.text')} onRetry={() => void detail.refetch()} testId="ledger-error" />}
      {detail.data !== undefined && (
        <ol className="vnd-list" data-testid="ledger">
          {detail.data.events.map((event) => (
            <li key={event.id} data-move={event.move}>
              {t('vnd.security.ledger.line.text', { time: vietnamStamp(event.occurred_at), move: t(`vnd.security.move.${camel(event.move)}.name`), from: event.from_state === null ? NONE : t(`vnd.security.state.${camel(event.from_state)}.name`), to: t(`vnd.security.state.${camel(event.to_state)}.name`) })}
              {event.note !== null && <span className="vnd-days"> {event.note}</span>}
            </li>
          ))}
        </ol>
      )}
    </SectionCard>
  );
}
