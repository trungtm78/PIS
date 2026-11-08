import { useState } from 'react';
import type { FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StatusPill } from '../../ui';
import { Frame, Info, UnverifiedNote, asList, asRecord, money, num, percent, refusalCode, text, useGovCommand, useGovRead } from './gov11-kit';
import type { RuleReading } from './gov11-kit';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * CTR-33, a contract tied to its project, package and contractor, and its adjustment versions (G1-18): the chain is checked again on the record and the findings say where it breaks; every version that took effect
 * says what it did to the value and to the cost of the baseline, and a version over the thresholds of the rule waits for a review by a person other than who made the change.
 */
export default function LinkageScreen({ route }: ScreenProps) {
  const { t } = useTranslation();
  const [search, setSearch] = useSearchParams();
  const raw = search.get('id') ?? '';
  const id = UUID.test(raw) ? raw : undefined;
  const [typed, setTyped] = useState('');
  const linkage = useGovRead('ctr', 'getContractLinkage', id === undefined ? undefined : { path: { id } }, id !== undefined);
  const versions = useGovRead('ctr', 'listContractAdjustments', id === undefined ? undefined : { path: { id } }, id !== undefined);
  const { tenant } = useSession();
  if (id === undefined) {
    return (
      <section data-screen-id={route.id} aria-labelledby="screen-title" className="gov11-page">
        <div className="heading">
          <div>
            <h1 id="screen-title">{t('gov11.linkage.title')}</h1>
            <p>{t('gov11.linkage.subtitle')}</p>
          </div>
        </div>
        <form
          className="gov11-form"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            if (UUID.test(typed.trim())) setSearch({ id: typed.trim() });
          }}
        >
          <label>
            {t('gov11.linkage.pick')}
            <input value={typed} onChange={(event) => setTyped(event.target.value)} data-testid="contract-id" aria-invalid={typed !== '' && !UUID.test(typed.trim())} />
          </label>
          <button type="submit" className="ui-button ui-button--primary">
            {t('gov11.linkage.open')}
          </button>
          {raw !== '' && (
            <p role="alert" data-testid="bad-id">
              {t('gov11.linkage.badId')}
            </p>
          )}
        </form>
      </section>
    );
  }
  return (
    <Frame
      route={route}
      title={t('gov11.linkage.title')}
      subtitle={t('gov11.linkage.subtitle')}
      scope={[{ label: t('gov11.common.scope'), value: tenant?.name ?? '–' }]}
      query={linkage}
      notice={<UnverifiedNote rules={[asRecord(versions.data?.rule) as unknown as RuleReading]} />}
    >
      {(data) => {
        const contract = asRecord(data.contract);
        const project = asRecord(data.project);
        const pack = data.package === null ? null : asRecord(data.package);
        const award = data.award === null ? null : asRecord(data.award);
        const findings = asList(data.findings);
        const parties = asList(data.parties);
        const asOf = text(contract.code);
        return (
          <div className="gov11-grid">
            <section aria-labelledby="chain-title" data-testid="chain">
              <h2 id="chain-title">{t('gov11.linkage.chain')}</h2>
              <StatusPill tone={data.ok === true ? 'success' : 'danger'}>{data.ok === true ? t('gov11.linkage.ok') : t('gov11.linkage.broken')}</StatusPill>
              <dl>
                <dt>{t('gov11.linkage.project')}</dt>
                <dd>{`${text(project.code)} · ${text(project.name)}${project.group === null ? '' : ` · ${t('gov11.linkage.group', { group: text(project.group) })}`}`}</dd>
                <dt>{t('gov11.linkage.package')}</dt>
                <dd>{pack === null ? t('gov11.linkage.none') : text(pack.code)}</dd>
                <dt>
                  {t('gov11.linkage.award')}
                  <Info name={t('gov11.linkage.award')} rule={undefined} fallbackFormula={t('gov11.linkage.award.formula')} owner={t('gov11.linkage.owner')} asOf={asOf} />
                </dt>
                <dd>{award === null ? t('gov11.linkage.noAward') : t('gov11.linkage.awardPrice', { price: money(award.award_price_vnd), gap: money(data.award_gap_vnd) })}</dd>
                <dt>{t('gov11.linkage.contract')}</dt>
                <dd>{t('gov11.linkage.values', { original: money(contract.original_value_vnd), current: money(contract.current_value_vnd) })}</dd>
                <dt>{t('gov11.linkage.parties')}</dt>
                <dd>{parties.length === 0 ? t('gov11.linkage.none') : parties.map((party) => `${text(party.name)}${party.lead === true ? ` (${t('gov11.linkage.lead')})` : ''} ${percent(party.share_pct)}`).join(', ')}</dd>
              </dl>
              {findings.length > 0 && (
                <ul data-testid="findings">
                  {findings.map((finding) => (
                    <li key={text(finding.code)}>{t('gov11.linkage.finding', { code: text(finding.code), field: text(finding.field), severity: finding.severity === 'ERROR' ? t('gov11.linkage.severity.error') : t('gov11.linkage.severity.warning') })}</li>
                  ))}
                </ul>
              )}
            </section>
            <Adjustments contractId={id} data={versions.data} loading={versions.isLoading} failed={versions.isError} onRetry={() => void versions.refetch()} />
          </div>
        );
      }}
    </Frame>
  );
}

function Adjustments({ contractId, data, loading, failed, onRetry }: { contractId: string; data: Record<string, unknown> | undefined; loading: boolean; failed: boolean; onRetry: () => void }) {
  const { t } = useTranslation();
  const command = useGovCommand('reviewContractAdjustment');
  const [open, setOpen] = useState<string | undefined>(undefined);
  const [decision, setDecision] = useState('KEEP_BASELINE');
  const [note, setNote] = useState('');
  const [receipt, setReceipt] = useState<string | undefined>(undefined);
  if (loading) return <p aria-busy="true">{t('gov11.linkage.loading')}</p>;
  if (failed || data === undefined)
    return (
      <p role="alert" data-testid="versions-error">
        {t('gov11.linkage.versionsError')}{' '}
        <button type="button" className="ui-button ui-button--outline" onClick={onRetry}>
          {t('gov11.common.retry')}
        </button>
      </p>
    );
  const rule = asRecord(data.rule) as unknown as RuleReading;
  const items = asList(data.items);
  const classLabel = (value: string): string => {
    switch (value) {
      case 'REVIEW_REQUIRED':
        return t('gov11.linkage.class.review');
      case 'NO_BASELINE':
        return t('gov11.linkage.class.noBaseline');
      case 'WITHIN_TOLERANCE':
        return t('gov11.linkage.class.within');
      default:
        return t('gov11.linkage.class.none');
    }
  };
  const submit = (row: Record<string, unknown>): void => {
    command.mutate(
      { path: { id: text(row.id) }, body: { decision, ...(note.trim() === '' ? {} : { note: note.trim() }) }, version: num(row.version) },
      {
        onSuccess: () => {
          setOpen(undefined);
          setNote('');
          setReceipt(text(row.id));
        },
      },
    );
  };
  return (
    <section aria-labelledby="versions-title" data-testid="versions">
      <h2 id="versions-title">{t('gov11.linkage.versions')}</h2>
      {receipt !== undefined && (
        <p className="callout" role="status" data-testid="review-receipt">
          {t('gov11.linkage.receipt', { id: receipt.slice(0, 8) })}
        </p>
      )}
      {items.length === 0 ? (
        <p data-testid="versions-empty">{t('gov11.linkage.versionsNone')}</p>
      ) : (
        <div className="gov11-scroll">
          <table className="gov11-table">
            <caption>{t('gov11.linkage.versions.caption', { contract: contractId.slice(0, 8) })}</caption>
            <thead>
              <tr>
                <th scope="col">{t('gov11.linkage.col.revision')}</th>
                <th scope="col" className="gov11-num">
                  {t('gov11.linkage.col.delta')}
                </th>
                <th scope="col" className="gov11-num">
                  {t('gov11.linkage.col.cumulative')}
                  <Info name={t('gov11.linkage.col.cumulative')} rule={rule} fallbackFormula={t('gov11.linkage.cumulative.formula')} owner={t('gov11.linkage.owner')} asOf={contractId.slice(0, 8)} />
                </th>
                <th scope="col" className="gov11-num">
                  {t('gov11.linkage.col.share')}
                  <Info name={t('gov11.linkage.col.share')} rule={rule} fallbackFormula={t('gov11.linkage.share.formula')} owner={t('gov11.linkage.owner')} asOf={contractId.slice(0, 8)} />
                </th>
                <th scope="col">{t('gov11.linkage.col.class')}</th>
                <th scope="col">{t('gov11.linkage.col.review')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((row) => {
                const waiting = row.review_status === 'PENDING';
                return (
                  <tr key={text(row.id)} data-testid={`version-${text(row.revision)}`}>
                    <th scope="row">{text(row.revision)}</th>
                    <td className="gov11-num">{`${money(row.delta_vnd)} (${percent(row.delta_pct_of_previous)})`}</td>
                    <td className="gov11-num">{`${money(row.cumulative_delta_vnd)} (${percent(row.cumulative_pct_of_original)})`}</td>
                    <td className="gov11-num">{percent(row.share_of_baseline_pct)}</td>
                    <td>
                      <StatusPill tone={row.classification === 'REVIEW_REQUIRED' || row.classification === 'NO_BASELINE' ? 'warning' : 'neutral'}>{classLabel(text(row.classification))}</StatusPill>
                    </td>
                    <td>
                      {waiting ? (
                        open === text(row.id) ? (
                          <form
                            className="gov11-form"
                            onSubmit={(event: FormEvent) => {
                              event.preventDefault();
                              submit(row);
                            }}
                          >
                            <label>
                              {t('gov11.linkage.decision')}
                              <select value={decision} onChange={(event) => setDecision(event.target.value)} data-testid="decision">
                                <option value="KEEP_BASELINE">{t('gov11.linkage.decision.keep')}</option>
                                <option value="REBASELINE">{t('gov11.linkage.decision.rebaseline')}</option>
                              </select>
                            </label>
                            <label>
                              {t('gov11.linkage.note')}
                              <textarea value={note} onChange={(event) => setNote(event.target.value)} data-testid="note" />
                            </label>
                            {command.isError && (
                              <p role="alert" data-testid="review-error">
                                {refusalCode(command.error) === 'SELF_APPROVAL_DENIED' ? t('gov11.linkage.error.self') : refusalCode(command.error) === 'VERSION_CONFLICT' ? t('gov11.linkage.error.conflict') : t('gov11.linkage.error.other')}
                              </p>
                            )}
                            <div className="gov11-row">
                              <button type="submit" className="ui-button ui-button--primary" disabled={command.isPending} data-testid="review-submit">
                                {command.isPending ? t('gov11.common.sending') : t('gov11.linkage.submit')}
                              </button>
                              <button type="button" className="ui-button ui-button--outline" onClick={() => setOpen(undefined)}>
                                {t('gov11.common.cancel')}
                              </button>
                            </div>
                          </form>
                        ) : (
                          <button type="button" className="ui-button ui-button--outline" onClick={() => setOpen(text(row.id))} data-testid={`review-${text(row.revision)}`}>
                            {t('gov11.linkage.review')}
                          </button>
                        )
                      ) : row.review_status === 'DECIDED' ? (
                        t('gov11.linkage.decided', { decision: row.review_decision === 'REBASELINE' ? t('gov11.linkage.decision.rebaseline') : t('gov11.linkage.decision.keep') })
                      ) : (
                        t('gov11.linkage.notNeeded')
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
