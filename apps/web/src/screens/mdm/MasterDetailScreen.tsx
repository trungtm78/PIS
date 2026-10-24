import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { BackLink, ImpactTable, SubmitWithImpact } from './components';
import { useChange, useHistory, useRecordByKey, useUsage } from './hooks';
import { recordStatusLabel } from './labels';
import { PROPOSE_PERMISSION, namespaceOf, recordLink } from './model';
import type { RecordView } from './model';

const EDIT_PATH = '/mdm/mdm-26';
const HISTORY_PATH = '/mdm/mdm-28';
const RETIRE_PATH = '/mdm/mdm-31';
const APPROVAL_PATH = '/mdm/mdm-32';
const NEVER_EMPTY = (): boolean => false;

/** MDM-27: one entry with the version in force and every place that uses it (the count that a change or a retirement is judged by). */
export default function MasterDetailScreen({ route }: ScreenProps) {
  const tenantId = useSession().tenant?.id;
  return <MasterDetailContent key={tenantId ?? 'none'} route={route} />;
}

function MasterDetailContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const masterType = params.get('type') ?? undefined;
  const businessKey = params.get('key') ?? undefined;
  const namespace = namespaceOf(params.get('ns'));
  const record = useRecordByKey(masterType, businessKey, namespace);
  const state = useScreenState({ isLoading: record.isLoading, error: record.error, data: masterType === undefined || businessKey === undefined ? undefined : record.data ?? undefined, isEmpty: NEVER_EMPTY });
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <BackLink to={masterType === undefined || businessKey === undefined ? HISTORY_PATH : recordLink(HISTORY_PATH, masterType, businessKey, namespace)}>{t('mdm.back.history.link')}</BackLink>
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('mdm.detail.page.title')}</h1>
          <p>{t('mdm.detail.page.subtitle')}</p>
        </div>
      </div>
      {masterType === undefined || businessKey === undefined || (record.isSuccess && record.data === null) ? (
        <p className="callout warning" role="status" data-testid="no-record">
          {t('mdm.detail.noRecord.notice')}
        </p>
      ) : (
        <StateBoundary state={state} onRetry={() => void record.refetch()}>
          {record.data === undefined || record.data === null ? null : <Detail record={record.data} />}
        </StateBoundary>
      )}
      <p className="prototype-note">{t('mdm.detail.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function Detail({ record }: { record: RecordView }) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const canEdit = (permissions === undefined || permissions.includes(PROPOSE_PERMISSION)) && mode !== 'READ_ONLY' && record.status === 'EFFECTIVE' && record.openChangeRequestId === null;
  const usage = useUsage(record.id);
  const history = useHistory(record.id);
  const open = useChange(record.openChangeRequestId ?? undefined);
  // The version of the request that was submitted from here: a request that comes back as a draft has a new version and is offered again.
  const [submitted, setSubmitted] = useState<number | undefined>(undefined);
  const canPropose = (permissions === undefined || permissions.includes(PROPOSE_PERMISSION)) && mode !== 'READ_ONLY';
  // A draft that was saved and not sent (the page was left, the session ended) is picked up here: its impact is read and it can be submitted.
  const draft = open.data !== undefined && open.data !== null && open.data.status === 'DRAFT' && open.data.version !== submitted ? open.data : undefined;
  const current = useMemo(() => history.data?.find((version) => version.id === record.versionId), [history.data, record.versionId]);
  return (
    <div className="mdm-grid">
      <article className="card" aria-label={t('mdm.detail.entry.title')}>
        <h2>{t('mdm.detail.entry.title')}</h2>
        <dl data-testid="entry">
          <dt>{t('mdm.detail.type.label')}</dt>
          <dd>{record.masterType}</dd>
          <dt>{t('mdm.detail.key.label')}</dt>
          <dd>
            <code>{record.businessKey}</code>
          </dd>
          <dt>{t('mdm.detail.name.label')}</dt>
          <dd>{record.label ?? t('mdm.detail.name.none')}</dd>
          {record.aliasLabel === null && record.aliasOrder === null ? null : (
            <>
              <dt>{t('mdm.detail.alias.label')}</dt>
              <dd data-testid="alias">{t('mdm.detail.alias.text', { label: record.aliasLabel ?? t('mdm.detail.alias.unset'), order: record.aliasOrder ?? t('mdm.detail.alias.unset') })}</dd>
            </>
          )}
          <dt>{t('mdm.detail.status.label')}</dt>
          <dd>{recordStatusLabel(t, record.status)}</dd>
          <dt>{t('mdm.detail.validity.label')}</dt>
          <dd>{record.validFrom === null ? t('mdm.detail.validity.none') : `${record.validFrom} → ${record.validUntil ?? t('mdm.detail.validity.open')}`}</dd>
          <dt>{t('mdm.detail.version.label')}</dt>
          <dd>{current === undefined ? '' : `#${current.revision}`}</dd>
          <dt>{t('mdm.detail.legalBasis.label')}</dt>
          <dd>{current?.legalBasis ?? t('mdm.detail.legalBasis.none')}</dd>
        </dl>
        <h3>{t('mdm.detail.attributes.title')}</h3>
        {current === undefined || Object.keys(current.attributes).length === 0 ? (
          <p className="muted">{t('mdm.detail.attributes.none')}</p>
        ) : (
          <table className="table" data-testid="attributes">
            <tbody>
              {Object.entries(current.attributes).map(([name, value]) => (
                <tr key={name}>
                  <th scope="row">{name}</th>
                  <td>{typeof value === 'string' ? value : JSON.stringify(value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {record.openChangeRequestId === null ? null : (
          <p className="callout" role="status" data-testid="pending">
            {draft === undefined ? t('mdm.detail.pending.notice') : t('mdm.detail.draft.notice')} <Link to={APPROVAL_PATH}>{t('mdm.detail.pending.link')}</Link>
          </p>
        )}
        {draft === undefined ? null : <SubmitWithImpact change={draft} canSubmit={canPropose} onSubmitted={() => setSubmitted(draft.version)} />}
        <div className="formfooter">
          <Link to={recordLink(HISTORY_PATH, record.masterType, record.businessKey, record.namespace)}>{t('mdm.detail.history.action')}</Link>
          {canEdit ? <Link to={recordLink(RETIRE_PATH, record.masterType, record.businessKey, record.namespace)}>{t('mdm.detail.retire.action')}</Link> : null}
          {canEdit ? (
            <Link className="button primary" to={recordLink(EDIT_PATH, record.masterType, record.businessKey, record.namespace)}>
              {t('mdm.detail.edit.action')}
            </Link>
          ) : null}
        </div>
      </article>
      <aside className="card" aria-label={t('mdm.detail.usage.title')}>
        <h2>{t('mdm.detail.usage.title')}</h2>
        {usage.isError ? (
          <p className="callout warning" role="alert">
            {t('mdm.detail.usage.error')}
          </p>
        ) : usage.data === undefined || usage.data === null ? (
          <p className="muted">{t('mdm.detail.usage.loading')}</p>
        ) : (
          <>
            <ImpactTable impact={usage.data} />
            {usage.data.samples.length === 0 ? null : (
              <>
                <h3>{t('mdm.detail.usage.samples.title')}</h3>
                <ul className="plain" data-testid="samples">
                  {usage.data.samples.map((sample) => (
                    <li key={`${sample.reference}:${sample.id}`}>
                      <code>{sample.reference}</code> · {sample.id}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </aside>
    </div>
  );
}
