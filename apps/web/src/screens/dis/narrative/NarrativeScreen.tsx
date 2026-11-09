import { useState } from 'react';
import type { FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { ContextBar, SectionCard, StatusPill, StickyActions } from '../../../ui';
import { Field } from '../components';
import '../dis.css';
import '../rates/rates.css';
import { useReport, useSaveDraft } from '../report/hooks';
import { reportStatusLabel } from '../report/labels';
import { canEdit } from '../report/model';
import type { ReportDetail } from '../report/model';
import { statusTone } from '../report/weekly-model';
import { useInheritNarrative, useNarrativeContext } from './hooks';
import { FIELDS, FIELD_KEY, FIELD_MAX_CHARS, appendLine, bodyOf, formOf, problemOf, tooLong } from './model';
import type { DirectiveItem, NarrativeContext, NarrativeForm as Form } from './model';

/**
 * DIS-35: the structured narrative of a period (ENT-3b; HSKT DL.01, CN.02, CN.03). The person writes the eight fields of the form for one project and period, picks the standard causes from the list (MDM-17),
 * copies the words of the previous period (the server keeps a trace of the copy) and adds the results of the leadership directives of the period (DIR-05) to the words. Nothing is written for the person: a
 * directive line is added to the field the person chooses, and a field left empty stays empty. The approved entry rules are shown as they judge the draft now.
 */
export default function NarrativeScreen({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { tenant } = useSession();
  const [params] = useSearchParams();
  const reportId = params.get('report') ?? undefined;
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('ent3b.narr.page.title')}</h1>
          <p>{t('ent3b.narr.page.subtitle')}</p>
        </div>
      </div>
      {reportId === undefined ? (
        <p className="w2dis-banner w2dis-banner--info" role="status" data-testid="no-report">
          {t('ent3b.narr.noReport.note')}
        </p>
      ) : (
        <Content key={`${tenant?.id ?? 'none'}:${reportId}`} reportId={reportId} />
      )}
      <p className="prototype-note">{t('ent3b.narr.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function Content({ reportId }: { reportId: string }) {
  const { t } = useTranslation();
  const { permissions, mode, tenant } = useSession();
  const report = useReport(reportId);
  const context = useNarrativeContext(reportId);
  const state = useScreenState({ isLoading: report.isLoading || context.isLoading, error: report.error ?? context.error, data: report.data, isEmpty: (data) => data === undefined });
  const detail = report.data;
  return (
    <StateBoundary state={state} onRetry={() => void Promise.all([report.refetch(), context.refetch()])}>
      {detail === undefined || context.data === undefined ? null : (
        <div className="w2dis-stack">
          <ContextBar
            items={[
              { label: t('dis.wr.ctx.scope'), value: tenant?.name ?? t('dis.wr.ctx.scope.all') },
              { label: t('dis.reports.col.project'), value: `${detail.project.code} · ${detail.project.name}` },
              { label: t('dis.wr.ctx.period'), value: detail.period.code },
            ]}
          />
          <SectionCard title={t('ent3b.narr.card.title', { project: detail.project.code, period: detail.period.code })} status={<StatusPill tone={statusTone(detail.status)}>{reportStatusLabel(t, detail.status)}</StatusPill>}>
            <Editor key={`${detail.id}:${detail.version}`} detail={detail} context={context.data} editable={canEdit(permissions, mode, detail.status)} />
          </SectionCard>
        </div>
      )}
    </StateBoundary>
  );
}

function Editor({ detail, context, editable }: { detail: ReportDetail; context: NarrativeContext; editable: boolean }) {
  const { t } = useTranslation();
  const save = useSaveDraft();
  const inherit = useInheritNarrative();
  const [form, setForm] = useState<Form>(() => formOf(detail));
  const [submitted, setSubmitted] = useState(false);
  const long = tooLong(form);
  const refusal = save.isError ? problemOf(save.error) : inherit.isError ? problemOf(inherit.error) : undefined;
  const setField = (field: (typeof FIELDS)[number], value: string): void => setForm({ ...form, fields: { ...form.fields, [field]: value } });
  const toggleCause = (code: string): void => setForm({ ...form, causeCodes: form.causeCodes.includes(code) ? form.causeCodes.filter((one) => one !== code) : [...form.causeCodes, code] });
  const rollUp = (item: DirectiveItem): void => {
    if (form.directives.some((one) => one.id === item.id)) return;
    setForm({ ...form, fields: { ...form.fields, status: appendLine(form.fields.status, item.line) }, directives: [...form.directives, { id: item.id, code: item.code, statusAtEnd: item.statusAtEnd }] });
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (!editable || save.isPending || long.length > 0) return;
    save.mutate({ detail, body: bodyOf(detail, form) });
  };
  return (
    <form onSubmit={submit} noValidate aria-label={t('ent3b.narr.form.label')}>
      <div className="w2dis-stack">
        {editable ? null : (
          <p className="w2dis-banner w2dis-banner--info" role="status" data-testid="read-only">
            {t('ent3b.narr.readOnly.note')}
          </p>
        )}
        {refusal === undefined ? null : (
          <p className="w2dis-banner" role="alert" data-testid="refusal">
            {t(`ent3b.narr.problem.${refusal}`)}
          </p>
        )}
        {context.blocking.length === 0 ? null : (
          <ul className="w2dis-banner" role="alert" data-testid="blocking">
            {context.blocking.map((one) => (
              <li key={one.ruleCode}>{one.message}</li>
            ))}
          </ul>
        )}
        {context.warnings.length === 0 ? null : (
          <ul className="w2dis-banner w2dis-banner--info" role="status" data-testid="warnings">
            {context.warnings.map((one) => (
              <li key={one.ruleCode}>{one.message}</li>
            ))}
          </ul>
        )}
        <div className="w2dis-form-grid" data-testid="inheritance">
          {context.inheritance === null ? null : (
            <p role="status" data-testid="inherited">
              {t('ent3b.narr.inherited.note', { fields: context.inheritance.fields.length, unchanged: context.unchangedInherited.length })}
            </p>
          )}
          {context.previous === null ? (
            <p data-testid="no-previous">{t('ent3b.narr.previous.none')}</p>
          ) : (
            <>
              <p>{t('ent3b.narr.previous.note', { period: context.previous.periodCode, count: context.previous.fields.length })}</p>
              <button type="button" className="ui-button" disabled={!editable || inherit.isPending} onClick={() => inherit.mutate({ reportId: detail.id, version: detail.version })}>
                {inherit.isPending ? t('ent3b.narr.inherit.pending') : t('ent3b.narr.inherit.action')}
              </button>
            </>
          )}
        </div>
        {FIELDS.map((field) => (
          <Field key={field} id={`narr-${field}`} label={t(`ent3b.narr.field.${FIELD_KEY[field]}`)} error={submitted && long.includes(field) ? t('ent3b.narr.error.tooLong', { max: FIELD_MAX_CHARS }) : undefined}>
            <textarea id={`narr-${field}`} rows={4} value={form.fields[field]} readOnly={!editable} onChange={(event) => setField(field, event.target.value)} />
          </Field>
        ))}
        <fieldset data-testid="causes">
          <legend>{t('ent3b.narr.causes.title')}</legend>
          {context.causes.length === 0 ? <p>{t('ent3b.narr.causes.none')}</p> : null}
          {context.causes.map((cause) => (
            <label key={cause.code} className="w2dis-check">
              <input type="checkbox" checked={form.causeCodes.includes(cause.code)} disabled={!editable} onChange={() => toggleCause(cause.code)} /> {cause.label}
            </label>
          ))}
        </fieldset>
        <fieldset data-testid="directives">
          <legend>{t('ent3b.narr.directives.title')}</legend>
          {context.directives.length === 0 ? <p>{t('ent3b.narr.directives.none')}</p> : null}
          {context.directivesTruncated ? <p>{t('ent3b.narr.directives.truncated')}</p> : null}
          <ul>
            {context.directives.map((item) => (
              <li key={item.id}>
                {item.line}{' '}
                {form.directives.some((one) => one.id === item.id) ? (
                  <StatusPill tone="success">{t('ent3b.narr.directives.added')}</StatusPill>
                ) : (
                  <button type="button" className="ui-button" disabled={!editable} onClick={() => rollUp(item)}>
                    {t('ent3b.narr.directives.add')}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </fieldset>
        <StickyActions
          primary={
            <button type="submit" className="ui-button ui-button--primary" disabled={!editable || save.isPending}>
              {save.isPending ? t('ent3b.narr.save.pending') : t('ent3b.narr.save.action')}
            </button>
          }
        />
        {save.isSuccess ? (
          <p role="status" data-testid="saved">
            {t('ent3b.narr.save.done')}
          </p>
        ) : null}
      </div>
    </form>
  );
}
