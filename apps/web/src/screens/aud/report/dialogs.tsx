import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import { DialogFrame, Field, errorOf } from '../components';
import { conclusionFormProblemMessage } from '../conclusion/labels';
import { currentOf } from '../conclusion/model';
import type { ConclusionLine } from '../conclusion/model';
import { usePlaceOptions } from '../hooks';
import type { PlaceOption } from '../hooks';
import { todayInVietnam } from '../model';
import type { EngagementDetail } from '../model';
import { useCloseEngagement, useRequestReport } from './hooks';
import { reportProblemMessage } from './labels';
import { EMPTY_CLOSE_FORM, EMPTY_REQUEST_FORM, closeBody, describeReport, requestBody, scopeUnits, validateClose, validateRequest } from './model';
import type { CloseForm, RequestForm } from './model';

interface Mutation {
  isPending: boolean;
  isError: boolean;
  error: unknown;
}

/** The refusal a dialog shows once its command was refused, in words; none before. */
function refusalOf(t: ReturnType<typeof useTranslation>['t'], mutation: Mutation): string | undefined {
  if (!mutation.isError) return undefined;
  const described = describeReport(mutation.error);
  return reportProblemMessage(t, described.problem, described.open);
}

const conclusionLabel = (conclusion: ConclusionLine): string => `${conclusion.document.symbol ?? conclusion.document.title} (${conclusion.issuedOn})`;

/**
 * The request for the report of the results: the conclusion it is about, the day the figures are as of, the place of issue and the unit that drafts it. The figures are computed by the server
 * and frozen with the report; DOC is asked to issue it with the template of the library and the hash of the payload. A conclusion that was replaced is not offered.
 */
export function RequestDialog({ engagement, conclusions, onClose }: { engagement: EngagementDetail; conclusions: readonly ConclusionLine[]; onClose(): void }) {
  const { t } = useTranslation();
  const request = useRequestReport();
  const today = todayInVietnam();
  const offered = conclusions.filter((line) => line.status !== 'SUPERSEDED');
  const units = scopeUnits(engagement.scope);
  // The units the engagement is about draft its report; an engagement about projects or contracts only has none, and then every unit the caller may read is offered.
  const everyUnit = usePlaceOptions('UNIT', units.length === 0);
  const options: readonly PlaceOption[] = units.length > 0 ? units.map((unit) => ({ id: unit.id, code: unit.code, name: unit.name })) : (everyUnit.data ?? []);
  const [form, setForm] = useState<RequestForm>({
    ...EMPTY_REQUEST_FORM,
    asOfDate: today,
    conclusionId: currentOf(offered)?.id ?? '',
    draftingUnitId: units.length === 1 ? (units[0]?.id ?? '') : '',
  });
  const [submitted, setSubmitted] = useState(false);
  const chosen = offered.find((line) => line.id === form.conclusionId);
  const problems = validateRequest(form, { today, receivedOn: chosen?.receivedOn });
  const error = (field: keyof RequestForm): string | undefined => errorOf(problems, submitted, field, (problem) => conclusionFormProblemMessage(t, problem));
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (request.isPending || Object.keys(problems).length > 0) return;
    request.mutate({ id: engagement.id, version: engagement.version, body: requestBody(form) }, { onSuccess: onClose });
  };
  return (
    <DialogFrame title={t('aud.report.request.title')} onClose={onClose} refusal={refusalOf(t, request)} pending={request.isPending} onSubmit={submit}>
      <p className="wide" data-testid="request-note">
        {t('aud.report.request.note')}
      </p>
      <Field id="report-conclusion" label={t('aud.report.request.conclusion.label')} error={error('conclusionId')}>
        <select id="report-conclusion" value={form.conclusionId} onChange={(event) => setForm({ ...form, conclusionId: event.target.value })}>
          <option value="">{t('aud.report.request.conclusion.choose')}</option>
          {offered.map((line) => (
            <option key={line.id} value={line.id}>
              {conclusionLabel(line)}
            </option>
          ))}
        </select>
      </Field>
      <Field id="report-as-of" label={t('aud.report.request.asOf.label')} error={error('asOfDate')} hint={t('aud.report.request.asOf.help')}>
        <input id="report-as-of" type="date" max={today} min={chosen?.receivedOn} value={form.asOfDate} onChange={(event) => setForm({ ...form, asOfDate: event.target.value })} />
      </Field>
      <Field id="report-place" label={t('aud.report.request.place.label')} error={error('place')} hint={t('aud.report.request.place.help')}>
        <input id="report-place" maxLength={100} value={form.place} onChange={(event) => setForm({ ...form, place: event.target.value })} />
      </Field>
      <Field id="report-unit" label={t('aud.report.request.unit.label')} error={error('draftingUnitId')} hint={t('aud.report.request.unit.help')}>
        <select id="report-unit" value={form.draftingUnitId} onChange={(event) => setForm({ ...form, draftingUnitId: event.target.value })}>
          <option value="">{t('aud.report.request.unit.choose')}</option>
          {options.map((unit) => (
            <option key={unit.id} value={unit.id}>
              {unit.name === '' ? unit.code : unit.name}
            </option>
          ))}
        </select>
      </Field>
    </DialogFrame>
  );
}

/** The closure of the engagement: the day, and a word on what it does (the hold of the engagement is released, nothing is deleted). */
export function CloseDialog({ engagement, onClose }: { engagement: EngagementDetail; onClose(): void }) {
  const { t } = useTranslation();
  const close = useCloseEngagement();
  const today = todayInVietnam();
  const [form, setForm] = useState<CloseForm>({ ...EMPTY_CLOSE_FORM, onDate: today });
  const [submitted, setSubmitted] = useState(false);
  const problems = validateClose(form, { today, startedOn: engagement.startedOn });
  const error = (field: keyof CloseForm): string | undefined => errorOf(problems, submitted, field, (problem) => conclusionFormProblemMessage(t, problem));
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (close.isPending || Object.keys(problems).length > 0) return;
    close.mutate({ id: engagement.id, version: engagement.version, body: closeBody(form) }, { onSuccess: onClose });
  };
  return (
    <DialogFrame title={t('aud.closure.title', { code: engagement.code })} onClose={onClose} refusal={refusalOf(t, close)} pending={close.isPending} onSubmit={submit}>
      <p className="wide" data-testid="closure-note">
        {t('aud.closure.note')}
      </p>
      <Field id="closure-day" label={t('aud.closure.day.label')} error={error('onDate')}>
        <input id="closure-day" type="date" max={today} min={engagement.startedOn ?? undefined} value={form.onDate} onChange={(event) => setForm({ ...form, onDate: event.target.value })} />
      </Field>
    </DialogFrame>
  );
}
