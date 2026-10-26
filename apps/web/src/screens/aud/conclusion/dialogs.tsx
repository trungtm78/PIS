import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import { DialogFrame, Field, errorOf } from '../components';
import { scopeKindLabel } from '../labels';
import type { ScopeItem } from '../model';
import { useCreateRecommendation, useRecordFinding } from './hooks';
import { conclusionFormProblemMessage, conclusionProblemMessage, findingCategoryLabel, findingSeverityLabel, recommendationTypeLabel } from './labels';
import {
  EMPTY_FINDING_FORM,
  EMPTY_RECOMMENDATION_FORM,
  FINDING_CATEGORIES,
  FINDING_SEVERITIES,
  RECOMMENDATION_TYPES,
  describeProblem,
  findingBody,
  formatVnd,
  isFinancial,
  placeChoiceOf,
  recommendationBody,
  validateFinding,
  validateRecommendation,
} from './model';
import type { ConclusionLine, FindingForm, FindingLine, PlaceChoice, RecommendationForm } from './model';

/** A finding of a conclusion: its code, its group and weight, the place of the engagement it is about, what was found, the rule it breaks and the amount it concerns. */
export function FindingDialog({ conclusion, scope, onClose }: { conclusion: ConclusionLine; scope: readonly ScopeItem[]; onClose(): void }) {
  const { t } = useTranslation();
  const record = useRecordFinding();
  const [form, setForm] = useState<FindingForm>(EMPTY_FINDING_FORM);
  const [submitted, setSubmitted] = useState(false);
  const problems = validateFinding(form);
  const error = (field: keyof FindingForm): string | undefined => errorOf(problems, submitted, field, (problem) => conclusionFormProblemMessage(t, problem));
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (record.isPending || Object.keys(problems).length > 0) return;
    record.mutate({ conclusionId: conclusion.id, body: findingBody(form) }, { onSuccess: onClose });
  };
  const failure = record.isError ? describeProblem(record.error) : undefined;
  return (
    <DialogFrame
      title={t('aud.finding.dialog.title')}
      onClose={onClose}
      refusal={failure === undefined ? undefined : conclusionProblemMessage(t, failure.problem, failure.remainingVnd)}
      pending={record.isPending}
      onSubmit={submit}
    >
      <Field id="finding-code" label={t('aud.finding.dialog.code.label')} error={error('code')}>
        <input id="finding-code" value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value })} />
      </Field>
      <Field id="finding-category" label={t('aud.finding.dialog.category.label')} error={error('category')}>
        <select id="finding-category" value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value as FindingForm['category'] })}>
          <option value="">{t('aud.finding.dialog.category.choose')}</option>
          {FINDING_CATEGORIES.map((category) => (
            <option key={category} value={category}>
              {findingCategoryLabel(t, category)}
            </option>
          ))}
        </select>
      </Field>
      <Field id="finding-severity" label={t('aud.finding.dialog.severity.label')} error={error('severity')}>
        <select id="finding-severity" value={form.severity} onChange={(event) => setForm({ ...form, severity: event.target.value as FindingForm['severity'] })}>
          <option value="">{t('aud.finding.dialog.severity.choose')}</option>
          {FINDING_SEVERITIES.map((severity) => (
            <option key={severity} value={severity}>
              {findingSeverityLabel(t, severity)}
            </option>
          ))}
        </select>
      </Field>
      <Field id="finding-place" label={t('aud.finding.dialog.place.label')} error={error('place')} hint={t('aud.finding.dialog.place.help')}>
        <select id="finding-place" value={form.place} onChange={(event) => setForm({ ...form, place: event.target.value as PlaceChoice })}>
          <option value="">{t('aud.finding.dialog.place.none')}</option>
          {scope.map((item) => (
            <option key={placeChoiceOf(item)} value={placeChoiceOf(item)}>
              {`${scopeKindLabel(t, item.kind)} · ${item.code}`}
            </option>
          ))}
        </select>
      </Field>
      <Field id="finding-amount" label={t('aud.finding.dialog.amount.label')} error={error('amountVnd')} hint={t('aud.finding.dialog.amount.help')}>
        <input id="finding-amount" inputMode="numeric" value={form.amountVnd} onChange={(event) => setForm({ ...form, amountVnd: event.target.value })} />
      </Field>
      <div className="wide">
        <Field id="finding-description" label={t('aud.finding.dialog.description.label')} error={error('description')}>
          <textarea id="finding-description" rows={4} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} />
        </Field>
      </div>
      <div className="wide">
        <Field id="finding-legal-basis" label={t('aud.finding.dialog.legalBasis.label')} error={error('legalBasis')}>
          <textarea id="finding-legal-basis" rows={2} value={form.legalBasis} onChange={(event) => setForm({ ...form, legalBasis: event.target.value })} />
        </Field>
      </div>
    </DialogFrame>
  );
}

/**
 * A recommendation on a conclusion. A financial one names an amount that fits in what is left of the total of the conclusion (BR-AUD-05): the dialog says what is left, and an amount above
 * it is refused before it is sent; the server checks the same again, so two at once cannot both fit.
 */
export function RecommendationDialog({ conclusion, findings, onClose }: { conclusion: ConclusionLine; findings: readonly FindingLine[]; onClose(): void }) {
  const { t } = useTranslation();
  const create = useCreateRecommendation();
  const [form, setForm] = useState<RecommendationForm>(EMPTY_RECOMMENDATION_FORM);
  const [submitted, setSubmitted] = useState(false);
  const problems = validateRecommendation(form, conclusion.shortfallVnd);
  const error = (field: keyof RecommendationForm): string | undefined => errorOf(problems, submitted, field, (problem) => conclusionFormProblemMessage(t, problem));
  const financial = form.type !== '' && isFinancial(form.type);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (create.isPending || Object.keys(problems).length > 0) return;
    create.mutate({ conclusionId: conclusion.id, body: recommendationBody(form) }, { onSuccess: onClose });
  };
  const failure = create.isError ? describeProblem(create.error) : undefined;
  return (
    <DialogFrame
      title={t('aud.recommendation.dialog.title')}
      onClose={onClose}
      refusal={failure === undefined ? undefined : conclusionProblemMessage(t, failure.problem, failure.remainingVnd)}
      pending={create.isPending}
      onSubmit={submit}
    >
      <Field id="recommendation-code" label={t('aud.recommendation.dialog.code.label')} error={error('code')}>
        <input id="recommendation-code" value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value })} />
      </Field>
      <Field id="recommendation-type" label={t('aud.recommendation.dialog.type.label')} error={error('type')}>
        <select id="recommendation-type" value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value as RecommendationForm['type'] })}>
          <option value="">{t('aud.recommendation.dialog.type.choose')}</option>
          {RECOMMENDATION_TYPES.map((type) => (
            <option key={type} value={type}>
              {recommendationTypeLabel(t, type)}
            </option>
          ))}
        </select>
      </Field>
      {financial ? (
        <Field
          id="recommendation-amount"
          label={t('aud.recommendation.dialog.amount.label')}
          error={error('amountVnd')}
          hint={t('aud.recommendation.dialog.amount.remaining', { remaining: formatVnd(conclusion.shortfallVnd) })}
        >
          <input id="recommendation-amount" inputMode="numeric" value={form.amountVnd} onChange={(event) => setForm({ ...form, amountVnd: event.target.value })} />
        </Field>
      ) : null}
      <Field id="recommendation-finding" label={t('aud.recommendation.dialog.finding.label')} error={error('findingId')}>
        <select id="recommendation-finding" value={form.findingId} onChange={(event) => setForm({ ...form, findingId: event.target.value })}>
          <option value="">{t('aud.recommendation.dialog.finding.none')}</option>
          {findings.map((finding) => (
            <option key={finding.id} value={finding.id}>
              {finding.code}
            </option>
          ))}
        </select>
      </Field>
      <div className="wide">
        <Field id="recommendation-description" label={t('aud.recommendation.dialog.description.label')} error={error('description')}>
          <textarea id="recommendation-description" rows={4} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} />
        </Field>
      </div>
    </DialogFrame>
  );
}
