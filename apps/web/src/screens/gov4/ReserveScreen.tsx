import { ApiError } from '@machvon/api-client';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { ConfirmDialog, ContextBar, DataTable, KpiStrip, KpiTile, MakerCheckerBadge, SectionCard, StatusPill } from '../../ui';
import { useDecideDrawdown, useFundReserve, useProjectReserve, useRequestDrawdown, useSetExposure } from './hooks';
import { asOfText, idFrom, vnd } from './model';
import type { OpenDrawdown, ReserveFund } from './model';
import './gov4.css';

const WHOLE = /^(0|[1-9]\d{0,23})$/;
const PCT = /^(0|[1-9]\d{0,2})(\.\d{1,2})?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const kindName = (t: (key: string) => string, kind: string): string => (kind === 'MGMT_RESERVE' ? t('govb2.reserve.kind.mgmt') : t('govb2.reserve.kind.contingency'));

function refusalText(t: (key: string, params?: Record<string, string | number>) => string, error: unknown): string {
  return error instanceof ApiError ? t('govb2.reserve.error.refused', { code: error.code }) : t('govb2.reserve.error.failed');
}

/**
 * PRJ-22: the contingency and the management reserve of a project (governance deepening G1-7, PRJ F04): two funds that are never mixed, each with its balance and its append-only ledger; the open risks
 * with their probability and cost and the expected value they add up to; the cover of the contingency against that value, with the number of risks that have no exposure yet (the value is a lower bound while
 * there are any). A drawdown is asked for one risk or one change order and decided by someone else; the screen shows who asked and who approved, and the buttons are the commands the caller may give. The
 * management reserve is the level above's and the server draws it only inside a band of the delegation of authority.
 */
export default function ReserveScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <ReserveContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ReserveContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { tenant, mode } = useSession();
  const [params] = useSearchParams();
  const projectId = idFrom(params.get('project'));
  const reserve = useProjectReserve(projectId);
  const state = useScreenState({ isLoading: reserve.isLoading, error: reserve.error, data: reserve.data, isEmpty: () => false });
  const money = (value: string | null | undefined): string => vnd(value, locale);
  const view = reserve.data ?? undefined;
  const writable = mode !== 'READ_ONLY';
  const [decision, setDecision] = useState<{ drawdown: OpenDrawdown; kind: 'approve' | 'reject' } | undefined>(undefined);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | undefined>(undefined);
  const decide = useDecideDrawdown();
  const balanceOf = (kind: string): string | null => view?.funds.find((fund) => fund.kind === kind)?.balanceVnd ?? null;

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('govb2.reserve.title')}</h1>
          <p>{t('govb2.reserve.subtitle')}</p>
        </div>
      </div>
      <ContextBar items={[{ label: t('govb2.ctx.scope'), value: tenant?.name ?? t('govb2.ctx.scope.all') }, ...(view === undefined ? [] : [{ label: t('govb2.reserve.ctx.project'), value: view.projectCode }])]} unit={t('govb2.control.unit')} {...(view === undefined ? {} : { asOf: asOfText(view.asOf) })} />
      {projectId === undefined ? (
        <p className="callout" data-testid="no-target">
          {t('govb2.reserve.noTarget')}
        </p>
      ) : (
        <StateBoundary state={state} onRetry={() => void reserve.refetch()}>
          {view === undefined ? (
            <p className="callout" data-testid="missing">
              {t('govb2.reserve.missing')}
            </p>
          ) : (
            <>
              {message === undefined ? null : (
                <p className={message.tone === 'ok' ? 'callout' : 'callout gov4-error'} role={message.tone === 'ok' ? 'status' : 'alert'} data-testid="message">
                  {message.text}
                </p>
              )}
              <KpiStrip label={t('govb2.reserve.kpi.label')}>
                <KpiTile label={t('govb2.reserve.kpi.contingency')} value={balanceOf('CONTINGENCY') === null ? t('govb2.reserve.kpi.none') : money(balanceOf('CONTINGENCY'))} sub={t('govb2.reserve.kpi.contingency.sub')} />
                <KpiTile label={t('govb2.reserve.kpi.mgmt')} value={balanceOf('MGMT_RESERVE') === null ? t('govb2.reserve.kpi.none') : money(balanceOf('MGMT_RESERVE'))} sub={t('govb2.reserve.kpi.mgmt.sub')} />
                <KpiTile label={t('govb2.reserve.kpi.ev')} value={money(view.expectedValueVnd)} sub={t('govb2.reserve.kpi.ev.sub', { count: view.risks.length })} />
                <KpiTile
                  label={t('govb2.reserve.kpi.cover')}
                  value={view.cover === null ? t('govb2.reserve.kpi.none') : view.cover.coverPct === null ? t('govb2.reserve.cover.norisk') : `${view.cover.coverPct}%`}
                  tone={view.cover === null ? 'default' : view.cover.covered ? 'success' : 'danger'}
                  sub={view.cover === null || view.cover.covered ? undefined : t('govb2.reserve.cover.short', { amount: money(view.cover.shortfallVnd) })}
                />
              </KpiStrip>
              <p className="muted" data-testid="formula">
                {t('govb2.reserve.formula', { pct: view.policy.coverAlertBelowPct, source: view.policy.source === 'DEFAULT' ? t('govb2.policy.default') : t('govb2.policy.rule', { version: view.policy.version ?? 0 }) })}
              </p>
              {view.unassessedRiskCount > 0 ? (
                <p className="callout" role="status" data-testid="unassessed">
                  {t('govb2.reserve.unassessed', { count: view.unassessedRiskCount })}
                </p>
              ) : null}

              {view.funds.length === 0 ? (
                <p className="callout" data-testid="no-funds">
                  {t('govb2.reserve.noFunds')}
                </p>
              ) : null}
              {view.funds.map((fund) => (
                <FundCard key={fund.id} fund={fund} money={money} canDecide={writable && view.actions.decideDrawdown} onDecide={(drawdown, kind) => setDecision({ drawdown, kind })} />
              ))}

              <SectionCard title={t('govb2.reserve.risks.title')} unit={t('govb2.control.unit')}>
                <DataTable
                  caption={t('govb2.reserve.risks.title')}
                  rows={view.risks}
                  rowKey={(row) => row.id}
                  state={view.risks.length === 0 ? 'empty' : 'ready'}
                  columns={[
                    { key: 'code', header: t('govb2.reserve.risks.code'), render: (row) => `${row.code} · ${row.title}` },
                    { key: 'p', header: t('govb2.reserve.risks.probability'), align: 'right', render: (row) => (row.probabilityPct === null ? <StatusPill tone="warning">{t('govb2.reserve.risks.unassessed')}</StatusPill> : `${row.probabilityPct}%`) },
                    { key: 'cost', header: t('govb2.reserve.risks.cost'), align: 'right', render: (row) => (row.costImpactVnd === null ? '' : money(row.costImpactVnd)) },
                    { key: 'ev', header: t('govb2.reserve.risks.ev'), align: 'right', render: (row) => (row.expectedValueVnd === null ? '' : money(row.expectedValueVnd)) },
                  ]}
                />
              </SectionCard>

              {writable && view.actions.setExposure && view.risks.length > 0 ? <ExposureForm risks={view.risks.map((risk) => ({ id: risk.id, label: `${risk.code} · ${risk.title}` }))} onDone={setMessage} /> : null}
              {writable && view.actions.fund ? <FundForm projectId={view.projectId} onDone={setMessage} /> : null}
              {writable && view.actions.requestDrawdown ? <DrawdownForm projectId={view.projectId} risks={view.risks.map((risk) => ({ id: risk.id, label: `${risk.code} · ${risk.title}` }))} onDone={setMessage} /> : null}
              <ConfirmDialog
                open={decision !== undefined}
                title={decision?.kind === 'approve' ? t('govb2.reserve.decide.approve.title') : t('govb2.reserve.decide.reject.title')}
                context={decision === undefined ? [] : [{ label: t('govb2.reserve.decide.amount'), value: money(decision.drawdown.amountVnd) }, { label: t('govb2.reserve.decide.reason'), value: decision.drawdown.reason }]}
                confirmLabel={decision?.kind === 'approve' ? t('govb2.reserve.decide.approve') : t('govb2.reserve.decide.reject')}
                cancelLabel={t('govb2.common.cancel')}
                pending={decide.isPending}
                reason={{ label: t('govb2.reserve.decide.why'), required: true }}
                onCancel={() => setDecision(undefined)}
                onConfirm={(reason) => {
                  if (decision === undefined || reason === undefined || reason.trim() === '') return;
                  decide.mutate(
                    { id: decision.drawdown.id, version: decision.drawdown.version, body: { decision: decision.kind, reason: reason.trim() } },
                    {
                      onSuccess: () => {
                        setDecision(undefined);
                        setMessage({ tone: 'ok', text: t('govb2.reserve.decide.done') });
                      },
                      onError: (error) => {
                        setDecision(undefined);
                        setMessage({ tone: 'error', text: refusalText(t, error) });
                      },
                    },
                  );
                }}
              />
            </>
          )}
        </StateBoundary>
      )}
      <p className="prototype-note">{t('govb2.reserve.footer', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function FundCard({ fund, money, canDecide, onDecide }: { fund: ReserveFund; money: (value: string) => string; canDecide: boolean; onDecide: (drawdown: OpenDrawdown, kind: 'approve' | 'reject') => void }) {
  const { t } = useTranslation();
  return (
    <SectionCard title={kindName(t, fund.kind)} unit={t('govb2.control.unit')} status={<StatusPill tone="neutral">{t('govb2.reserve.fund.balance', { amount: money(fund.balanceVnd) })}</StatusPill>}>
      <div data-fund={fund.kind}>
        {fund.openDrawdowns.length === 0 ? null : (
          <DataTable
            caption={t('govb2.reserve.open.title')}
            rows={fund.openDrawdowns}
            rowKey={(row) => row.id}
            columns={[
              { key: 'amount', header: t('govb2.reserve.ledger.amount'), align: 'right', render: (row) => money(row.amountVnd) },
              { key: 'link', header: t('govb2.reserve.ledger.link'), render: (row) => (row.riskId === null ? t('govb2.reserve.link.change') : t('govb2.reserve.link.risk')) },
              { key: 'why', header: t('govb2.reserve.ledger.reason'), render: (row) => row.reason },
              { key: 'who', header: t('govb2.reserve.ledger.who'), render: (row) => <MakerCheckerBadge maker={row.requestedBy.slice(0, 8)} /> },
              {
                key: 'actions',
                header: t('govb2.reserve.open.actions'),
                render: (row) =>
                  canDecide ? (
                    <span className="gov4-actions">
                      <button type="button" data-action="approve" onClick={() => onDecide(row, 'approve')}>
                        {t('govb2.reserve.decide.approve')}
                      </button>
                      <button type="button" data-action="reject" onClick={() => onDecide(row, 'reject')}>
                        {t('govb2.reserve.decide.reject')}
                      </button>
                    </span>
                  ) : null,
              },
            ]}
          />
        )}
        <DataTable
          caption={t('govb2.reserve.ledger.title', { kind: kindName(t, fund.kind) })}
          rows={fund.entries}
          rowKey={(row) => row.id}
          state={fund.entries.length === 0 ? 'empty' : 'ready'}
          columns={[
            { key: 'at', header: t('govb2.reserve.ledger.at'), render: (row) => asOfText(row.postedAt) },
            { key: 'kind', header: t('govb2.reserve.ledger.kind'), render: (row) => (row.entryKind === 'FUND' ? t('govb2.reserve.entry.fund') : t('govb2.reserve.entry.drawdown')) },
            { key: 'amount', header: t('govb2.reserve.ledger.amount'), align: 'right', render: (row) => (row.entryKind === 'FUND' ? '+' : '-') + money(row.amountVnd) },
            { key: 'after', header: t('govb2.reserve.ledger.after'), align: 'right', render: (row) => money(row.balanceAfterVnd) },
            { key: 'link', header: t('govb2.reserve.ledger.link'), render: (row) => (row.riskId !== null ? t('govb2.reserve.link.risk') : row.changeRequestId !== null ? t('govb2.reserve.link.change') : t('govb2.reserve.link.document')) },
            { key: 'who', header: t('govb2.reserve.ledger.who'), render: (row) => <MakerCheckerBadge maker={row.requestedBy.slice(0, 8)} checker={row.approvedBy === null ? null : row.approvedBy.slice(0, 8)} /> },
          ]}
        />
      </div>
    </SectionCard>
  );
}

type Done = (message: { tone: 'ok' | 'error'; text: string }) => void;

function FundForm({ projectId, onDone }: { projectId: string; onDone: Done }) {
  const { t } = useTranslation();
  const fund = useFundReserve();
  const [kind, setKind] = useState('CONTINGENCY');
  const [amount, setAmount] = useState('');
  const [document, setDocument] = useState('');
  const [reason, setReason] = useState('');
  const valid = WHOLE.test(amount) && amount !== '0' && UUID.test(document) && reason.trim() !== '';
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!valid) return;
    fund.mutate(
      { projectId, body: { kind, amount_vnd: amount, authority_document_version_id: document.toLowerCase(), reason: reason.trim() } },
      {
        onSuccess: () => {
          setAmount('');
          setReason('');
          onDone({ tone: 'ok', text: t('govb2.reserve.fund.done') });
        },
        onError: (error) => onDone({ tone: 'error', text: refusalText(t, error) }),
      },
    );
  };
  return (
    <SectionCard title={t('govb2.reserve.fund.title')} unit={t('govb2.control.unit')}>
      <form onSubmit={submit} className="gov4-form" aria-label={t('govb2.reserve.fund.title')}>
        <label>
          {t('govb2.reserve.form.kind')}
          <select value={kind} onChange={(event) => setKind(event.target.value)} data-testid="fund-kind">
            <option value="CONTINGENCY">{t('govb2.reserve.kind.contingency')}</option>
            <option value="MGMT_RESERVE">{t('govb2.reserve.kind.mgmt')}</option>
          </select>
        </label>
        <label>
          {t('govb2.reserve.form.amount')}
          <input inputMode="numeric" value={amount} onChange={(event) => setAmount(event.target.value.trim())} data-testid="fund-amount" aria-invalid={amount !== '' && !WHOLE.test(amount)} />
        </label>
        <label>
          {t('govb2.reserve.fund.document')}
          <input value={document} onChange={(event) => setDocument(event.target.value.trim())} data-testid="fund-document" aria-invalid={document !== '' && !UUID.test(document)} />
        </label>
        <label>
          {t('govb2.reserve.form.reason')}
          <input value={reason} onChange={(event) => setReason(event.target.value)} data-testid="fund-reason" />
        </label>
        <button type="submit" disabled={!valid || fund.isPending} data-testid="fund-submit">
          {fund.isPending ? t('govb2.common.sending') : t('govb2.reserve.fund.submit')}
        </button>
      </form>
    </SectionCard>
  );
}

function DrawdownForm({ projectId, risks, onDone }: { projectId: string; risks: Array<{ id: string; label: string }>; onDone: Done }) {
  const { t } = useTranslation();
  const request = useRequestDrawdown();
  const [kind, setKind] = useState('CONTINGENCY');
  const [amount, setAmount] = useState('');
  const [riskId, setRiskId] = useState('');
  const [changeId, setChangeId] = useState('');
  const [reason, setReason] = useState('');
  // One risk or one change order, never both and never neither: the server judges it again.
  const linked = (riskId !== '') !== (changeId.trim() !== '') && (changeId.trim() === '' || UUID.test(changeId.trim()));
  const valid = WHOLE.test(amount) && amount !== '0' && linked && reason.trim() !== '';
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!valid) return;
    request.mutate(
      { projectId, body: { kind, amount_vnd: amount, reason: reason.trim(), ...(riskId === '' ? { change_request_id: changeId.trim().toLowerCase() } : { risk_id: riskId }) } },
      {
        onSuccess: () => {
          setAmount('');
          setReason('');
          onDone({ tone: 'ok', text: t('govb2.reserve.draw.done') });
        },
        onError: (error) => onDone({ tone: 'error', text: refusalText(t, error) }),
      },
    );
  };
  return (
    <SectionCard title={t('govb2.reserve.draw.title')} unit={t('govb2.control.unit')}>
      <form onSubmit={submit} className="gov4-form" aria-label={t('govb2.reserve.draw.title')}>
        <label>
          {t('govb2.reserve.form.kind')}
          <select value={kind} onChange={(event) => setKind(event.target.value)} data-testid="draw-kind">
            <option value="CONTINGENCY">{t('govb2.reserve.kind.contingency')}</option>
            <option value="MGMT_RESERVE">{t('govb2.reserve.kind.mgmt')}</option>
          </select>
        </label>
        <label>
          {t('govb2.reserve.form.amount')}
          <input inputMode="numeric" value={amount} onChange={(event) => setAmount(event.target.value.trim())} data-testid="draw-amount" aria-invalid={amount !== '' && !WHOLE.test(amount)} />
        </label>
        <label>
          {t('govb2.reserve.draw.risk')}
          <select value={riskId} onChange={(event) => setRiskId(event.target.value)} data-testid="draw-risk">
            <option value="">{t('govb2.reserve.draw.noRisk')}</option>
            {risks.map((risk) => (
              <option key={risk.id} value={risk.id}>
                {risk.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('govb2.reserve.draw.change')}
          <input value={changeId} onChange={(event) => setChangeId(event.target.value)} data-testid="draw-change" aria-invalid={changeId.trim() !== '' && !UUID.test(changeId.trim())} />
        </label>
        <label>
          {t('govb2.reserve.form.reason')}
          <input value={reason} onChange={(event) => setReason(event.target.value)} data-testid="draw-reason" />
        </label>
        <p className="muted">{t('govb2.reserve.draw.rule')}</p>
        <button type="submit" disabled={!valid || request.isPending} data-testid="draw-submit">
          {request.isPending ? t('govb2.common.sending') : t('govb2.reserve.draw.submit')}
        </button>
      </form>
    </SectionCard>
  );
}

function ExposureForm({ risks, onDone }: { risks: Array<{ id: string; label: string }>; onDone: Done }) {
  const { t } = useTranslation();
  const set = useSetExposure();
  const [riskId, setRiskId] = useState(risks[0]?.id ?? '');
  const [probability, setProbability] = useState('');
  const [cost, setCost] = useState('');
  const valid = riskId !== '' && PCT.test(probability) && Number(probability) <= 100 && WHOLE.test(cost);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!valid) return;
    set.mutate(
      { riskId, body: { probability_pct: probability, cost_impact_vnd: cost } },
      {
        onSuccess: () => {
          setProbability('');
          setCost('');
          onDone({ tone: 'ok', text: t('govb2.reserve.exposure.done') });
        },
        onError: (error) => onDone({ tone: 'error', text: refusalText(t, error) }),
      },
    );
  };
  return (
    <SectionCard title={t('govb2.reserve.exposure.title')} unit={t('govb2.control.unit')}>
      <form onSubmit={submit} className="gov4-form" aria-label={t('govb2.reserve.exposure.title')}>
        <label>
          {t('govb2.reserve.exposure.risk')}
          <select value={riskId} onChange={(event) => setRiskId(event.target.value)} data-testid="exposure-risk">
            {risks.map((risk) => (
              <option key={risk.id} value={risk.id}>
                {risk.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('govb2.reserve.risks.probability')}
          <input inputMode="decimal" value={probability} onChange={(event) => setProbability(event.target.value.trim())} data-testid="exposure-probability" aria-invalid={probability !== '' && !PCT.test(probability)} />
        </label>
        <label>
          {t('govb2.reserve.risks.cost')}
          <input inputMode="numeric" value={cost} onChange={(event) => setCost(event.target.value.trim())} data-testid="exposure-cost" aria-invalid={cost !== '' && !WHOLE.test(cost)} />
        </label>
        <button type="submit" disabled={!valid || set.isPending} data-testid="exposure-submit">
          {set.isPending ? t('govb2.common.sending') : t('govb2.reserve.exposure.submit')}
        </button>
      </form>
    </SectionCard>
  );
}
