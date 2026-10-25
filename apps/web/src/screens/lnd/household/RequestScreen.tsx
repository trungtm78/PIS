import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { BackLink } from '../../ctr/components';
import { Field } from '../components';
import { useHandleRequest, useHouseholds } from './hooks';
import { commandProblemMessage, formProblemMessage, householdStatusLabel, legalBasisLabel, requestKindHelp, requestKindLabel, requestOutcomeLabel } from './labels';
import { EMPTY_REQUEST_FORM, HOUSEHOLDS_PATH, REQUEST_KINDS, REQUEST_OUTCOMES, canHandleRequests, describeProblem, requestBody, validateRequest } from './model';
import type { HouseholdLine, RequestForm, RequestKind, RequestOutcome } from './model';
import '../lnd.css';

interface Handled {
  kind: RequestKind;
  outcome: RequestOutcome;
}

/**
 * LND-13: a request of a person whose data a household holds (ST-LND-003, UAT-AC381). The data protection officer says who asked (and that the person was identified), what is asked, the outcome and the
 * reason. The page says what each kind does to the household before it is sent: an access and a rectification are recorded, a restriction stops the sealed data being opened, a withdrawal of consent
 * erases the optional data, and an erasure anonymises the household, unless a payment was made to it, whose voucher has to be kept. The server judges every request again.
 */
export default function RequestScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The household and the form belong to one membership: a switch of tenant or of membership starts the screen over.
  return <RequestContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function RequestContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const [params] = useSearchParams();
  const projectId = params.get('project') ?? undefined;
  const householdId = params.get('household');
  const households = useHouseholds(projectId);
  const household = households.data?.find((line) => line.id === householdId);
  const state = useScreenState({ isLoading: households.isLoading, error: households.error, data: households.data, isEmpty: () => household === undefined });
  const back = projectId === undefined ? HOUSEHOLDS_PATH : `${HOUSEHOLDS_PATH}?project=${projectId}`;

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <BackLink to={back}>{t('lnd.dataRequest.back.list')}</BackLink>
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('lnd.dataRequest.page.title')}</h1>
          <p>{t('lnd.dataRequest.page.subtitle')}</p>
        </div>
      </div>
      <p className="callout" data-testid="privacy-note">
        {t('lnd.dataRequest.privacy.note')}
      </p>
      {projectId === undefined || householdId === null ? (
        <p className="callout" role="status" data-testid="choose-household">
          {t('lnd.dataRequest.none.notice')} <Link to={back}>{t('lnd.dataRequest.none.link')}</Link>
        </p>
      ) : (
        <StateBoundary state={state} onRetry={() => void households.refetch()}>
          {household === undefined ? null : <Request household={household} writable={canHandleRequests(permissions, mode)} />}
        </StateBoundary>
      )}
      <p className="prototype-note">{t('lnd.dataRequest.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function Request({ household, writable }: { household: HouseholdLine; writable: boolean }) {
  const { t } = useTranslation();
  const handle = useHandleRequest();
  const [form, setForm] = useState<RequestForm>(EMPTY_REQUEST_FORM);
  const [submitted, setSubmitted] = useState(false);
  const [handled, setHandled] = useState<Handled | undefined>(undefined);
  const problems = validateRequest(form);
  const error = (field: keyof RequestForm): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined;
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (handle.isPending || Object.keys(problems).length > 0) return;
    const sent = { kind: form.requestKind as RequestKind, outcome: form.outcome as RequestOutcome };
    handle.mutate(
      { householdId: household.id, body: requestBody(form) },
      {
        onSuccess: () => {
          setHandled(sent);
          setForm(EMPTY_REQUEST_FORM);
          setSubmitted(false);
        },
      },
    );
  };
  return (
    <>
      <div className="card" data-testid="household">
        <dl className="lnd-identity">
          <dt>{t('lnd.dataRequest.household.code')}</dt>
          <dd data-testid="household-code">{household.householdCode}</dd>
          <dt>{t('lnd.dataRequest.household.head')}</dt>
          <dd data-testid="household-head">{household.headNameMasked}</dd>
          <dt>{t('lnd.dataRequest.household.basis')}</dt>
          <dd data-testid="household-basis">{legalBasisLabel(t, household.legalBasis)}</dd>
          <dt>{t('lnd.dataRequest.household.retention')}</dt>
          <dd data-testid="household-retention">{household.retentionUntil}</dd>
          <dt>{t('lnd.dataRequest.household.status')}</dt>
          <dd>
            <span className="lnd-badge" data-testid="household-status">
              {householdStatusLabel(t, household.status)}
            </span>
            {household.processingRestricted ? (
              <span className="lnd-badge warning" data-testid="household-restricted">
                {t('lnd.households.restricted.badge')}
              </span>
            ) : null}
            {household.anonymised ? (
              <span className="lnd-badge warning" data-testid="household-anonymised">
                {t('lnd.households.anonymised.badge')}
              </span>
            ) : null}
          </dd>
        </dl>
      </div>
      {handled === undefined ? null : (
        <p className="callout" role="status" data-testid="handled">
          {t('lnd.dataRequest.handled.text', { kind: requestKindLabel(t, handled.kind), outcome: requestOutcomeLabel(t, handled.outcome) })}
        </p>
      )}
      {writable ? (
        <form className="card" onSubmit={submit} noValidate aria-label={t('lnd.dataRequest.form.title')}>
          {handle.isError ? (
            <p className="callout warning" role="alert" data-testid="refusal">
              {commandProblemMessage(t, describeProblem(handle.error))}
            </p>
          ) : null}
          <div className="formgrid">
            <Field id="request-kind" label={t('lnd.dataRequest.form.kind.label')} error={error('requestKind')} hint={form.requestKind === '' ? undefined : requestKindHelp(t, form.requestKind)}>
              <select id="request-kind" value={form.requestKind} onChange={(event) => setForm({ ...form, requestKind: event.target.value as RequestForm['requestKind'] })}>
                <option value="">{t('lnd.dataRequest.form.kind.choose')}</option>
                {REQUEST_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {requestKindLabel(t, kind)}
                  </option>
                ))}
              </select>
            </Field>
            <Field id="request-verified" label={t('lnd.dataRequest.form.verified.label')} error={error('requesterVerified')} hint={t('lnd.dataRequest.form.verified.help')}>
              <input id="request-verified" type="checkbox" checked={form.requesterVerified} onChange={(event) => setForm({ ...form, requesterVerified: event.target.checked })} />
            </Field>
            <Field id="request-outcome" label={t('lnd.dataRequest.form.outcome.label')} error={error('outcome')}>
              <select id="request-outcome" value={form.outcome} onChange={(event) => setForm({ ...form, outcome: event.target.value as RequestForm['outcome'] })}>
                <option value="">{t('lnd.dataRequest.form.outcome.choose')}</option>
                {REQUEST_OUTCOMES.map((outcome) => (
                  <option key={outcome} value={outcome}>
                    {requestOutcomeLabel(t, outcome)}
                  </option>
                ))}
              </select>
            </Field>
            <Field id="request-reason" label={t('lnd.dataRequest.form.reason.label')} error={error('reason')} hint={t('lnd.dataRequest.form.reason.help')}>
              <input id="request-reason" autoComplete="off" value={form.reason} onChange={(event) => setForm({ ...form, reason: event.target.value })} />
            </Field>
          </div>
          <div className="formfooter">
            <button type="submit" className="primary" disabled={handle.isPending}>
              {handle.isPending ? t('lnd.dialog.submit.pending') : t('lnd.dataRequest.form.submit.action')}
            </button>
          </div>
        </form>
      ) : (
        <p className="callout" role="status" data-testid="request-denied">
          {t('lnd.dataRequest.denied.notice')}
        </p>
      )}
    </>
  );
}
