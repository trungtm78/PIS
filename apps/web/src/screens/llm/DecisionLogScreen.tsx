import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { Field } from '../mne/components';
import '../dis/dis.css';
import { DECISIONS, NO_DECISION_FILTER } from './emergency-model';
import type { DecisionFilter } from './emergency-model';
import { actionKindLabel, decisionLabel } from './eval-labels';
import { ROUTING_PATH } from './gateway-model';
import { useDecisions } from './hooks';
import { vietnamDay } from './llm-model';

/**
 * LLM-20: the decisions of people about what the AI answered (ST-LLM-006, LLM F8, BR-LLM-11): nothing an AI answered writes, moves money, decides or publishes on its own, and each time a person decided, here is who, about what (the
 * module, the kind and the subject), about which answer (the start of its hash, with a link to how it was routed), what they decided, in their words, and which operation and version of the record it ended up in. A record is
 * written once and is not changed. Newest first, narrowed by module and decision.
 */
export default function DecisionLogScreen({ route }: ScreenProps) {
  const tenant = useSession().tenant;
  // What is open belongs to one member of one tenant: a switch starts the screen over.
  return <DecisionLogContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function DecisionLogContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<DecisionFilter>(NO_DECISION_FILTER);
  const decisions = useDecisions(filter);
  const rows = (decisions.data?.pages ?? []).flatMap((page) => page.items);
  const state = useScreenState({ isLoading: decisions.isLoading, error: decisions.isFetchNextPageError ? null : decisions.error, data: decisions.data === undefined ? undefined : { rows } });
  const set = <K extends keyof DecisionFilter>(field: K, value: DecisionFilter[K]): void => setFilter((previous) => ({ ...previous, [field]: value }));
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('llm.decisions.page.title')}</h1>
          <p>{t('llm.decisions.page.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={state} onRetry={() => void decisions.refetch()}>
        <div className="card">
          <div className="mne-filters">
            <Field id="decisions-module" label={t('llm.decisions.filter.module')} error={undefined}>
              <input id="decisions-module" value={filter.module} maxLength={10} onChange={(event) => set('module', event.target.value)} />
            </Field>
            <Field id="decisions-decision" label={t('llm.decisions.filter.decision')} error={undefined}>
              <select id="decisions-decision" value={filter.decision} onChange={(event) => set('decision', event.target.value)}>
                <option value="">{t('llm.requests.filter.all')}</option>
                {DECISIONS.map((decision) => (
                  <option key={decision} value={decision}>
                    {decisionLabel(t, decision)}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </div>
        <table className="table" data-testid="decision-table" aria-label={t('llm.decisions.table.aria')}>
          <thead>
            <tr>
              <th scope="col">{t('llm.decisions.column.time')}</th>
              <th scope="col">{t('llm.decisions.column.subject')}</th>
              <th scope="col">{t('llm.decisions.column.action')}</th>
              <th scope="col">{t('llm.decisions.column.decision')}</th>
              <th scope="col">{t('llm.decisions.column.rationale')}</th>
              <th scope="col">{t('llm.decisions.column.output')}</th>
              <th scope="col">{t('llm.decisions.column.applied')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((entry) => (
              <tr key={entry.id} data-decision-id={entry.id} data-decision={entry.decision}>
                <td>
                  {vietnamDay(entry.decidedAt)} <span className="sub">{entry.decidedBy.slice(0, 8)}</span>
                </td>
                <td>
                  {entry.module} · {entry.kind} <span className="sub">{entry.subjectId.slice(0, 8)}</span>
                </td>
                <td>{actionKindLabel(t, entry.action)}</td>
                <td>{decisionLabel(t, entry.decision)}</td>
                <td>{entry.rationale}</td>
                <td>
                  <Link to={`${ROUTING_PATH}?request=${entry.requestId}`}>
                    <code>{entry.outputSha256.slice(0, 12)}</code>
                  </Link>
                </td>
                <td>{entry.appliedOperation === null ? t('llm.decisions.notApplied') : t('llm.decisions.applied', { operation: entry.appliedOperation, version: entry.appliedVersion ?? '' })}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 ? <p data-testid="decisions-none">{t('llm.decisions.none')}</p> : null}
        {decisions.hasNextPage ? (
          <button type="button" className="btn" data-testid="decisions-more" disabled={decisions.isFetchingNextPage} onClick={() => void decisions.fetchNextPage()}>
            {t('llm.requests.more')}
          </button>
        ) : null}
        {decisions.isFetchNextPageError ? (
          <p className="callout warning" role="alert" data-testid="decisions-more-failed">
            {t('llm.requests.moreFailed')}
          </p>
        ) : null}
      </StateBoundary>
    </section>
  );
}
