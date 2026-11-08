import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { ConfirmDialog, ContextBar, DataTable, SectionCard, StatusPill } from '../../../ui';
import type { DataTableColumn } from '../../../ui';
import { useOc4idsExport, usePortalRecords, usePortalSettings, usePublishRecord, useSaveSettings, useWithdrawRecord } from './prjHooks';
import { PROJECT_TYPES, PURPOSES, REASON_MIN, SECTORS, dayText, hasRight, refusalKey, vietnamDateTime, word } from './prjModel';
import type { PortalRecord, PortalSettings } from './prjModel';
import { Facts, Figure, Pager, Provenance } from './prjParts';
import './prj.css';

const SIZE = 25;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUMMARY_MIN = 10;
export const PUBLIC_PATH = '/public/portals';

interface Form {
  slug: string;
  title: string;
  publisherName: string;
  idPrefix: string;
  licenseUri: string;
  policyUri: string;
  enabled: boolean;
  whistleEnabled: boolean;
}

const emptyForm: Form = { slug: '', title: '', publisherName: '', idPrefix: '', licenseUri: 'https://', policyUri: 'https://', enabled: false, whistleEnabled: false };
const formOf = (settings: PortalSettings | null): Form =>
  settings === null
    ? emptyForm
    : { slug: settings.slug, title: settings.title, publisherName: settings.publisher_name, idPrefix: settings.id_prefix, licenseUri: settings.license_uri, policyUri: settings.policy_uri, enabled: settings.enabled, whistleEnabled: settings.whistle_enabled };

/**
 * PRJ-33, the administration of the public portal (G4-9): the address and the words of the portal, the policy that was copied into the settings from the governance rule (the allowed fields, the rate limit, the size of a page),
 * the projects that are published with their revisions, the withdrawal with a reason, and the export in OC4IDS with the problems against the required fields of the standard: a field that the allow-list took away is listed, never
 * invented. A project is published only if it is classified public and is past the idea stage; the portal reads the cut that was stored, not the project.
 */
export default function PortalAdminScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <AdminContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function AdminContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { tenant, permissions, mode } = useSession();
  const settingsQuery = usePortalSettings();
  const settingsData = settingsQuery.data;
  const [includeWithdrawn, setIncludeWithdrawn] = useState(false);
  const [offset, setOffset] = useState(0);
  const recordsQuery = usePortalRecords(includeWithdrawn, offset, SIZE);
  const [showExport, setShowExport] = useState(false);
  const exportQuery = useOc4idsExport(showExport);
  const save = useSaveSettings();
  const publish = usePublishRecord();
  const withdraw = useWithdrawRecord();
  const [form, setForm] = useState<Form>(emptyForm);
  const [loadedVersion, setLoadedVersion] = useState<number | undefined>(undefined);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | undefined>(undefined);
  const [dialog, setDialog] = useState<{ kind: 'publish' } | { kind: 'withdraw'; record: PortalRecord } | undefined>(undefined);
  const [dialogError, setDialogError] = useState<string | undefined>(undefined);
  const [project, setProject] = useState('');
  const [summary, setSummary] = useState('');
  const [sector, setSector] = useState<string>(SECTORS[1]);
  const [projectType, setProjectType] = useState<string>(PROJECT_TYPES[0]);
  const [purpose, setPurpose] = useState<string>(PURPOSES[1]);

  // The form is filled once from what the server holds, and again whenever a save moved the version.
  const version = settingsData === undefined ? undefined : (settingsData.settings?.version ?? 0);
  useEffect(() => {
    if (settingsData !== undefined && version !== loadedVersion) {
      setForm(formOf(settingsData.settings));
      setLoadedVersion(version);
    }
  }, [settingsData, version, loadedVersion]);

  const state = useScreenState({ isLoading: settingsQuery.isLoading, error: settingsData === undefined ? settingsQuery.error : undefined, data: settingsData, isEmpty: () => false });
  const recordsState = useScreenState({ isLoading: recordsQuery.isLoading, error: recordsQuery.data === undefined ? recordsQuery.error : undefined, data: recordsQuery.data });
  const refreshFailed = settingsQuery.isError && settingsData !== undefined;
  const writable = mode !== 'READ_ONLY';
  const canManage = writable && hasRight(permissions, 'project.portal.manage');
  const canPublish = writable && hasRight(permissions, 'project.portal.publish');
  const owner = tenant?.name ?? '–';
  const asOf = settingsData === undefined ? '' : dayText(settingsData.as_of);
  const settings = settingsData?.settings ?? null;
  const stale = settings !== null && settingsData !== undefined && (settingsData.rule.version !== settings.policy_rule_version || settingsData.rule.allowed_fields.join() !== settings.allowed_fields.join());

  const set = (change: Partial<Form>): void => {
    setMessage(undefined);
    setForm({ ...form, ...change });
  };
  const refuse = (failure: unknown): string => t(`prj.common.error.${refusalKey(failure)}`);

  const saveSettings = (): void => {
    if (form.slug.trim() === '' || form.title.trim().length < 3 || form.publisherName.trim().length < 3 || form.idPrefix.trim().length < 2) {
      setMessage({ tone: 'error', text: t('prj.common.error.validationFailed') });
      return;
    }
    save.mutate(
      { expectedVersion: version ?? 0, slug: form.slug.trim(), enabled: form.enabled, whistleEnabled: form.whistleEnabled, title: form.title.trim(), publisherName: form.publisherName.trim(), idPrefix: form.idPrefix.trim(), licenseUri: form.licenseUri.trim(), policyUri: form.policyUri.trim() },
      { onSuccess: () => setMessage({ tone: 'ok', text: t('prj.portalAdmin.receipt.saved') }), onError: (failure) => setMessage({ tone: 'error', text: refuse(failure) }) },
    );
  };

  const recordColumns: DataTableColumn<PortalRecord>[] = [
    { key: 'code', header: t('prj.portalAdmin.col.code'), pinned: true, render: (record) => <strong data-testid={`record-${record.project_id}`}>{record.public_code}</strong> },
    { key: 'revision', header: t('prj.portalAdmin.col.revision'), align: 'right', render: (record) => record.revision },
    { key: 'published', header: t('prj.portalAdmin.col.published'), render: (record) => vietnamDateTime(record.published_at) },
    { key: 'fields', header: t('prj.portalAdmin.col.fields'), render: (record) => Object.keys(record.fields).join(', ') },
    { key: 'hash', header: t('prj.portalAdmin.col.hash'), render: (record) => <code title={record.fields_sha256}>{record.fields_sha256.slice(0, 12)}</code> },
    {
      key: 'status',
      header: t('prj.portalAdmin.col.status'),
      render: (record) => (record.withdrawn_at === null ? <StatusPill tone="success">{t('prj.portalAdmin.status.live')}</StatusPill> : <StatusPill tone="neutral">{t('prj.portalAdmin.status.withdrawn', { day: dayText(record.withdrawn_at) })}</StatusPill>),
    },
    {
      key: 'action',
      header: t('prj.portalAdmin.col.action'),
      render: (record) =>
        canPublish && record.withdrawn_at === null ? (
          <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid={`withdraw-${record.project_id}`} onClick={() => { setDialogError(undefined); setDialog({ kind: 'withdraw', record }); }}>
            {t('prj.portalAdmin.withdraw.button')}
          </button>
        ) : (
          '–'
        ),
    },
  ];

  const dialogNode = (): ReactNode => {
    if (dialog === undefined) return null;
    if (dialog.kind === 'withdraw') {
      return (
        <ConfirmDialog
          open
          title={t('prj.portalAdmin.withdraw.title')}
          context={[{ label: t('prj.portalAdmin.withdraw.record'), value: dialog.record.public_code }]}
          confirmLabel={t('prj.portalAdmin.withdraw.confirm')}
          cancelLabel={t('prj.portalAdmin.dialog.cancel')}
          pending={withdraw.isPending}
          reason={{ label: t('prj.portalAdmin.withdraw.reason'), required: true, minLength: REASON_MIN, hint: t('prj.portalAdmin.reason.hint', { min: REASON_MIN }) }}
          {...(dialogError === undefined ? {} : { error: dialogError })}
          onCancel={() => setDialog(undefined)}
          onConfirm={(reason) =>
            withdraw.mutate(
              { projectId: dialog.record.project_id, reason: (reason ?? '').trim() },
              {
                onSuccess: () => {
                  setDialog(undefined);
                  setMessage({ tone: 'ok', text: t('prj.portalAdmin.receipt.withdrawn') });
                },
                onError: (failure) => setDialogError(refuse(failure)),
              },
            )
          }
        />
      );
    }
    return (
      <ConfirmDialog
        open
        title={t('prj.portalAdmin.publish.title')}
        context={[{ label: t('prj.portalAdmin.publish.fields'), value: (settings?.allowed_fields ?? []).join(', ') }]}
        confirmLabel={t('prj.portalAdmin.publish.confirm')}
        cancelLabel={t('prj.portalAdmin.dialog.cancel')}
        pending={publish.isPending}
        {...(dialogError === undefined ? {} : { error: dialogError })}
        onCancel={() => setDialog(undefined)}
        onConfirm={() => {
          if (!UUID.test(project.trim()) || summary.trim().length < SUMMARY_MIN || /[<>]/.test(summary)) {
            setDialogError(t('prj.common.error.validationFailed'));
            return;
          }
          publish.mutate(
            { projectId: project.trim().toLowerCase(), summary: summary.trim(), sector, projectType, purpose },
            {
              onSuccess: (result) => {
                setDialog(undefined);
                setMessage({ tone: 'ok', text: t(`prj.portalAdmin.receipt.publish.${word(result.status)}`) });
              },
              onError: (failure) => setDialogError(refuse(failure)),
            },
          );
        }}
      >
        <div className="prj-form">
          <label>
            {t('prj.portalAdmin.publish.project')}
            <input type="text" value={project} data-testid="publish-project" onChange={(event) => setProject(event.target.value)} />
          </label>
          <label>
            {t('prj.portalAdmin.publish.summary')}
            <textarea value={summary} data-testid="publish-summary" onChange={(event) => setSummary(event.target.value)} />
          </label>
          <label>
            {t('prj.portalAdmin.publish.sector')}
            <select value={sector} onChange={(event) => setSector(event.target.value)}>
              {SECTORS.map((value) => (
                <option key={value} value={value}>
                  {t(`prj.portal.sector.${word(value)}`)}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t('prj.portalAdmin.publish.type')}
            <select value={projectType} onChange={(event) => setProjectType(event.target.value)}>
              {PROJECT_TYPES.map((value) => (
                <option key={value} value={value}>
                  {t(`prj.portal.type.${word(value)}`)}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t('prj.portalAdmin.publish.purpose')}
            <select value={purpose} onChange={(event) => setPurpose(event.target.value)}>
              {PURPOSES.map((value) => (
                <option key={value} value={value}>
                  {t(`prj.portal.purpose.${word(value)}`)}
                </option>
              ))}
            </select>
          </label>
        </div>
      </ConfirmDialog>
    );
  };

  const exported = exportQuery.data;
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('prj.portalAdmin.page.title')}</h1>
          <p>{t('prj.portalAdmin.page.subtitle')}</p>
        </div>
      </div>
      <ContextBar items={[{ label: t('prj.portalAdmin.context.scope'), value: owner }]} {...(settingsData === undefined ? {} : { asOf })} stale={refreshFailed} />
      <StateBoundary state={state} onRetry={() => void settingsQuery.refetch()}>
        {settingsData !== undefined && (
          <>
            {message === undefined ? null : (
              <p className="callout" role={message.tone === 'error' ? 'alert' : 'status'} data-testid="message">
                {message.text}
              </p>
            )}
            <SectionCard title={t('prj.portalAdmin.settings.section')} status={settings === null ? <StatusPill tone="warning">{t('prj.portalAdmin.settings.none')}</StatusPill> : <StatusPill tone={settings.enabled ? 'success' : 'neutral'}>{settings.enabled ? t('prj.portalAdmin.settings.on') : t('prj.portalAdmin.settings.off')}</StatusPill>}>
              <div className="prj-form">
                <label>
                  {t('prj.portalAdmin.settings.slug')}
                  <input type="text" value={form.slug} disabled={!canManage} data-testid="settings-slug" onChange={(event) => set({ slug: event.target.value })} />
                </label>
                <label>
                  {t('prj.portalAdmin.settings.title')}
                  <input type="text" value={form.title} disabled={!canManage} data-testid="settings-title" onChange={(event) => set({ title: event.target.value })} />
                </label>
                <label>
                  {t('prj.portalAdmin.settings.publisher')}
                  <input type="text" value={form.publisherName} disabled={!canManage} onChange={(event) => set({ publisherName: event.target.value })} />
                </label>
                <label>
                  {t('prj.portalAdmin.settings.prefix')}
                  <input type="text" value={form.idPrefix} disabled={!canManage} onChange={(event) => set({ idPrefix: event.target.value })} />
                </label>
                <label>
                  {t('prj.portalAdmin.settings.license')}
                  <input type="text" value={form.licenseUri} disabled={!canManage} onChange={(event) => set({ licenseUri: event.target.value })} />
                </label>
                <label>
                  {t('prj.portalAdmin.settings.policy')}
                  <input type="text" value={form.policyUri} disabled={!canManage} onChange={(event) => set({ policyUri: event.target.value })} />
                </label>
                <label>
                  <span>
                    <input type="checkbox" checked={form.enabled} disabled={!canManage} data-testid="settings-enabled" onChange={(event) => set({ enabled: event.target.checked })} /> {t('prj.portalAdmin.settings.enabled')}
                  </span>
                </label>
                <label>
                  <span>
                    <input type="checkbox" checked={form.whistleEnabled} disabled={!canManage} onChange={(event) => set({ whistleEnabled: event.target.checked })} /> {t('prj.portalAdmin.settings.whistle')}
                  </span>
                </label>
                {canManage ? (
                  <button type="button" className="ui-button ui-button--primary" data-testid="settings-save" disabled={save.isPending} onClick={saveSettings}>
                    {t('prj.portalAdmin.settings.save')}
                  </button>
                ) : null}
              </div>
              {settings === null ? null : (
                <>
                  <Facts
                    items={[
                      { label: t('prj.portalAdmin.policy.fields'), value: settings.allowed_fields.join(', '), testId: 'policy-fields' },
                      {
                        label: t('prj.portalAdmin.policy.rate'),
                        value: (
                          <Figure
                            label=""
                            testId="policy-rate"
                            info={
                              <Provenance
                                name={t('prj.portal.info.policy.name')}
                                formula={t('prj.portal.info.policy.formula')}
                                source={t('prj.portal.info.policy.source')}
                                asOf={dayText(settings.updated_at)}
                                version={settings.policy_rule_version}
                                unverified={settings.policy_rule_version === 0 || settingsData.rule.unverified}
                                owner={owner}
                              />
                            }
                          >
                            {t('prj.portalAdmin.policy.rate.value', { rate: settings.rate_per_minute, size: settings.page_size_max })}
                          </Figure>
                        ),
                      },
                      { label: t('prj.portalAdmin.policy.link'), value: <a href={`${PUBLIC_PATH}/${settings.slug}`} data-testid="public-link">{`${PUBLIC_PATH}/${settings.slug}`}</a> },
                    ]}
                  />
                  {stale ? (
                    <p className="callout" role="note" data-testid="policy-stale">
                      {t('prj.portalAdmin.policy.stale')}
                    </p>
                  ) : null}
                </>
              )}
            </SectionCard>

            <SectionCard
              title={t('prj.portalAdmin.records.section')}
              actions={
                canPublish && settings !== null ? (
                  <button type="button" className="ui-button ui-button--primary ui-button--small" data-testid="publish-open" onClick={() => { setDialogError(undefined); setProject(''); setSummary(''); setDialog({ kind: 'publish' }); }}>
                    {t('prj.portalAdmin.publish.button')}
                  </button>
                ) : undefined
              }
            >
              <label className="prj-inline">
                <span>
                  <input type="checkbox" checked={includeWithdrawn} data-testid="include-withdrawn" onChange={(event) => { setOffset(0); setIncludeWithdrawn(event.target.checked); }} /> {t('prj.portalAdmin.records.withdrawn')}
                </span>
              </label>
              <StateBoundary state={recordsState} onRetry={() => void recordsQuery.refetch()}>
                {recordsQuery.data !== undefined && (
                  <>
                    <DataTable caption={t('prj.portalAdmin.records.caption')} columns={recordColumns} rows={recordsQuery.data.items} rowKey={(record) => record.project_id} />
                    <Pager offset={offset} size={SIZE} hasMore={recordsQuery.data.has_more} onOffset={setOffset} />
                  </>
                )}
              </StateBoundary>
            </SectionCard>

            <SectionCard
              title={t('prj.portalAdmin.export.section')}
              actions={
                <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid="export-check" onClick={() => (showExport ? void exportQuery.refetch() : setShowExport(true))}>
                  {t('prj.portalAdmin.export.button')}
                </button>
              }
            >
              {!showExport ? <p className="prj-muted">{t('prj.portalAdmin.export.hint')}</p> : null}
              {showExport && exportQuery.isLoading ? <p role="status">{t('prj.portalAdmin.export.loading')}</p> : null}
              {showExport && exportQuery.isError ? (
                <p className="callout" role="alert" data-testid="export-error">
                  {t('prj.portalAdmin.export.error')}
                </p>
              ) : null}
              {exported === undefined ? null : (
                <>
                  <p className="callout" role={exported.complete ? 'status' : 'note'} data-testid="export-verdict">
                    {exported.complete ? t('prj.portalAdmin.export.complete', { count: exported.package.projects.length }) : t('prj.portalAdmin.export.incomplete', { count: exported.issues.length })}
                  </p>
                  <p className="prj-muted" data-testid="export-lists">
                    {t('prj.portalAdmin.export.lists', { version: exported.version, status: exported.lists.legal_status === 'UNVERIFIED' ? t('prj.portalAdmin.export.unverified') : t('prj.portalAdmin.export.verified') })}
                  </p>
                  <p>
                    {t('prj.portalAdmin.export.required')}: <code>{exported.required_fields.join(', ')}</code>
                  </p>
                  {exported.issues.length === 0 ? null : (
                    <ul className="prj-list" data-testid="export-issues">
                      {exported.issues.map((issue) => (
                        <li key={`${issue.path}:${issue.problem}`} className="prj-list__item">
                          <code>{issue.path}</code> {t(`prj.portal.issue.${word(issue.problem)}`)}
                        </li>
                      ))}
                    </ul>
                  )}
                  <a className="ui-button ui-button--outline" download="oc4ids.json" data-testid="export-download" href={`data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(exported.package, null, 2))}`}>
                    {t('prj.portalAdmin.export.download')}
                  </a>
                </>
              )}
            </SectionCard>
            {dialogNode()}
          </>
        )}
      </StateBoundary>
      <p className="prototype-note">{t('prj.common.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
