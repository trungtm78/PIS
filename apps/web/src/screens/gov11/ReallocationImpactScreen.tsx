import { useState } from 'react';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StatusPill } from '../../ui';
import { Figure, Frame, Info, UnverifiedNote, asList, asRecord, dayLabel, money, num, percent, text, useGovRead } from './gov11-kit';
import type { RuleReading } from './gov11-kit';

/** The rule of the candidates and of the simulation as the API writes it (the policy of the day, with its provenance). */
function policyRule(policy: Record<string, unknown>): RuleReading {
  const unverified = policy.unverified === true;
  return {
    version: num(policy.version ?? policy.rule_version),
    source: policy.source === 'RULE' ? 'RULE' : 'DEFAULT',
    unverified,
    params: asRecord(policy.params),
    provenance: typeof policy.formula === 'string' ? { formula: policy.formula, source: text(policy.source_text), as_of: text(policy.as_of), legal_status: unverified ? 'UNVERIFIED' : 'VERIFIED' } : null,
  };
}

/**
 * CAP-23, the reallocation of capital by performance and its impact on the rates (G1-12): the donors and recipients ranked by the projected performance, and for a proposal the impact on the rates of the province and of
 * each unit before and after, made by the same function as DIS so the numbers are the ones DIS shows. The impact is recorded when the proposal is handed in and the approver reads the record; the approver is limited
 * by the delegation matrix for the total. The thresholds are the rule REALLOCATION_POLICY (not confirmed).
 */
export default function ReallocationImpactScreen({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { tenant } = useSession();
  const [proposalId, setProposalId] = useState('');
  const candidates = useGovRead('cap', 'listReallocationCandidates', undefined);
  const proposals = useGovRead('cap', 'listReallocationProposals', undefined);
  const impact = useGovRead('cap', 'getReallocationImpact', proposalId === '' ? undefined : { path: { id: proposalId } }, proposalId !== '');
  const names = new Map<string, string>(asList(candidates.data?.projects).map((project) => [text(project.id), `${text(project.code)} · ${text(project.name)}`]));
  const unitNames = new Map<string, string>(asList(candidates.data?.units).map((unit) => [text(unit.id), text(unit.name)]));
  return (
    <Frame
      route={route}
      title={t('gov11.reallocation.title')}
      subtitle={t('gov11.reallocation.subtitle')}
      scope={[{ label: t('gov11.common.scope'), value: tenant?.name ?? '–' }]}
      query={candidates}
      isEmpty={(data) => asList(data.donors).length === 0 && asList(data.recipients).length === 0 && asList(data.excluded).length === 0}
      notice={<UnverifiedNote rules={[policyRule(asRecord(candidates.data?.policy))]} />}
    >
      {(data) => {
        const rule = policyRule(asRecord(data.policy));
        const donors = asList(data.donors);
        const recipients = asList(data.recipients);
        const asOf = dayLabel(data.as_of_date);
        const items = asList(proposals.data?.items);
        return (
          <div className="gov11-grid">
            <p data-testid="basis-line">{t('gov11.reallocation.basis', { asOf, cutoff: dayLabel(data.treasury_cutoff_date), year: text(data.plan_year) })}</p>
            <div className="gov11-row">
              <Figure label={t('gov11.reallocation.donors')} value={text(donors.length)} rule={rule} fallbackFormula={t('gov11.reallocation.donors.formula')} owner={t('gov11.reallocation.owner')} asOf={asOf} />
              <Figure label={t('gov11.reallocation.recipients')} value={text(recipients.length)} rule={rule} fallbackFormula={t('gov11.reallocation.recipients.formula')} owner={t('gov11.reallocation.owner')} asOf={asOf} />
              <Figure label={t('gov11.reallocation.excluded')} value={text(asList(data.excluded).length)} rule={rule} fallbackFormula={t('gov11.reallocation.excluded.formula')} owner={t('gov11.reallocation.owner')} asOf={asOf} />
            </div>
            <section aria-labelledby="donors-title" data-testid="donors">
              <h2 id="donors-title">{t('gov11.reallocation.donors.title')}</h2>
              {donors.length === 0 ? (
                <p>{t('gov11.reallocation.donors.none')}</p>
              ) : (
                <div className="gov11-scroll">
                  <table className="gov11-table">
                    <caption>{t('gov11.reallocation.donors.caption')}</caption>
                    <thead>
                      <tr>
                        <th scope="col">{t('gov11.reallocation.col.project')}</th>
                        <th scope="col" className="gov11-num">
                          {t('gov11.reallocation.col.ratio')}
                          <Info name={t('gov11.reallocation.col.ratio')} rule={rule} fallbackFormula={t('gov11.reallocation.ratio.formula')} owner={t('gov11.reallocation.owner')} asOf={asOf} />
                        </th>
                        <th scope="col" className="gov11-num">
                          {t('gov11.reallocation.col.releasable')}
                          <Info name={t('gov11.reallocation.col.releasable')} rule={rule} fallbackFormula={t('gov11.reallocation.releasable.formula')} owner={t('gov11.reallocation.owner')} asOf={asOf} />
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {donors.map((row) => (
                        <tr key={text(row.project_id)} data-testid={`donor-${text(row.project_id)}`}>
                          <th scope="row">{names.get(text(row.project_id)) ?? text(row.project_id)}</th>
                          <td className="gov11-num">{percent(row.ratio_pct)}</td>
                          <td className="gov11-num">{money(row.releasable_vnd)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
            <section aria-labelledby="recipients-title" data-testid="recipients">
              <h2 id="recipients-title">{t('gov11.reallocation.recipients.title')}</h2>
              {recipients.length === 0 ? (
                <p>{t('gov11.reallocation.recipients.none')}</p>
              ) : (
                <div className="gov11-scroll">
                  <table className="gov11-table">
                    <caption>{t('gov11.reallocation.recipients.caption')}</caption>
                    <thead>
                      <tr>
                        <th scope="col">{t('gov11.reallocation.col.project')}</th>
                        <th scope="col" className="gov11-num">
                          {t('gov11.reallocation.col.ratio')}
                        </th>
                        <th scope="col" className="gov11-num">
                          {t('gov11.reallocation.col.demand')}
                          <Info name={t('gov11.reallocation.col.demand')} rule={rule} fallbackFormula={t('gov11.reallocation.demand.formula')} owner={t('gov11.reallocation.owner')} asOf={asOf} />
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {recipients.map((row) => (
                        <tr key={text(row.project_id)} data-testid={`recipient-${text(row.project_id)}`}>
                          <th scope="row">{names.get(text(row.project_id)) ?? text(row.project_id)}</th>
                          <td className="gov11-num">{percent(row.ratio_pct)}</td>
                          <td className="gov11-num">{money(row.demand_vnd)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
            <section aria-labelledby="impact-title" data-testid="impact-section">
              <h2 id="impact-title">{t('gov11.reallocation.impact.title')}</h2>
              <label>
                {t('gov11.reallocation.impact.pick')}
                <select value={proposalId} onChange={(event) => setProposalId(event.target.value)} data-testid="proposal-select">
                  <option value="">{t('gov11.reallocation.impact.none')}</option>
                  {items.map((proposal) => (
                    <option key={text(proposal.id)} value={text(proposal.id)}>
                      {`${text(proposal.code)} · ${text(proposal.status)}`}
                    </option>
                  ))}
                </select>
              </label>
              {proposals.isError && (
                <p role="alert" data-testid="proposals-error">
                  {t('gov11.reallocation.proposals.error')}
                </p>
              )}
              {proposalId !== '' && <Impact query={impact} unitNames={unitNames} names={names} />}
            </section>
          </div>
        );
      }}
    </Frame>
  );
}

function Impact({ query, unitNames, names }: { query: ReturnType<typeof useGovRead>; unitNames: Map<string, string>; names: Map<string, string> }) {
  const { t } = useTranslation();
  if (query.isLoading) return <p aria-busy="true">{t('gov11.reallocation.impact.loading')}</p>;
  if (query.isError || query.data === undefined)
    return (
      <p role="alert" data-testid="impact-error">
        {t('gov11.reallocation.impact.error')}{' '}
        <button type="button" className="ui-button ui-button--outline" onClick={() => void query.refetch()}>
          {t('gov11.common.retry')}
        </button>
      </p>
    );
  const data = query.data;
  const rule = policyRule(asRecord(data.policy));
  const year = asRecord(asRecord(asRecord(data.result).basis).CURRENT_YEAR);
  const province = asRecord(year.province);
  const before = asRecord(province.before);
  const after = asRecord(province.after);
  const units = asList(year.units);
  const projected = data.result === null ? null : asRecord(asRecord(data.result).projected);
  const warnings = asList(asRecord(data.result).warnings);
  const delegation = asRecord(data.delegation);
  const asOf = dayLabel(data.as_of_date);
  const delta = (value: unknown): string => (value === null || value === undefined ? '–' : `${text(value)} ${t('gov11.common.points')}`);
  return (
    <div className="gov11-grid" data-testid="impact">
      <p data-testid="impact-frozen">{data.frozen === true ? t('gov11.reallocation.impact.frozen', { time: text(asRecord(data.record).recorded_at) }) : t('gov11.reallocation.impact.live')}</p>
      <div className="gov11-row">
        <Figure label={t('gov11.reallocation.province.before')} value={percent(before.rate_total_pct)} rule={rule} fallbackFormula={t('gov11.reallocation.rate.formula')} owner={t('gov11.reallocation.owner')} asOf={asOf} />
        <Figure label={t('gov11.reallocation.province.after')} value={percent(after.rate_total_pct)} sub={delta(province.delta_rate_total_pct)} rule={rule} fallbackFormula={t('gov11.reallocation.rate.formula')} owner={t('gov11.reallocation.owner')} asOf={asOf} />
        {projected !== null && (
          <Figure label={t('gov11.reallocation.projected')} value={percent(projected.delta_rate_pct === undefined ? null : asRecord(projected.after).rate_pct)} sub={delta(projected.delta_rate_pct)} rule={rule} fallbackFormula={t('gov11.reallocation.projected.formula')} owner={t('gov11.reallocation.owner')} asOf={asOf} />
        )}
      </div>
      <div className="gov11-scroll">
        <table className="gov11-table" data-testid="units-table">
          <caption>{t('gov11.reallocation.units.caption')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('gov11.reallocation.col.unit')}</th>
              <th scope="col" className="gov11-num">
                {t('gov11.reallocation.col.before')}
              </th>
              <th scope="col" className="gov11-num">
                {t('gov11.reallocation.col.after')}
              </th>
              <th scope="col" className="gov11-num">
                {t('gov11.reallocation.col.delta')}
              </th>
            </tr>
          </thead>
          <tbody>
            {units.map((unit) => (
              <tr key={text(unit.id)}>
                <th scope="row">{unitNames.get(text(unit.id)) ?? text(unit.id)}</th>
                <td className="gov11-num">{percent(asRecord(unit.before).rate_total_pct)}</td>
                <td className="gov11-num">{percent(asRecord(unit.after).rate_total_pct)}</td>
                <td className="gov11-num">{delta(unit.delta_rate_total_pct)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {warnings.length > 0 && (
        <ul data-testid="warnings">
          {warnings.map((warning, index) => (
            <li key={`${text(warning.code)}-${index}`}>
              <StatusPill tone="warning">{text(warning.code)}</StatusPill> {text(warning.project_id) === '–' ? '' : (names.get(text(warning.project_id)) ?? text(warning.project_id))}
            </li>
          ))}
        </ul>
      )}
      <p data-testid="delegation-line">
        {delegation.configured === true ? t('gov11.reallocation.delegation.role', { role: text(delegation.approver_role_name), levels: text(delegation.approval_levels) }) : t('gov11.reallocation.delegation.none')}
        <Info name={t('gov11.reallocation.delegation.name')} rule={undefined} fallbackFormula={t('gov11.reallocation.delegation.formula')} owner={t('gov11.reallocation.owner')} asOf={asOf} />
      </p>
    </div>
  );
}
