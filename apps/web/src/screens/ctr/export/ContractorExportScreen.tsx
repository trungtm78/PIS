import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { CommandFrame } from '../../qms/CommandFrame';
import '../../qms/qms.css';
import { Field } from '../components';
import { vietnamDay } from '../guarantee-model';
import { useBatches, useExport, useIssueDownload, useMarkSubmitted } from './hooks';
import { formProblemMessage, problemMessage, scopeLabel, statusLabel } from './labels';
import { EXPORT_PERMISSION, FORMATS, SCOPES, describeProblem, emptyExport, emptySubmission, linkOf, shownError, validateExport, validateSubmission } from './model';
import type { Batch, ExportForm, Format, Scope, SubmissionForm } from './model';

/**
 * CTR-24: the export of the records of the contractors for the national database (ST-CTR-015, CTR 3.6, CXN-EXE-01). The approved evaluations and the confirmed violations of a period become one file; asking again for the same
 * records gives the same file. There is no interface to the national system, so the adapter says it is proposed and its API missing: the file is downloaded and submitted by hand, and the receipt number is written down here.
 */
export default function ContractorExportScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The form and the dialog belong to one membership: a switch of tenant or of membership starts the screen over.
  return <ExportContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ExportContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const canExport = permissions === undefined || permissions.includes(EXPORT_PERMISSION);
  const writable = mode !== 'READ_ONLY';
  const batches = useBatches(canExport);
  const first = batches.data?.pages[0];
  const state = useScreenState({
    isLoading: batches.isLoading,
    // A refresh that fails for a break in the network while there is something to show keeps it; a refusal takes it away.
    error: shownError(batches.error, batches.data !== undefined),
    data: batches.data === undefined ? undefined : first,
    isEmpty: (data: unknown) => data === null,
  });
  const view = first === null || first === undefined ? undefined : { adapter: first.adapter, items: (batches.data?.pages ?? []).flatMap((page) => page?.items ?? []) };
  const [submitting, setSubmitting] = useState<Batch | undefined>(undefined);

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('ctr.export.page.title')}</h1>
          <p>{t('ctr.export.page.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={canExport ? state : 'denied'} onRetry={() => void batches.refetch()}>
        {view === undefined ? null : (
          <>
            <p className="callout" role="note" data-testid="adapter">
              {t('ctr.export.adapter.notice', { state: view.adapter.state, api: view.adapter.api })}
            </p>
            {writable ? <RequestForm /> : null}
            <section className="card" aria-labelledby="batches-title">
              <h2 id="batches-title">{t('ctr.export.batches.title')}</h2>
              {view.items.length === 0 ? (
                <p className="callout" role="status" data-testid="no-batches">
                  {t('ctr.export.batches.empty')}
                </p>
              ) : null}
              {/* The columns of a batch stand before the first one: what each export will record is said by them. */}
              <Table items={view.items} writable={writable} onSubmit={setSubmitting} />
              {batches.hasNextPage ? (
                <button type="button" data-more disabled={batches.isFetchingNextPage} onClick={() => void batches.fetchNextPage()}>
                  {t('ctr.export.batches.more')}
                </button>
              ) : null}
            </section>
          </>
        )}
      </StateBoundary>
      {submitting === undefined ? null : <SubmitDialog batch={submitting} onClose={() => setSubmitting(undefined)} />}
      <p className="prototype-note">{t('ctr.export.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function RequestForm() {
  const { t } = useTranslation();
  const make = useExport();
  const [form, setForm] = useState<ExportForm>(emptyExport);
  const [submitted, setSubmitted] = useState(false);
  const problems = validateExport(form);
  const shown = (field: 'from' | 'to'): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined;
  };
  const set = (patch: Partial<ExportForm>): void => setForm({ ...form, ...patch });
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (make.isPending || Object.keys(problems).length > 0) return;
    make.mutate(form);
  };
  return (
    <form className="card" onSubmit={send} noValidate aria-label={t('ctr.export.form.aria')} data-testid="export-form">
      {make.isError ? (
        <p className="callout warning" role="alert" data-testid="refusal">
          {problemMessage(t, describeProblem(make.error))}
        </p>
      ) : null}
      {make.isSuccess ? (
        <p className="callout" role="status" data-testid="made">
          {t('ctr.export.form.done')}
        </p>
      ) : null}
      <Field id="export-scope" label={t('ctr.export.field.scope')} error={undefined}>
        <select id="export-scope" value={form.scope} onChange={(event) => set({ scope: event.target.value as Scope })}>
          {SCOPES.map((scope) => (
            <option key={scope} value={scope}>
              {scopeLabel(t, scope)}
            </option>
          ))}
        </select>
      </Field>
      <Field id="export-from" label={t('ctr.export.field.from')} error={shown('from')} hint={t('ctr.export.field.day.hint')}>
        <input id="export-from" autoComplete="off" value={form.from} onChange={(event) => set({ from: event.target.value })} />
      </Field>
      <Field id="export-to" label={t('ctr.export.field.to')} error={shown('to')}>
        <input id="export-to" autoComplete="off" value={form.to} onChange={(event) => set({ to: event.target.value })} />
      </Field>
      <Field id="export-format" label={t('ctr.export.field.format')} error={undefined}>
        <select id="export-format" value={form.format} onChange={(event) => set({ format: event.target.value as Format })}>
          {FORMATS.map((format) => (
            <option key={format} value={format}>
              {format}
            </option>
          ))}
        </select>
      </Field>
      <button type="submit" className="primary" disabled={make.isPending}>
        {t('ctr.export.form.submit')}
      </button>
    </form>
  );
}

function Table({ items, writable, onSubmit }: { items: readonly Batch[]; writable: boolean; onSubmit(batch: Batch): void }) {
  const { t } = useTranslation();
  const issue = useIssueDownload();
  const [link, setLink] = useState<{ id: string; url: string } | undefined>(undefined);
  const asked = (id: string): void => {
    setLink(undefined);
    issue.mutate(id, { onSuccess: (download) => setLink(download === undefined ? undefined : { id, url: linkOf(download.url, import.meta.env.VITE_API_BASE_URL ?? '') }) });
  };
  return (
    <>
      {issue.isError ? (
        <p className="callout warning" role="alert" data-testid="download-problem">
          {problemMessage(t, describeProblem(issue.error))}
        </p>
      ) : null}
      <div className="tablewrap">
      <table className="table" data-testid="batches">
        <thead>
          <tr>
            <th scope="col">{t('ctr.export.column.reach')}</th>
            <th scope="col">{t('ctr.export.column.fromTo')}</th>
            <th scope="col">{t('ctr.export.column.format')}</th>
            <th scope="col">{t('ctr.export.column.rows')}</th>
            <th scope="col">{t('ctr.export.column.sha')}</th>
            <th scope="col">{t('ctr.export.column.status')}</th>
            <th scope="col">{t('ctr.export.column.receipt')}</th>
            <th scope="col">
              <span className="sr-only">{t('ctr.export.column.actions')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((batch) => (
            <tr key={batch.id} data-batch={batch.id} data-status={batch.status}>
              <td data-testid="scope">{scopeLabel(t, batch.scope)}</td>
              <td data-testid="period">
                {batch.periodFrom} – {batch.periodTo}
              </td>
              <td data-testid="format">{batch.format}</td>
              <td data-testid="rows">{batch.rows}</td>
              <td>
                <code data-testid="sha" title={batch.sha256}>
                  {batch.sha256}
                </code>
              </td>
              <td>
                <span className={batch.status === 'GENERATED' ? 'qms-badge' : 'qms-badge ok'} data-testid="status">
                  {statusLabel(t, batch.status)}
                </span>
              </td>
              <td data-testid="receipt">{batch.submittedRef === undefined ? t('ctr.export.receipt.none') : `${batch.submittedRef} · ${batch.submittedOn ?? ''}`}</td>
              <td>
                <button type="button" data-download={batch.id} onClick={() => asked(batch.id)}>
                  {t('ctr.export.download.action')}
                </button>
                {link?.id === batch.id ? (
                  <a href={link.url} download data-testid="link">
                    {t('ctr.export.download.link')}
                  </a>
                ) : null}
                {writable && batch.status === 'GENERATED' ? (
                  <button type="button" data-submit={batch.id} onClick={() => onSubmit(batch)}>
                    {t('ctr.export.submit.action')}
                  </button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </>
  );
}

function SubmitDialog({ batch, onClose }: { batch: Batch; onClose(): void }) {
  const { t } = useTranslation();
  const mark = useMarkSubmitted();
  const today = vietnamDay(new Date());
  const [form, setForm] = useState<SubmissionForm>(() => emptySubmission(today));
  const [submitted, setSubmitted] = useState(false);
  const problems = validateSubmission(form, today);
  const shown = (field: 'reference' | 'day'): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined;
  };
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (mark.isPending || Object.keys(problems).length > 0) return;
    mark.mutate({ id: batch.id, form }, { onSuccess: onClose });
  };
  return (
    <CommandFrame
      title={t('ctr.export.submit.title', { from: batch.periodFrom, to: batch.periodTo })}
      refusal={mark.isError ? problemMessage(t, describeProblem(mark.error)) : undefined}
      pending={mark.isPending}
      submitLabel={t('ctr.export.submit.confirm')}
      words={{ close: t('ctr.export.dialog.close'), cancel: t('ctr.export.dialog.cancel'), pending: t('ctr.export.dialog.pending') }}
      onSubmit={send}
      onClose={onClose}
    >
      <p className="callout" role="note">
        {t('ctr.export.submit.hint')}
      </p>
      <Field id="submit-reference" label={t('ctr.export.field.reference')} error={shown('reference')}>
        <input id="submit-reference" autoComplete="off" value={form.reference} onChange={(event) => setForm({ ...form, reference: event.target.value })} />
      </Field>
      <Field id="submit-day" label={t('ctr.export.field.submittedOn')} error={shown('day')} hint={t('ctr.export.field.day.hint')}>
        <input id="submit-day" autoComplete="off" value={form.day} onChange={(event) => setForm({ ...form, day: event.target.value })} />
      </Field>
    </CommandFrame>
  );
}

