import { ApiError } from '@machvon/api-client';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { ContextBar, KpiStrip, KpiTile, SectionCard, StatusPill } from '../../ui';
import { useChangeTier, useClearAdjustment } from './hooks';
import { asOfText, idFrom, vnd } from './model';
import type { ChangeTier } from './model';
import './gov4.css';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const tierTone = (tier: 1 | 2 | 3): 'success' | 'warning' | 'danger' => (tier === 1 ? 'success' : tier === 2 ? 'warning' : 'danger');

/**
 * CTR-27: the tier of a change order and what stands between it and its approval (governance deepening G1-8, CTR-19, CTR-26). The tier comes from the thresholds of the policy of the day (its size and the
 * cumulative variation of the contract against its original price); the authority that decides it is asked for the larger of the change and the cumulative variation; a cumulative variation at the threshold
 * forces a check of the project adjustment, cleared by someone who had no part in the chain, on a document; an increase needs a source, a drawdown of the reserve approved for this change order or a cleared
 * adjustment. The thresholds are configuration with a flagged default, never a rule of the law.
 */
export default function ChangeTierScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <ChangeTierContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ChangeTierContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { tenant, mode } = useSession();
  const [params] = useSearchParams();
  const changeId = idFrom(params.get('change'));
  const tier = useChangeTier(changeId);
  const state = useScreenState({ isLoading: tier.isLoading, error: tier.error, data: tier.data, isEmpty: () => false });
  const money = (value: string | null | undefined): string => vnd(value, locale);
  const view = tier.data ?? undefined;

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('govb2.tier.title')}</h1>
          <p>{t('govb2.tier.subtitle')}</p>
        </div>
      </div>
      <ContextBar items={[{ label: t('govb2.ctx.scope'), value: tenant?.name ?? t('govb2.ctx.scope.all') }, ...(view === undefined || view.code === null ? [] : [{ label: t('govb2.tier.ctx.change'), value: view.code }])]} unit={t('govb2.control.unit')} {...(view === undefined ? {} : { asOf: asOfText(view.asOf) })} />
      {changeId === undefined ? (
        <p className="callout" data-testid="no-target">
          {t('govb2.tier.noTarget')}
        </p>
      ) : (
        <StateBoundary state={state} onRetry={() => void tier.refetch()}>
          {view === undefined ? (
            <p className="callout" data-testid="missing">
              {t('govb2.tier.missing')}
            </p>
          ) : (
            <TierBody view={view} money={money} writable={mode !== 'READ_ONLY'} />
          )}
        </StateBoundary>
      )}
      <p className="prototype-note">{t('govb2.tier.footer', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function TierBody({ view, money, writable }: { view: ChangeTier; money: (value: string | null | undefined) => string; writable: boolean }) {
  const { t } = useTranslation();
  const funding = view.funding;
  const source = view.policy.source === 'DEFAULT' ? t('govb2.policy.default') : t('govb2.policy.rule', { version: view.policy.version ?? 0 });
  return (
    <>
      <KpiStrip label={t('govb2.tier.kpi.label')}>
        <KpiTile label={t('govb2.tier.kpi.tier')} value={t('govb2.tier.kpi.tier.value', { tier: view.tier })} tone={tierTone(view.tier)} sub={t('govb2.tier.kpi.tier.sub')} />
        <KpiTile label={t('govb2.tier.kpi.cumulative')} value={view.cumulativePct === null ? t('govb2.tier.kpi.none') : `${view.cumulativePct}%`} tone={view.forcesAdjustment ? 'danger' : 'default'} sub={t('govb2.tier.kpi.cumulative.sub', { amount: money(view.cumulativeAfterVnd) })} />
        <KpiTile label={t('govb2.tier.kpi.authority')} value={money(view.authorityAmountVnd)} sub={t('govb2.tier.kpi.authority.sub')} />
      </KpiStrip>
      <p className="muted" data-testid="formula">
        {t('govb2.tier.formula', { adjustment: view.policy.projectAdjustmentPct, source })}
      </p>

      <SectionCard title={t('govb2.tier.funding.title')} unit={t('govb2.control.unit')} status={<StatusPill tone={!funding.needsCover || funding.covered ? 'success' : 'danger'}>{!funding.needsCover ? t('govb2.tier.funding.notNeeded') : funding.covered ? t('govb2.tier.funding.covered') : t('govb2.tier.funding.short')}</StatusPill>}>
        <dl className="gov4-facts" data-testid="funding">
          <dt>{t('govb2.tier.funding.source')}</dt>
          <dd>{funding.coveredBy === 'RESERVE' ? t('govb2.tier.funding.source.reserve') : funding.coveredBy === 'PROJECT_ADJUSTMENT' ? t('govb2.tier.funding.source.adjustment') : t('govb2.tier.funding.source.none')}</dd>
          <dt>{t('govb2.tier.funding.drawn')}</dt>
          <dd>{money(funding.approvedDrawdownVnd)}</dd>
          <dt>{t('govb2.tier.funding.balance')}</dt>
          <dd>{funding.contingencyBalanceVnd === null ? t('govb2.tier.kpi.none') : money(funding.contingencyBalanceVnd)}</dd>
          {funding.covered ? null : (
            <>
              <dt>{t('govb2.tier.funding.shortfall')}</dt>
              <dd data-testid="shortfall">{money(funding.shortfallVnd)}</dd>
            </>
          )}
        </dl>
        <p>
          <Link to={`/prj/prj-22?project=${view.projectId}`} data-testid="reserve-link">
            {t('govb2.tier.funding.link')}
          </Link>
        </p>
      </SectionCard>

      <SectionCard title={t('govb2.tier.check.title')} unit={t('govb2.control.unit')} status={view.check === null ? <StatusPill tone="neutral">{t('govb2.tier.check.none')}</StatusPill> : <StatusPill tone={view.check.status === 'CLEARED' ? 'success' : 'danger'}>{view.check.status === 'CLEARED' ? t('govb2.tier.check.cleared') : t('govb2.tier.check.required')}</StatusPill>}>
        {view.check === null ? (
          <p className="muted" data-testid="no-check">
            {view.forcesAdjustment ? t('govb2.tier.check.notRaised') : t('govb2.tier.check.notCalledFor', { pct: view.policy.projectAdjustmentPct })}
          </p>
        ) : (
          <dl className="gov4-facts" data-testid="check">
            <dt>{t('govb2.tier.check.cumulative')}</dt>
            <dd>{`${view.check.cumulativePct}% / ${view.check.thresholdPct}%`}</dd>
            <dt>{t('govb2.tier.check.audit')}</dt>
            <dd>{view.check.auditNotifiedAt === null ? t('govb2.tier.check.audit.no') : asOfText(view.check.auditNotifiedAt)}</dd>
            {view.check.basis === null ? null : (
              <>
                <dt>{t('govb2.tier.check.basis')}</dt>
                <dd>{view.check.basis}</dd>
              </>
            )}
          </dl>
        )}
        {writable && view.actions.clearAdjustment ? <ClearForm view={view} /> : null}
      </SectionCard>
    </>
  );
}

function ClearForm({ view }: { view: ChangeTier }) {
  const { t } = useTranslation();
  const clear = useClearAdjustment();
  const [basis, setBasis] = useState('');
  const [document, setDocument] = useState('');
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | undefined>(undefined);
  const valid = basis.trim() !== '' && UUID.test(document);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!valid) return;
    clear.mutate(
      { changeId: view.changeId, version: view.version, body: { basis: basis.trim(), decision_document_version_id: document.toLowerCase() } },
      {
        onSuccess: () => setMessage({ tone: 'ok', text: t('govb2.tier.clear.done') }),
        onError: (error) => setMessage({ tone: 'error', text: error instanceof ApiError ? t('govb2.tier.clear.refused', { code: error.code }) : t('govb2.tier.clear.failed') }),
      },
    );
  };
  return (
    <form onSubmit={submit} className="gov4-form" aria-label={t('govb2.tier.clear.title')}>
      <h3>{t('govb2.tier.clear.title')}</h3>
      <p className="muted">{t('govb2.tier.clear.rule')}</p>
      {message === undefined ? null : (
        <p className={message.tone === 'ok' ? 'callout' : 'callout gov4-error'} role={message.tone === 'ok' ? 'status' : 'alert'} data-testid="message">
          {message.text}
        </p>
      )}
      <label>
        {t('govb2.tier.clear.basis')}
        <input value={basis} onChange={(event) => setBasis(event.target.value)} data-testid="clear-basis" />
      </label>
      <label>
        {t('govb2.tier.clear.document')}
        <input value={document} onChange={(event) => setDocument(event.target.value.trim())} data-testid="clear-document" aria-invalid={document !== '' && !UUID.test(document)} />
      </label>
      <button type="submit" disabled={!valid || clear.isPending} data-testid="clear-submit">
        {clear.isPending ? t('govb2.common.sending') : t('govb2.tier.clear.submit')}
      </button>
    </form>
  );
}
