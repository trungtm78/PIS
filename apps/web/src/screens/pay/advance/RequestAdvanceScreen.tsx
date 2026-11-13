import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { Translator } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { useLineChoices } from '../../bid/plan-hooks';
import { BackLink, Fact, Field } from '../../ctr/components';
import { useGuarantees } from '../../ctr/guarantee-hooks';
import { useContract, useContracts } from '../../ctr/hooks';
import { formProblemMessage } from '../payment/labels';
import { useAdvances, useRequestAdvance } from './hooks';
import { kindLabel } from './labels';
import { KINDS, LIST_PATH, REQUEST_PERMISSION, listLink, signedAmountText } from './model';
import { EMPTY_REQUEST, describeRequestRefusal, requestBody, toRequested, validateRequest } from './request-model';
import type { GuaranteeReason, RequestForm, RequestRefusal, Requested } from './request-model';
import '../pay.css';
import { StickyActions } from '../../../ui';

type T = Translator['t'];

function reasonText(t: T, reason: GuaranteeReason | null): string {
  switch (reason) {
    case 'NO_GUARANTEE':
      return t('pay.request.reason.none');
    case 'NOT_FOUND':
      return t('pay.request.reason.notFound');
    case 'NOT_VERIFIED':
      return t('pay.request.reason.notVerified');
    case 'NOT_ACTIVE':
      return t('pay.request.reason.notActive');
    case 'EXPIRED':
      return t('pay.request.reason.expired');
    case 'TOO_SMALL':
      return t('pay.request.reason.tooSmall');
    case 'OTHER_MEMBER':
      return t('pay.request.reason.otherMember');
    case null:
      return t('pay.request.reason.unknown');
  }
}

function refusalText(t: T, refusal: RequestRefusal, money: (value: string) => string): string {
  switch (refusal.problem) {
    case 'contractNotEffective':
      return t('pay.request.error.contractNotEffective');
    case 'guaranteeRequired':
      return t('pay.request.error.guaranteeRequired', { reason: reasonText(t, refusal.reason) });
    case 'capExceeded':
      return t('pay.request.error.capExceeded', { cap: refusal.capVnd === null ? '' : money(refusal.capVnd) });
    case 'ruleUnconfirmed':
      return t('pay.request.error.ruleUnconfirmed');
    case 'outstandingPrior':
      return t('pay.request.error.outstandingPrior');
    case 'valueExceeded':
      return t('pay.request.error.valueExceeded');
    case 'validation':
      return t('pay.request.error.validation');
    case 'notFound':
      return t('pay.request.error.notFound');
    case 'denied':
      return t('pay.request.error.denied');
    case 'session':
      return t('pay.request.error.session');
    case 'general':
      return t('pay.request.error.general');
  }
}

/**
 * PAY-11: ask for an advance on a contract in force (ST-PAY-004, ST-PAY-011, PAY 3.2 step 1). The person chooses the contract, the member it is paid to, the kind, the amount and the line of capital. The guarantee that covers
 * a contract advance and the cap the rule of the day gives the work of the member are found by the server, which says why it refuses when it does and shows the cap once the advance is planned; the screen takes neither. The
 * rule of the cap that still waits for its confirmation (CXN-02) is told. Cancelling a planned advance is done from PAY-07.
 */
export default function RequestAdvanceScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The form belongs to one membership: a switch of tenant or of membership starts the screen over.
  return <RequestAdvanceContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function RequestAdvanceContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { permissions, mode } = useSession();
  const [search] = useSearchParams();
  const [form, setForm] = useState<RequestForm>({ ...EMPTY_REQUEST, contractId: search.get('contract') ?? '' });
  const [submitted, setSubmitted] = useState(false);
  const [done, setDone] = useState<Requested | undefined>(undefined);
  const request = useRequestAdvance();
  const contracts = useContracts();
  const detail = useContract(form.contractId === '' ? null : form.contractId);
  const lines = useLineChoices();
  const contract = (contracts.data ?? []).find((candidate) => candidate.id === form.contractId);
  const parties = detail.data?.parties ?? [];
  const ofProject = (lines.data ?? []).filter((line) => contract !== undefined && line.projectId === contract.projectId);
  // What the form may not take but the person must see before asking: the cap and the advance guarantee of the contract (the server checks both again).
  const advances = useAdvances({ contractId: form.contractId === '' ? null : form.contractId });
  const guarantees = useGuarantees();
  const problems = validateRequest(form);
  const shown = (field: keyof RequestForm): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined;
  };
  const money = (value: string): string => signedAmountText(value, locale) ?? value;
  const set = (patch: Partial<RequestForm>): void => {
    setForm({ ...form, ...patch });
    setDone(undefined);
  };
  /** The cap the server gave: on the advance just planned, on the refusal of an amount above it, or on an earlier advance of the same member of the contract. */
  const capText = (): string => {
    const refusal = request.isError ? describeRequestRefusal(request.error) : undefined;
    if (refusal?.capVnd !== undefined && refusal.capVnd !== null) return money(refusal.capVnd);
    if (done !== undefined) return done.capPct === null ? money(done.capVnd) : t('scr2.pay.request.cap.value', { cap: money(done.capVnd), pct: done.capPct });
    if (form.contractId === '') return t('scr2.pay.request.chooseContract');
    const earlier = (advances.data ?? []).find((advance) => advance.status !== 'CANCELLED' && (form.partyId === '' || advance.party.id === form.partyId));
    if (earlier === undefined) return t('scr2.pay.request.cap.byServer');
    return earlier.capPct === null ? money(earlier.capVnd) : t('scr2.pay.request.cap.value', { cap: money(earlier.capVnd), pct: earlier.capPct });
  };
  /** The advance guarantees of the chosen contract that are in force (CTR-05): number, issuer, amount and expiry. */
  const guaranteeText = (): string => {
    if (form.contractId === '') return t('scr2.pay.request.chooseContract');
    if (guarantees.isError) return t('scr2.pay.request.guarantee.unreadable');
    if (guarantees.isLoading) return t('scr2.pay.request.loading');
    const held = (guarantees.data ?? []).filter((guarantee) => guarantee.contractId === form.contractId && guarantee.kind === 'ADVANCE' && guarantee.status === 'ACTIVE');
    if (held.length === 0) return t('scr2.pay.request.guarantee.none');
    return held.map((guarantee) => t('scr2.pay.request.guarantee.value', { no: guarantee.guaranteeNo ?? '', issuer: guarantee.issuer, amount: money(guarantee.amountVnd), expires: guarantee.expiresOn })).join('; ');
  };
  const may = (permissions === undefined || permissions.includes(REQUEST_PERMISSION)) && mode !== 'READ_ONLY';
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (!may || request.isPending || Object.keys(problems).length > 0) return;
    request.mutate(
      { contractId: form.contractId, body: requestBody(form) },
      {
        onSuccess: (answer) => {
          setDone(toRequested(answer));
          setForm({ ...EMPTY_REQUEST, contractId: form.contractId });
          setSubmitted(false);
        },
      },
    );
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <BackLink to={LIST_PATH}>{t('pay.request.back')}</BackLink>
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('pay.request.title')}</h1>
          <p>{t('pay.request.subtitle')}</p>
        </div>
      </div>
      {done === undefined ? null : (
        <article className="card" role="status" data-testid="requested">
          <p>{t('pay.request.done', { amount: money(done.amountVnd), cap: money(done.capVnd), pct: done.capPct ?? '' })}</p>
          {done.ruleAwaitingConfirmation ? (
            <p className="callout warning" data-testid="rule-waits">
              {t('pay.request.ruleWaits')}
            </p>
          ) : null}
          <Link to={listLink(form.contractId === '' ? undefined : form.contractId)} data-testid="to-list">
            {t('pay.request.toList')}
          </Link>
        </article>
      )}
      <form className="card" onSubmit={send} noValidate aria-label={t('pay.request.form')}>
        {request.isError ? (
          <p className="callout warning" role="alert" data-testid="refusal">
            {refusalText(t, describeRequestRefusal(request.error), money)}
          </p>
        ) : null}
        <div className="pay-form-grid">
          <Field id="request-contract" label={t('pay.request.field.contract')} error={shown('contractId')}>
            <select id="request-contract" value={form.contractId} onChange={(event) => set({ contractId: event.target.value, partyId: '', allocationLineId: '' })}>
              <option value="">{t('pay.advance.field.choose')}</option>
              {(contracts.data ?? [])
                .filter((candidate) => candidate.status === 'ACTIVE')
                .map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.code}
                  </option>
                ))}
            </select>
          </Field>
          <Field id="request-party" label={t('pay.request.field.party')} error={shown('partyId')}>
            <select id="request-party" value={form.partyId} onChange={(event) => set({ partyId: event.target.value })}>
              <option value="">{t('pay.advance.field.choose')}</option>
              {parties.map((party) => (
                <option key={party.id} value={party.id}>
                  {party.contractorName ?? party.role}
                </option>
              ))}
            </select>
          </Field>
          <Field id="request-kind" label={t('pay.request.field.kind')} error={shown('kind')}>
            <select id="request-kind" value={form.kind} onChange={(event) => set({ kind: KINDS.find((kind) => kind === event.target.value) ?? '' })}>
              <option value="">{t('pay.advance.field.choose')}</option>
              {KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {kindLabel(t, kind)}
                </option>
              ))}
            </select>
          </Field>
          <Field id="request-amount" label={t('pay.request.field.amount')} error={shown('amount')} hint={t('pay.request.field.amount.hint')}>
            <input id="request-amount" inputMode="numeric" autoComplete="off" value={form.amount} onChange={(event) => set({ amount: event.target.value })} />
          </Field>
          <Field id="request-line" label={t('pay.request.field.line')} error={shown('allocationLineId')} hint={t('pay.request.field.line.hint')}>
            <select id="request-line" value={form.allocationLineId} onChange={(event) => set({ allocationLineId: event.target.value })}>
              <option value="">{t('pay.advance.field.choose')}</option>
              {ofProject.map((line) => (
                <option key={line.id} value={line.id}>
                  {line.label}
                </option>
              ))}
            </select>
          </Field>
          <Field id="request-tranche" label={t('pay.request.field.tranche')} error={shown('trancheNo')} hint={t('pay.request.field.tranche.hint')}>
            <input id="request-tranche" inputMode="numeric" autoComplete="off" value={form.trancheNo} onChange={(event) => set({ trancheNo: event.target.value })} />
          </Field>
        </div>
        <dl className="pay-facts" data-testid="request-basis">
          <Fact label={t('scr2.pay.request.cap')}>
            <span data-testid="request-cap">{capText()}</span>
          </Fact>
          <Fact label={t('scr2.pay.request.guarantee')}>
            <span data-testid="request-guarantee">{guaranteeText()}</span>
          </Fact>
        </dl>
        <StickyActions
          primary={
            <button type="submit" className="ui-button ui-button--primary" disabled={!may || request.isPending}>
              {t('pay.request.submit')}
            </button>
          }
        />
      </form>
      <p className="prototype-note">{t('pay.request.footer', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
