import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { boqLink } from '../boq-model';
import { signedAmountText } from '../change/model';
import { BackLink, StatusBadge } from '../components';
import { useContract, useContracts } from '../hooks';
import { DRAFT_PATH, amountText, draftLink } from '../model';
import type { ContractView } from '../model';
import { kindLabel, standingLabel } from './labels';
import { decisionLink, timelineOf } from './model';
import type { TimelineEntry } from './model';
import '../ctr.css';

/**
 * CTR-26: the revisions of a contract in time (ST-CTR-007, CTR 3.3, BR-CTR-03). Each revision shows when it is in force, what it adds to the one it follows, the change order that made it
 * and how far its BOQ covers its value. Only the revision in force prices the work: one that waits for its day is shown and says it is not used for payment. A guest contractor reads the
 * same history of its own contract. Nothing is decided here; the change order is decided on CTR-08.
 */
export default function RevisionsScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The contract belongs to one membership: a switch of tenant or of membership starts the screen over.
  return <RevisionsContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function RevisionsContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const [search, setSearch] = useSearchParams();
  const contractId = search.get('id');
  const contract = useContract(contractId);
  const state = useScreenState({ isLoading: contract.isLoading, error: contract.error, data: contractId === null ? null : contract.data, isEmpty: (data) => data === null || data === undefined });

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <BackLink to={contractId === null ? DRAFT_PATH : draftLink(contractId)}>{t('ctr.revision.back.draft.link')}</BackLink>
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('ctr.revision.versions.title')}</h1>
          <p>{t('ctr.revision.versions.subtitle')}</p>
        </div>
      </div>
      {contractId === null ? (
        <ContractPicker onPick={(id) => setSearch({ id })} />
      ) : (
        <StateBoundary state={state} onRetry={() => void contract.refetch()}>
          {contract.data === null || contract.data === undefined ? null : <Timeline contract={contract.data} locale={locale} />}
        </StateBoundary>
      )}
      <p className="prototype-note">{t('ctr.revision.versions.footer', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

/** The contract whose history is read: a screen opened without one asks for it. */
function ContractPicker({ onPick }: { onPick(contractId: string): void }) {
  const { t } = useTranslation();
  const contracts = useContracts();
  const state = useScreenState({ isLoading: contracts.isLoading, error: contracts.error, data: contracts.data });
  return (
    <StateBoundary state={state} onRetry={() => void contracts.refetch()}>
      <article className="card" aria-label={t('ctr.revision.pick.title')}>
        <h2>{t('ctr.revision.pick.title')}</h2>
        <div className="field" data-field="versions-contract">
          <label htmlFor="versions-contract">{t('ctr.revision.pick.label')}</label>
          <select id="versions-contract" value="" onChange={(event) => (event.target.value === '' ? undefined : onPick(event.target.value))}>
            <option value="">{t('ctr.revision.pick.choose')}</option>
            {(contracts.data ?? []).map((contract) => (
              <option key={contract.id} value={contract.id}>
                {`${contract.code} · ${contract.title ?? contract.projectName}`}
              </option>
            ))}
          </select>
        </div>
      </article>
    </StateBoundary>
  );
}

function Timeline({ contract, locale }: { contract: ContractView; locale: string }) {
  const { t } = useTranslation();
  const entries = timelineOf(contract.revisions);
  return (
    <>
      <article className="card" aria-label={t('ctr.revision.contract.title')}>
        <h2>{t('ctr.revision.contract.title')}</h2>
        <p>
          <strong data-testid="contract-code">{contract.code}</strong> · {contract.title ?? t('ctr.revision.none.text')} <StatusBadge status={contract.status} />
        </p>
        <dl className="ctr-facts" data-testid="facts">
          <dt>{t('ctr.revision.fact.project')}</dt>
          <dd>{`${contract.projectCode} · ${contract.projectName}`}</dd>
          <dt>{t('ctr.revision.fact.value')}</dt>
          <dd data-testid="value">{t('ctr.value.amount', { amount: amountText(contract.contractValueVnd, locale) })}</dd>
        </dl>
        <p>
          <Link to={`/ctr/ctr-03?id=${contract.id}`} data-testid="workspace-link">
            {t('ctr.revision.workspace.link')}
          </Link>
        </p>
      </article>
      {entries.length === 0 ? (
        <p className="callout" role="status" data-testid="no-revisions">
          {t('ctr.revision.versions.empty')}
        </p>
      ) : (
        <ol className="ctr-timeline" data-testid="timeline">
          {entries.map((entry) => (
            <Revision key={entry.revision.id} entry={entry} contract={contract} locale={locale} />
          ))}
        </ol>
      )}
    </>
  );
}

function Revision({ entry, contract, locale }: { entry: TimelineEntry; contract: ContractView; locale: string }) {
  const { t } = useTranslation();
  const { revision } = entry;
  const delta = signedAmountText(entry.deltaVnd, locale);
  const covered = revision.boqTotalVnd === undefined ? undefined : amountText(revision.boqTotalVnd, locale);
  return (
    <li className="card ctr-revision" data-revision={revision.revision} data-standing={entry.standing}>
      <h2>
        {t('ctr.revision.item.title', { revision: revision.revision })} · {kindLabel(t, revision.kind)}{' '}
        <span className={entry.standing === 'WAITING' ? 'ctr-badge warning' : 'ctr-badge'} data-testid="standing">
          {standingLabel(t, entry.standing)}
        </span>
      </h2>
      {entry.standing === 'WAITING' ? (
        <p className="callout" role="status" data-testid="waiting-notice">
          {t('ctr.revision.waiting.notice', { day: revision.validFrom })}
        </p>
      ) : null}
      <dl className="ctr-facts">
        <dt>{t('ctr.revision.fact.period')}</dt>
        <dd data-testid="period">{revision.validUntil === null ? t('ctr.revision.period.open', { from: revision.validFrom }) : t('ctr.revision.period.closed', { from: revision.validFrom, until: revision.validUntil })}</dd>
        <dt>{t('ctr.revision.fact.amount')}</dt>
        <dd data-testid="amount">
          {t('ctr.value.amount', { amount: amountText(revision.amountVnd, locale) })}
          {delta === null ? null : <span data-testid="delta"> ({delta.startsWith('-') ? delta : `+${delta}`})</span>}
        </dd>
        <dt>{t('ctr.revision.fact.retroactive')}</dt>
        <dd data-testid="retroactive">{revision.retroactive ? t('ctr.revision.retroactive.yes') : t('ctr.revision.retroactive.no')}</dd>
        {revision.changeRequest === null ? null : (
          <>
            <dt>{t('ctr.revision.fact.source')}</dt>
            <dd>
              <Link to={decisionLink(contract.projectId, revision.changeRequest.id)} data-testid="source-link">
                {revision.changeRequest.code ?? revision.changeRequest.id}
              </Link>
            </dd>
          </>
        )}
        {covered === undefined ? null : (
          <>
            <dt>{t('ctr.revision.fact.boq')}</dt>
            <dd data-testid="boq">
              <Link to={boqLink(contract.id, revision.id)}>{t('ctr.revision.boq.covers', { lines: revision.boqLineCount ?? 0, total: covered })}</Link>
              {entry.boqShortVnd === null ? null : (
                <span className="sub" data-testid="boq-short">
                  {' '}
                  {t('ctr.revision.boq.short', { short: amountText(entry.boqShortVnd, locale) })}
                </span>
              )}
            </dd>
          </>
        )}
      </dl>
    </li>
  );
}
