import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { useRetentionHolds, useRetentionPolicies, useRetentionReview } from '../../adm/retention/hooks';
import { basisLabel, endActionLabel, holdKindLabel, holdScopeLabel } from '../../adm/retention/labels';
import { useRetentionRules } from '../../doc/archive/hooks';
import { classLabel, ruleSetLabel, ruleStatusLabel, startBasisLabel } from '../../doc/archive/labels';
import { Frame, Gate } from './components';
import { DOC_RETENTION_PATH, DOC_RULE_READ_PERMISSION, HOLD_READ_PERMISSION, RETENTION_POLICY_PATH, RETENTION_READ_PERMISSION, activeHolds, inForce, waitingByClass } from './model';

/**
 * DGV-11: retention and legal hold (ST-DGV-010, NFR-RETENTION-01 and 02): for each kind of data, how long it is kept and from when, what happens at the end and how many records are waiting for that decision; the legal holds
 * that stop a deletion; and the retention rules of documents. The rules and the holds are ADM's and DOC's and are only read here: they are set in ADM-12 and DOC-18, and a hold is placed and released in ADM.
 */
export default function RetentionScreen({ route }: ScreenProps) {
  const { t } = useTranslation();
  const tenant = useSession().tenant;
  // What is shown belongs to one member of one tenant: a switch starts the screen over.
  return (
    <Frame key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} title={t('dgv.governance.ret.page.title')} subtitle={t('dgv.governance.ret.page.subtitle')}>
      <Gate permission={RETENTION_READ_PERMISSION} name="policies">
        <Policies />
      </Gate>
      <Gate permission={HOLD_READ_PERMISSION} name="holds">
        <Holds />
      </Gate>
      <Gate permission={DOC_RULE_READ_PERMISSION} name="rules">
        <DocumentRules />
      </Gate>
    </Frame>
  );
}

function Policies() {
  const { t } = useTranslation();
  const policies = useRetentionPolicies();
  const review = useRetentionReview();
  const state = useScreenState({
    isLoading: policies.isLoading || review.isLoading,
    error: policies.error ?? review.error,
    data: policies.data === undefined || review.data === undefined ? undefined : inForce(policies.data),
  });
  const waiting = waitingByClass(review.data ?? []);
  return (
    <section aria-labelledby="policies-title" data-testid="retention-policies">
      <h2 id="policies-title">{t('dgv.governance.ret.policies.title')}</h2>
      <StateBoundary
        state={state}
        onRetry={() => {
          void policies.refetch();
          void review.refetch();
        }}
      >
        <div className="tablewrap">
          <table className="table" aria-label={t('dgv.governance.ret.policies.aria')}>
            <thead>
              <tr>
                <th scope="col">{t('dgv.governance.ret.column.class')}</th>
                <th scope="col">{t('dgv.governance.ret.column.retention')}</th>
                <th scope="col">{t('dgv.governance.ret.column.end')}</th>
                <th scope="col">{t('dgv.governance.ret.column.waiting')}</th>
              </tr>
            </thead>
            <tbody>
              {inForce(policies.data ?? []).map((policy) => {
                const pending = waiting.get(policy.recordClass);
                return (
                  <tr key={policy.id} data-record-class={policy.recordClass}>
                    <td>
                      <code>{policy.recordClass}</code> <span className="sub">#{policy.revision}</span>
                    </td>
                    <td>
                      {policy.retentionYears === null
                        ? basisLabel(t, policy.retentionBasis)
                        : t('dgv.governance.ret.years.text', { years: policy.retentionYears, basis: basisLabel(t, policy.retentionBasis) })}
                    </td>
                    <td>{endActionLabel(t, policy.endAction)}</td>
                    <td data-testid="retention-waiting">{pending === undefined ? '—' : t('dgv.governance.ret.waiting.text', { count: pending.count, day: pending.earliestDue })}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="sub">
          <Link to={RETENTION_POLICY_PATH}>{t('dgv.governance.ret.policies.link')}</Link>
        </p>
      </StateBoundary>
    </section>
  );
}

function Holds() {
  const { t } = useTranslation();
  const holdings = useRetentionHolds();
  const state = useScreenState({ isLoading: holdings.isLoading, error: holdings.error, data: holdings.data === undefined ? undefined : activeHolds(holdings.data), isEmpty: () => false });
  const active = activeHolds(holdings.data ?? []);
  return (
    <section aria-labelledby="holds-title" data-testid="retention-holds">
      <h2 id="holds-title">{t('dgv.governance.ret.holds.title')}</h2>
      <StateBoundary state={state} onRetry={() => void holdings.refetch()}>
        <p className="sub" data-testid="holds-summary">
          {t('dgv.governance.ret.holds.summary', { count: active.length })}
        </p>
        {active.length === 0 ? null : (
          <div className="tablewrap">
            <table className="table" aria-label={t('dgv.governance.ret.holds.aria')}>
              <thead>
                <tr>
                  <th scope="col">{t('dgv.governance.ret.holds.kind')}</th>
                  <th scope="col">{t('dgv.governance.ret.holds.scope')}</th>
                  <th scope="col">{t('dgv.governance.ret.holds.authority')}</th>
                  <th scope="col">{t('dgv.governance.ret.holds.since')}</th>
                </tr>
              </thead>
              <tbody>
                {active.map((hold) => (
                  <tr key={hold.id} data-hold-id={hold.id}>
                    <td>{holdKindLabel(t, hold.holdKind)}</td>
                    <td>{hold.scopeCount === 0 ? holdScopeLabel(t, hold.scopeKind) : t('dgv.governance.ret.holds.scoped', { scope: holdScopeLabel(t, hold.scopeKind), count: hold.scopeCount })}</td>
                    <td>{hold.authorityReference}</td>
                    <td>{hold.effectiveAt.slice(0, 10)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </StateBoundary>
    </section>
  );
}

function DocumentRules() {
  const { t } = useTranslation();
  const rules = useRetentionRules(true);
  const published = (rules.data ?? []).filter((rule) => rule.status === 'PUBLISHED');
  const state = useScreenState({ isLoading: rules.isLoading, error: rules.error, data: rules.data === undefined ? undefined : published });
  return (
    <section aria-labelledby="doc-rules-title" data-testid="retention-doc-rules">
      <h2 id="doc-rules-title">{t('dgv.governance.ret.docs.title')}</h2>
      <StateBoundary state={state} onRetry={() => void rules.refetch()}>
        <div className="tablewrap">
          <table className="table" aria-label={t('dgv.governance.ret.docs.aria')}>
            <thead>
              <tr>
                <th scope="col">{t('dgv.governance.ret.docs.category')}</th>
                <th scope="col">{t('dgv.governance.ret.docs.class')}</th>
                <th scope="col">{t('dgv.governance.ret.docs.basis')}</th>
                <th scope="col">{t('dgv.governance.ret.docs.set')}</th>
                <th scope="col">{t('dgv.governance.ret.docs.status')}</th>
              </tr>
            </thead>
            <tbody>
              {published.map((rule) => (
                <tr key={rule.id} data-rule-id={rule.id}>
                  <td>{rule.categoryCode}</td>
                  <td>{classLabel(t, rule.classCode)}</td>
                  <td>{startBasisLabel(t, rule.startBasis)}</td>
                  <td>{ruleSetLabel(t, rule.ruleSet)}</td>
                  <td>{ruleStatusLabel(t, rule.status)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="sub">
          <Link to={DOC_RETENTION_PATH}>{t('dgv.governance.ret.docs.link')}</Link>
        </p>
      </StateBoundary>
    </section>
  );
}
