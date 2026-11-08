import { describe, expect, it } from 'vitest';
import { ApiError } from '@machvon/api-client';
import { camel, daysProblem, dayText, describeProblem, isDay, stateTone, textProblem, vnd } from './common';
import { EMPTY_FILTER, copyTemplate, emptyRegister, emptyStep, emptyTerm, isFiltered, linksBody, periodsOf, queryOf, registerBody, stepBody, termBody, validateLinks, validateRegister, validateStep, validateTerm } from './model';
import type { ClaimTermTemplate } from './model';

const TODAY = '2026-11-08';
const problem = (code: string, detail?: string) => new ApiError({ status: 409, code, correlationId: 'c', extensions: {}, ...(detail === undefined ? {} : { detail }) });

describe('the words the registers share', () => {
  it('writes a code as the lower camel word of a catalogue key', () => {
    expect(camel('EXTENSION_OF_TIME')).toBe('extensionOfTime');
    expect(camel('NOTICE')).toBe('notice');
    expect(camel('CLOSED_MATERIALISED')).toBe('closedMaterialised');
  });

  it('writes days, amounts and instants in the form of the screen and never turns an amount into a float', () => {
    expect(dayText('2026-11-08')).toBe('08/11/2026');
    expect(dayText('2026-11-08T20:00:00Z')).toBe('09/11/2026');
    expect(dayText(null)).toBe('');
    expect(vnd('1200000000', 'en')).toBe('1,200,000,000');
    expect(vnd('1200000000', 'vi')).toBe('1.200.000.000');
    expect(vnd('12abc', 'vi')).toBe('12abc');
    expect(vnd(null, 'vi')).toBe('');
    expect(isDay('2026-02-30')).toBe(false);
    expect(isDay('2026-02-28')).toBe(true);
  });

  it('tells a clock that is missed from one that is met, approaching or cannot run, by tone and never by colour alone', () => {
    expect(stateTone('MISSED')).toBe('danger');
    expect(stateTone('BARRED')).toBe('danger');
    expect(stateTone('APPROACHING')).toBe('warning');
    expect(stateTone('CALENDAR_UNAVAILABLE')).toBe('warning');
    expect(stateTone('MET')).toBe('success');
    expect(stateTone('NOT_DEFINED')).toBe('neutral');
  });

  it('names a refusal by what the server said and calls anything else general', () => {
    expect(describeProblem(problem('SELF_APPROVAL_DENIED')).kind).toBe('selfApproval');
    expect(describeProblem(problem('VERSION_CONFLICT')).kind).toBe('versionConflict');
    expect(describeProblem(problem('CTR_CLAIM_STATE_INVALID')).kind).toBe('claimState');
    expect(describeProblem(problem('CLAIM_TERM_PENDING')).kind).toBe('termPending');
    expect(describeProblem(problem('CLAIM_BAR_NOT_DUE')).kind).toBe('barNotDue');
    expect(describeProblem(problem('CLAIM_SETTLEMENT_EXCEEDS_CLAIM')).kind).toBe('settlementExceeds');
    expect(describeProblem(problem('EARLY_WARNING_STATE_INVALID')).kind).toBe('warningState');
    expect(describeProblem(problem('EARLY_WARNING_ACTIONS_OPEN')).kind).toBe('actionsOpen');
    expect(describeProblem(problem('VALIDATION_FAILED', 'notice_days'))).toEqual({ kind: 'validation', field: 'notice_days' });
    expect(describeProblem(problem('SOMETHING_ELSE')).kind).toBe('general');
    expect(describeProblem(new Error('x')).kind).toBe('general');
  });

  it('judges text and days before anything is sent', () => {
    expect(textProblem('', 5, 10)).toBe('required');
    expect(textProblem('abc', 5, 10)).toBe('tooShort');
    expect(textProblem('abcdefghijkl', 5, 10)).toBe('tooLong');
    expect(textProblem('  hello  ', 5, 10)).toBeUndefined();
    expect(daysProblem('', 1, 10)).toBeUndefined();
    expect(daysProblem('0', 1, 10)).toBe('invalidNumber');
    expect(daysProblem('5.5', 1, 10)).toBe('invalidNumber');
    expect(daysProblem('7', 1, 10)).toBeUndefined();
  });
});

describe('the filter of the register', () => {
  it('sends only what the person chose and the cursor of the next page', () => {
    expect(queryOf(EMPTY_FILTER)).toEqual({ limit: 50 });
    expect(queryOf({ contractId: 'c', status: 'RESPONDED', side: 'OWNER', limitation: 'MISSED', open: true, mine: true }, 'next')).toEqual({
      limit: 50,
      contract_id: 'c',
      status: 'RESPONDED',
      claimant_side: 'OWNER',
      limitation: 'MISSED',
      open: true,
      mine: true,
      cursor: 'next',
    });
    expect(isFiltered(EMPTY_FILTER)).toBe(false);
    expect(isFiltered({ ...EMPTY_FILTER, open: true })).toBe(true);
  });
});

describe('registering a claim', () => {
  const form = { ...emptyRegister(TODAY, '00000000-0000-4000-8000-000000000010'), title: 'Late handover', description: 'The site was handed over late.', eventOn: '2026-11-01', awarenessOn: '2026-11-03' };

  it('accepts a claim with a side and a kind that go together and builds the body without empty optional fields', () => {
    expect(validateRegister(form, TODAY)).toEqual({});
    expect(registerBody(form)).toEqual({ claimant_side: 'CONTRACTOR', kind: 'EXTENSION_OF_TIME', title: 'Late handover', event_description: 'The site was handed over late.', event_on: '2026-11-01', awareness_on: '2026-11-03' });
    expect(registerBody({ ...form, amount: '500000000', days: '20' })).toMatchObject({ claimed_amount_vnd: '500000000', claimed_days: 20 });
  });

  it('refuses a kind of the other side, awareness before the event or in the future, and an amount that is not whole', () => {
    expect(validateRegister({ ...form, kind: 'DELAY_DAMAGES' }, TODAY).kind).toBe('pickOne');
    expect(validateRegister({ ...form, awarenessOn: '2026-10-30' }, TODAY).awarenessOn).toBe('invalidDay');
    expect(validateRegister({ ...form, awarenessOn: '2026-11-09' }, TODAY).awarenessOn).toBe('invalidDay');
    expect(validateRegister({ ...form, eventOn: '2026-11-09' }, TODAY).eventOn).toBe('invalidDay');
    expect(validateRegister({ ...form, amount: '12.5' }, TODAY).amount).toBe('invalidAmount');
    expect(validateRegister({ ...form, contractId: '' }, TODAY).contractId).toBe('pickOne');
    expect(validateRegister({ ...form, title: 'abc' }, TODAY).title).toBe('tooShort');
  });
});

describe('recording a step', () => {
  const claim = { awareness_on: '2026-11-03', steps: [{ occurred_on: '2026-11-05' }] } as never;

  it('keeps the timeline from running backwards, into the future or before awareness', () => {
    const base = { ...emptyStep('NOTICE', TODAY), occurredOn: '2026-11-06', note: 'Notice served by letter' };
    expect(validateStep(base, claim, TODAY)).toEqual({});
    expect(validateStep({ ...base, occurredOn: '2026-11-04' }, claim, TODAY).occurredOn).toBe('invalidDay');
    expect(validateStep({ ...base, occurredOn: '2026-11-09' }, claim, TODAY).occurredOn).toBe('invalidDay');
    expect(validateStep({ ...base, note: '' }, claim, TODAY).note).toBe('required');
  });

  it('asks for a decision on a response and for an amount or days on a settlement, and sends the figures only where the step carries them', () => {
    const response = { ...emptyStep('RESPONSE', TODAY), note: 'The engineer answered in writing' };
    expect(validateStep(response, claim, TODAY).decision).toBe('pickOne');
    expect(stepBody({ ...response, decision: 'ACCEPTED' })).toMatchObject({ kind: 'RESPONSE', decision: 'ACCEPTED' });
    const settlement = { ...emptyStep('SETTLEMENT_PROPOSAL', TODAY), note: 'Agreed in the meeting' };
    expect(validateStep(settlement, claim, TODAY).settledAmount).toBe('required');
    expect(validateStep({ ...settlement, grantedDays: '8' }, claim, TODAY)).toEqual({});
    expect(stepBody({ ...settlement, settledAmount: '300', grantedDays: '8', claimedAmount: '999' })).toEqual({ kind: 'SETTLEMENT_PROPOSAL', occurred_on: TODAY, note: 'Agreed in the meeting', settled_amount_vnd: '300', granted_days: 8 });
    const particulars = { ...emptyStep('PARTICULARS', TODAY), note: 'Fully detailed claim', claimedAmount: '12.5' };
    expect(validateStep(particulars, claim, TODAY).claimedAmount).toBe('invalidAmount');
  });

  it('asks for a link to a change order or a payment, each written as an identifier', () => {
    expect(validateLinks({ changeRequestId: '', paymentRequestId: '' }).changeRequestId).toBe('required');
    expect(validateLinks({ changeRequestId: 'abc', paymentRequestId: '' }).changeRequestId).toBe('invalidId');
    expect(validateLinks({ changeRequestId: '', paymentRequestId: '00000000-0000-4000-8000-000000000001' })).toEqual({});
    expect(linksBody({ changeRequestId: '', paymentRequestId: '00000000-0000-4000-8000-000000000001' })).toEqual({ payment_request_id: '00000000-0000-4000-8000-000000000001' });
  });
});

describe('the term of a contract', () => {
  const template: ClaimTermTemplate = {
    code: 'FIDIC_2017_EXAMPLE',
    notice_days: 28,
    particulars_days: 84,
    response_days: 42,
    settlement_days: null,
    basis: 'CALENDAR_DAYS',
    particulars_from: 'AWARENESS',
    bar_effect: 'BARS_CLAIM',
    rule: { source: 'DEFAULT', version: 0, unverified: true, formula: null, source_text: null, as_of: null, legal_status: null },
  };

  it('copies the numbers of a template into the form and nothing else: the clause stays empty, so the proposal is still to be written from the contract', () => {
    const copied = copyTemplate(emptyTerm(), template);
    expect(copied).toMatchObject({ noticeDays: '28', particularsDays: '84', responseDays: '42', settlementDays: '', particularsFrom: 'AWARENESS', barEffect: 'BARS_CLAIM', templateCode: 'FIDIC_2017_EXAMPLE', clause: '' });
    expect(validateTerm(copied).clause).toBe('required');
    expect(validateTerm({ ...copied, clause: 'Clause 20.1' })).toEqual({});
    expect(termBody({ ...copied, clause: 'Clause 20.1' })).toEqual({
      claimant_side: 'CONTRACTOR',
      clause_reference: 'Clause 20.1',
      basis: 'CALENDAR_DAYS',
      particulars_from: 'AWARENESS',
      bar_effect: 'BARS_CLAIM',
      notice_days: 28,
      particulars_days: 84,
      response_days: 42,
      template_code: 'FIDIC_2017_EXAMPLE',
    });
  });

  it('refuses a term with no period, a bar with nothing to apply to, and particulars counted from a notice that has no period', () => {
    expect(validateTerm({ ...emptyTerm(), clause: 'Clause 20.1' }).noticeDays).toBe('required');
    expect(validateTerm({ ...emptyTerm(), responseDays: '14', barEffect: 'BARS_CLAIM', clause: 'Clause 20.1' }).barEffect).toBe('pickOne');
    expect(validateTerm({ ...emptyTerm(), particularsDays: '30', clause: 'Clause 20.1' }).particularsFrom).toBe('pickOne');
    expect(validateTerm({ ...emptyTerm(), noticeDays: '0', clause: 'Clause 20.1' }).noticeDays).toBe('invalidNumber');
  });

  it('lists the periods a contract gives in the order the clocks run and leaves out the ones it does not give', () => {
    expect(periodsOf({ notice_days: 28, particulars_days: null, response_days: 14, settlement_days: null })).toEqual([
      { code: 'NOTICE', days: 28 },
      { code: 'RESPONSE', days: 14 },
    ]);
  });
});
