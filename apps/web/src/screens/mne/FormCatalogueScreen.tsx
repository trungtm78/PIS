import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { ContextBar, DataTable, FilterPanel, SectionCard, StatusPill } from '../../ui';
import type { DataTableColumn } from '../../ui';
import { ConfirmationLabel } from './components';
import { FormRevisionForm } from './FormRevisionForm';
import { useForms, usePublishForm } from './hooks';
import type { FormFilter } from './hooks';
import { formStatusLabel, phaseLabel, problemMessage, reportKindLabel } from './labels';
import { actionsFor, describeProblem, lastDayOf, phaseOf, vietnamToday } from './model';
import { RulesPanel } from './RulesPanel';
import { formStatusTone } from './tones';
import { APPROVE_FORMS_PERMISSION, MANAGE_FORMS_PERMISSION, REPORT_KINDS } from './types';
import type { FormView, ReportKind } from './types';
import './mne.css';
import './mne-kit.css';

type Translate = ReturnType<typeof useTranslation>['t'];

const EMPTY_FILTER: FormFilter = { reportKind: '', effectiveOn: '' };
/** The route of the DOC template library (DOC-14), where the template of a form is read. */
const DOC_TEMPLATES_PATH = '/doc/doc-14';

/** MNE-02: the catalogue of report forms as dated legal data, with the period each revision applies, its legal basis and its DOC template. */
export default function FormCatalogueScreen({ route }: ScreenProps) {
  const tenantId = useSession().tenant?.id;
  // The filters, the open panel and the draft of a revision belong to one tenant: a switch starts the screen over.
  return <FormCatalogueContent key={tenantId ?? 'none'} route={route} />;
}

function FormCatalogueContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode, tenant } = useSession();
  // A suspended tenant (READ_ONLY mode) is read-only for everyone, whatever the grants say.
  const frozen = mode === 'READ_ONLY';
  const mayDraft = (permissions === undefined || permissions.includes(MANAGE_FORMS_PERMISSION)) && !frozen;
  const context = { membershipId: tenant?.membershipId, permissions, frozen, approve: APPROVE_FORMS_PERMISSION };
  const [draft, setDraft] = useState<FormFilter>(EMPTY_FILTER);
  const [applied, setApplied] = useState<FormFilter>(EMPTY_FILTER);
  const [publishing, setPublishing] = useState<FormView | undefined>(undefined);
  const [creating, setCreating] = useState(false);
  const [done, setDone] = useState<string | undefined>(undefined);
  const forms = useForms(applied);
  const publish = usePublishForm();
  const today = vietnamToday();
  const rows = useMemo(() => forms.data ?? [], [forms.data]);
  // The state replaces the table, not the filters: a filter without revisions can still be changed.
  const state = useScreenState({ isLoading: forms.isLoading, error: forms.error, data: forms.data });
  const refused = publish.isError ? describeProblem(publish.error) : undefined;
  const awaiting = rows.filter((form) => form.awaitingConfirmation && form.status !== 'RETIRED').length;

  const submitFilter = (event: FormEvent): void => {
    event.preventDefault();
    setApplied(draft);
  };

  const openPublish = (form: FormView): void => {
    publish.reset();
    setDone(undefined);
    setCreating(false);
    setPublishing(form);
  };

  const columns = formColumns(t, today, context, openPublish);

  const confirmPublish = (event: FormEvent): void => {
    event.preventDefault();
    if (publishing === undefined || publish.isPending) return;
    const { formCode, revision } = publishing;
    publish.mutate({ formId: publishing.id, version: publishing.version }, { onSuccess: () => {
      setPublishing(undefined);
      setDone(t('mne.forms.publish.done.notice', { code: formCode, revision }));
    } });
  };

  const startCreate = (): void => {
    publish.reset();
    setDone(undefined);
    setPublishing(undefined);
    setCreating(true);
  };

  return (
    <section className="mne" data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('mne.forms.page.title')}</h1>
          <p>{t('mne.forms.page.subtitle')}</p>
        </div>
        {mayDraft ? (
          <button type="button" className="ui-button ui-button--primary" onClick={startCreate}>
            {t('mne.forms.create.open.action')}
          </button>
        ) : null}
      </div>
      <p className="callout">{t('mne.forms.rule.notice')}</p>
      {done === undefined ? null : (
        <p className="callout" role="status">
          {done}
        </p>
      )}
      <ContextBar
        items={[
          { label: t('mne.forms.ctx.scope'), value: tenant?.name ?? t('mne.forms.ctx.scope.all') },
          { label: t('mne.forms.ctx.count'), value: String(rows.length) },
        ]}
        {...(forms.dataUpdatedAt > 0 ? { asOf: new Date(forms.dataUpdatedAt).toLocaleString('vi-VN') } : {})}
      />
      <FilterPanel applied={(applied.reportKind === '' ? 0 : 1) + (applied.effectiveOn === '' ? 0 : 1)}>
        <form className="mne-filters" onSubmit={submitFilter} noValidate aria-label={t('mne.forms.filter.title')}>
          <div>
            <label htmlFor="form-kind">{t('mne.forms.filter.kind.label')}</label>
            <select id="form-kind" value={draft.reportKind} onChange={(event) => setDraft({ ...draft, reportKind: event.target.value as ReportKind | '' })}>
              <option value="">{t('mne.forms.filter.kind.all')}</option>
              {REPORT_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {reportKindLabel(t, kind)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="form-effective-on">{t('mne.forms.filter.effectiveOn.label')}</label>
            <input id="form-effective-on" type="date" value={draft.effectiveOn} onChange={(event) => setDraft({ ...draft, effectiveOn: event.target.value })} />
            <small className="sub">{t('mne.forms.filter.effectiveOn.hint')}</small>
          </div>
          <button type="submit" className="ui-button ui-button--outline">
            {t('mne.forms.filter.action')}
          </button>
        </form>
      </FilterPanel>
      {frozen ? (
        <p className="callout warning" role="status">
          {t('mne.forms.frozen.notice')}
        </p>
      ) : null}
      {awaiting === 0 ? null : (
        <p className="callout warning" role="status" data-testid="awaiting-banner">
          {t('mne.forms.awaiting.banner', { count: awaiting })}
        </p>
      )}
      <StateBoundary state={state} onRetry={() => void forms.refetch()}>
        <DataTable caption={t('mne.forms.table.aria')} columns={columns} rows={rows} rowKey={(form) => form.id} rowAttrs={(form) => ({ 'data-form-id': form.id, 'data-form-code': form.formCode, 'data-phase': phaseOf(form, today) })} />
        <p className="muted tiny mne-count" data-testid="count">
          {t('mne.forms.count.text', { count: rows.length })}
        </p>
      </StateBoundary>
      {publishing === undefined || frozen ? null : (
        <SectionCard title={t('mne.forms.publish.title', { code: publishing.formCode, revision: publishing.revision })}>
        <form onSubmit={confirmPublish} noValidate aria-label={t('mne.forms.publish.title', { code: publishing.formCode, revision: publishing.revision })}>
          <p className="sub">{t('mne.forms.publish.hint')}</p>
          {refused === undefined ? null : (
            <p className="callout warning" role="alert">
              {problemMessage(t, refused)}
            </p>
          )}
          <div className="row gap">
            <button type="submit" className="ui-button ui-button--primary" disabled={publish.isPending}>
              {t('mne.forms.publish.confirm.action')}
            </button>
            <button type="button" className="ui-button ui-button--outline" onClick={() => setPublishing(undefined)}>
              {t('mne.forms.publish.cancel.action')}
            </button>
          </div>
        </form>
        </SectionCard>
      )}
      {creating && mayDraft ? (
        <FormRevisionForm
          onCancel={() => setCreating(false)}
          onDone={(code) => {
            setCreating(false);
            setDone(t('mne.forms.create.done.notice', { code }));
          }}
        />
      ) : null}
      {/* The rules are read for someone who can read the catalogue: in the states of a refusal or a failure of the catalogue there is nothing to add them to. */}
      {state === 'default' || state === 'empty' ? <RulesPanel /> : null}
      <p className="prototype-note">{t('mne.forms.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

/** The columns of the catalogue: the code with its revision stays pinned, the lifecycle and the phase are pills, and the publish action is the last cell. */
function formColumns(t: Translate, today: string, context: Parameters<typeof actionsFor>[1], openPublish: (form: FormView) => void): DataTableColumn<FormView>[] {
  return [
    {
      key: 'code',
      header: t('mne.forms.col.code'),
      pinned: true,
      render: (form) => (
        <>
          <strong>{form.formCode}</strong> <StatusPill tone="neutral">{t('mne.forms.revision.pill', { revision: form.revision })}</StatusPill>
        </>
      ),
    },
    { key: 'name', header: t('mne.forms.col.name'), render: (form) => form.title },
    { key: 'kind', header: t('mne.forms.col.kind'), render: (form) => reportKindLabel(t, form.reportKind) },
    {
      key: 'legal',
      header: t('mne.forms.col.legal'),
      render: (form) => (
        <div className="mne-legal">
          <div>{form.legalBasis}</div>
          <div className="mne-badges">
            <ConfirmationLabel awaiting={form.awaitingConfirmation} cxnRefs={form.cxnRefs} reference={form.legalConfirmationRef} />
          </div>
          {form.awaitingConfirmation && form.watermarkText !== null ? <div className="sub">{t('mne.forms.watermark.text', { text: form.watermarkText })}</div> : null}
        </div>
      ),
    },
    {
      key: 'period',
      header: t('mne.forms.col.period'),
      render: (form) =>
        form.effectiveUntil === null
          ? t('mne.forms.period.open', { from: form.effectiveFrom })
          : t('mne.forms.period.closed', { from: form.effectiveFrom, until: lastDayOf(form.effectiveUntil) ?? '' }),
    },
    {
      key: 'template',
      header: t('mne.forms.col.template'),
      render: (form) =>
        form.docTemplateId === null ? (
          <>
            <code>{form.docTemplateCode}</code> <StatusPill tone="warning">{t('mne.forms.template.missing')}</StatusPill>
          </>
        ) : (
          <Link to={DOC_TEMPLATES_PATH} aria-label={t('mne.forms.template.link.label', { code: form.docTemplateCode })}>
            {form.docTemplateCode}
          </Link>
        ),
    },
    { key: 'formats', header: t('mne.forms.col.formats'), render: (form) => form.exportFormats.join(', ') },
    {
      key: 'status',
      header: t('mne.forms.col.status'),
      render: (form) => {
        const phase = phaseOf(form, today);
        return (
          <div className="mne-badges">
            <span data-lifecycle={form.status}>
              <StatusPill tone={formStatusTone(form.status)}>{formStatusLabel(t, form.status)}</StatusPill>
            </span>
            <StatusPill tone={phase === 'inForce' ? 'success' : 'neutral'}>{phaseLabel(t, phase)}</StatusPill>
          </div>
        );
      },
    },
    {
      key: 'actions',
      header: t('mne.forms.col.actions'),
      render: (form) => {
        const actions = actionsFor(form, context);
        return (
          <div className="mne-actions">
            {actions.publish ? (
              <button type="button" className="ui-button ui-button--outline ui-button--small" aria-label={t('mne.forms.publish.label', { code: form.formCode, revision: form.revision })} onClick={() => openPublish(form)}>
                {t('mne.forms.publish.action')}
              </button>
            ) : null}
            {actions.publishNeedsOther ? <span className="sub">{t('mne.forms.publish.other.hint')}</span> : null}
          </div>
        );
      },
    },
  ];
}
