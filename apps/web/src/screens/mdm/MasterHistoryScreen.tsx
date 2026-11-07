import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { useChange, useHistory, useRecordByKey } from './hooks';
import { changeKindLabel, changeStatusLabel } from './labels';
import { changedFields, fieldValue, namespaceOf, recordLink } from './model';
import type { ChangedField, RecordView, VersionView } from './model';
import { KitTable } from '../adm/KitTable';
import '../adm/adm-kit.css';
import { StatusPill } from '../../ui';

const DETAIL_PATH = '/mdm/mdm-27';
const APPROVAL_PATH = '/mdm/mdm-32';
const NEVER_EMPTY = (): boolean => false;

function fieldName(t: ReturnType<typeof useTranslation>['t'], field: ChangedField): string {
  switch (field) {
    case 'label':
      return t('mdm.history.field.label.text');
    case 'attributes':
      return t('mdm.history.field.attributes.text');
    case 'parent':
      return t('mdm.history.field.parent.text');
    case 'validity':
      return t('mdm.history.field.validity.text');
    case 'legalBasis':
      return t('mdm.history.field.legalBasis.text');
  }
}

/** MDM-28: the versions of one entry, each with what it changed against the one before (the old values stay readable for their dates). */
export default function MasterHistoryScreen({ route }: ScreenProps) {
  const tenantId = useSession().tenant?.id;
  return <MasterHistoryContent key={tenantId ?? 'none'} route={route} />;
}

function MasterHistoryContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const masterType = params.get('type') ?? undefined;
  const businessKey = params.get('key') ?? undefined;
  const record = useRecordByKey(masterType, businessKey, namespaceOf(params.get('ns')));
  const state = useScreenState({ isLoading: record.isLoading, error: record.error, data: masterType === undefined || businessKey === undefined ? undefined : record.data ?? undefined, isEmpty: NEVER_EMPTY });
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('mdm.history.page.title')}</h1>
          <p>{t('mdm.history.page.subtitle')}</p>
        </div>
      </div>
      {masterType === undefined || businessKey === undefined || (record.isSuccess && record.data === null) ? (
        <p className="callout warning" role="status" data-testid="no-record">
          {t('mdm.history.noRecord.notice')}
        </p>
      ) : (
        <StateBoundary state={state} onRetry={() => void record.refetch()}>
          {record.data === undefined || record.data === null ? null : <History record={record.data} />}
        </StateBoundary>
      )}
      <p className="prototype-note">{t('mdm.history.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function VersionRow({ version, before }: { version: VersionView; before: VersionView | undefined }) {
  const { t } = useTranslation();
  const fields = changedFields(before, version);
  return (
    <tr data-revision={version.revision}>
      <td>#{version.revision}</td>
      <td>
        {before === undefined ? <StatusPill tone="neutral">{t('mdm.history.created.text')}</StatusPill> : null}
        {fields.length === 0 ? (
          <span className="muted">{t('mdm.history.unchanged.text')}</span>
        ) : (
          <ul className="plain">
            {fields.map((field) => (
              <li key={field} data-field={field}>
                <strong>{fieldName(t, field)}</strong>
                {before === undefined ? null : (
                  <>
                    {' '}
                    <del data-side="before">{fieldValue(before, field)}</del> →
                  </>
                )}{' '}
                <ins data-side="after">{fieldValue(version, field)}</ins>
              </li>
            ))}
          </ul>
        )}
      </td>
      <td>{version.approvedBy ?? t('mdm.history.approver.none')}</td>
      <td>
        {version.validFrom} → {version.validUntil ?? t('mdm.detail.validity.open')}
      </td>
    </tr>
  );
}

function History({ record }: { record: RecordView }) {
  const { t } = useTranslation();
  const history = useHistory(record.id);
  const pending = useChange(record.openChangeRequestId);
  const versions = useMemo(() => history.data ?? [], [history.data]);
  return (
    <article className="card" aria-label={t('mdm.history.table.title')}>
      <h2>
        {record.businessKey} · {record.label ?? ''}
      </h2>
      {pending.data === undefined || pending.data === null ? null : (
        <p className="callout" role="status" data-testid="pending">
          {t('mdm.history.pending.notice', { kind: changeKindLabel(t, pending.data.changeKind), status: changeStatusLabel(t, pending.data.status), from: pending.data.effectiveFrom })}{' '}
          <Link to={APPROVAL_PATH}>{t('mdm.detail.pending.link')}</Link>
        </p>
      )}
      {history.isError ? (
        <p className="callout warning" role="alert">
          {t('mdm.history.error.text')}
        </p>
      ) : versions.length === 0 ? (
        <p className="muted">{t('mdm.history.empty.text')}</p>
      ) : (
        <KitTable caption={t('w2mdm.history.table.caption')}>
          <thead>
            <tr>
              <th>{t('mdm.history.col.version')}</th>
              <th>{t('mdm.history.col.change')}</th>
              <th>{t('mdm.history.col.approver')}</th>
              <th>{t('mdm.history.col.effective')}</th>
            </tr>
          </thead>
          <tbody>
            {versions.map((version, index) => (
              <VersionRow key={version.id} version={version} before={versions[index - 1]} />
            ))}
          </tbody>
        </KitTable>
      )}
      <div className="adm-kit-actions">
        <Link to={recordLink(DETAIL_PATH, record.masterType, record.businessKey, record.namespace)}>{t('mdm.history.detail.link')}</Link>
      </div>
    </article>
  );
}
