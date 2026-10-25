import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_GENERATE,
  EMPTY_SEND,
  FORM_CODES,
  boardLink,
  describeProblem,
  formsLink,
  formsMissing,
  generateBody,
  sendBody,
  standingCount,
  standingForms,
  toForm,
  toForms,
  toFormsAnswer,
  validateGenerate,
  validateSend,
} from './model';
import { answer, form, formId, paymentId } from './test-support';

const refusal = (code: string, extensions: Record<string, unknown> = {}, status = 422) => new ApiError({ status, code, correlationId: 'c', extensions });

describe('the Treasury forms on the screens', () => {
  it('links the board and the forms of a request', () => {
    expect(boardLink()).toBe('/pay/pay-04');
    expect(formsLink(paymentId(1))).toBe(`/pay/pay-14?request=${paymentId(1)}`);
    expect(FORM_CODES).toEqual(['03.a/TT', '04.a/TT', '04.b/TT', '05.a/TT']);
  });

  it('reads a form with the template it came from, its legal basis and the hash of the file', () => {
    const read = toForm(form(1, '03.a/TT'));
    expect(read).toMatchObject({ id: formId(1), formCode: '03.a/TT', status: 'GENERATED', templateRevision: 2, legalBasis: expect.stringContaining('254/2025'), generatedAt: '2026-10-25T01:00:00.000Z' });
    expect(read?.fileSha256).toHaveLength(64);
    expect(toForm(form(1, '03.a/TT', { file_sha256: 'not a hash', template_revision: 'x', legal_basis: null, generated_at: null }))).toMatchObject({ fileSha256: null, templateRevision: null, legalBasis: '', generatedAt: null });
    expect(toForm(null)).toBeUndefined();
    expect(toForm(form(1, '03.a/TT', { status: 'NOPE' }))).toBeUndefined();
    expect(toForm(form(1, '03.a/TT', { id: undefined }))).toBeUndefined();
    expect(toForms({ items: [form(1, '03.a/TT'), { id: 'x' }, form(2, '04.a/TT')] })).toHaveLength(2);
    expect(toForms(null)).toEqual([]);
    expect(toForms({ items: 'x' })).toEqual([]);
  });

  it('tells the forms that stand and the ones still lacking', () => {
    const forms = toForms({ items: [form(1, '03.a/TT'), form(2, '03.a/TT', { status: 'SUPERSEDED' }), form(3, '05.a/TT')] });
    expect([...standingForms(forms).keys()]).toEqual(['03.a/TT', '05.a/TT']);
    expect(formsMissing(forms)).toEqual(['04.a/TT', '04.b/TT']);
    expect(formsMissing([])).toEqual([...FORM_CODES]);
    expect(standingCount({ formsStanding: ['03.a/TT', '04.a/TT', 'other'] })).toBe(2);
  });

  it('reads the answer of the drawing of forms', () => {
    expect(toFormsAnswer(answer({ forms: [form(1, '03.a/TT')] }))).toMatchObject({ id: paymentId(1), status: 'VERIFIED', version: 2, forms: [{ formCode: '03.a/TT' }] });
    expect(toFormsAnswer(answer({ status: undefined, forms: 'x' }))).toMatchObject({ status: '', forms: [] });
    expect(toFormsAnswer(null)).toBeUndefined();
    expect(toFormsAnswer(answer({ resource_version: 'x' }))).toBeUndefined();
  });

  it('asks for the place and sends it with the forms asked for', () => {
    expect(validateGenerate(EMPTY_GENERATE)).toEqual({ place: 'required' });
    expect(validateGenerate({ place: 'x'.repeat(101) })).toEqual({ place: 'tooLong' });
    expect(validateGenerate({ place: 'Cao Bằng' })).toEqual({});
    expect(generateBody(['03.a/TT', '05.a/TT'], { place: ' Cao Bằng ' })).toEqual({ form_codes: ['03.a/TT', '05.a/TT'], place: 'Cao Bằng' });
  });

  it('asks for a day that is a day and not to come, and sends the number only when there is one, with the forms that stand', () => {
    expect(validateSend(EMPTY_SEND, '2026-10-25')).toEqual({ sentOn: 'required' });
    expect(validateSend({ sentOn: '2026-02-30', treasuryRef: '' }, '2026-10-25')).toEqual({ sentOn: 'date' });
    expect(validateSend({ sentOn: 'tomorrow', treasuryRef: '' }, '2026-10-25')).toEqual({ sentOn: 'date' });
    expect(validateSend({ sentOn: '2026-10-26', treasuryRef: '' }, '2026-10-25')).toEqual({ sentOn: 'date' });
    expect(validateSend({ sentOn: '2026-10-25', treasuryRef: 'x'.repeat(201) }, '2026-10-25')).toEqual({ treasuryRef: 'tooLong' });
    expect(validateSend({ sentOn: '2026-10-25', treasuryRef: 'KB-1' }, '2026-10-25')).toEqual({});
    const forms = toForms({ items: [form(1, '03.a/TT'), form(2, '04.a/TT', { status: 'SUPERSEDED' }), form(3, '04.a/TT')] });
    expect(sendBody({ sentOn: ' 2026-10-24 ', treasuryRef: ' KB-1 ' }, forms)).toEqual({ treasury_submitted_on: '2026-10-24', treasury_ref: 'KB-1', form_instance_ids: [formId(1), formId(3)] });
    expect(sendBody({ sentOn: '2026-10-24', treasuryRef: '  ' }, forms)).not.toHaveProperty('treasury_ref');
  });

  it('words every refusal of the server, naming the form and the forms that are lacking', () => {
    expect(describeProblem(refusal('TEMPLATE_UNCONFIRMED', { form_code: '05.a/TT' }))).toEqual({ problem: 'unconfirmed', formCode: '05.a/TT', missing: [] });
    expect(describeProblem(refusal('TEMPLATE_NOT_EFFECTIVE', { form_code: '04.b/TT' }))).toEqual({ problem: 'notEffective', formCode: '04.b/TT', missing: [] });
    expect(describeProblem(refusal('TEMPLATE_UNCONFIRMED'))).toEqual({ problem: 'unconfirmed', formCode: null, missing: [] });
    expect(describeProblem(refusal('FORMS_NOT_GENERATED', { missing_form_codes: ['04.a/TT', 7, '05.a/TT'] }))).toEqual({ problem: 'formsMissing', formCode: null, missing: ['04.a/TT', '05.a/TT'] });
    expect(describeProblem(refusal('FORMS_NOT_GENERATED')).missing).toEqual([]);
    const cases: Array<[string, string]> = [
      ['PAYMENT_STATE_INVALID', 'paymentState'],
      ['PROVIDER_UNAVAILABLE', 'unavailable'],
      ['VERSION_CONFLICT', 'versionConflict'],
      ['VALIDATION_FAILED', 'validation'],
      ['INVALID_REQUEST', 'validation'],
      ['FIELD_NOT_ALLOWED', 'validation'],
      ['RESOURCE_NOT_FOUND', 'notFound'],
      ['SCOPE_DENIED', 'denied'],
      ['ENTITLEMENT_DENIED', 'denied'],
      ['SESSION_EXPIRED', 'session'],
      ['SOMETHING_ELSE', 'general'],
    ];
    for (const [code, problem] of cases) expect(describeProblem(refusal(code)).problem).toBe(problem);
    expect(describeProblem(new Error('x')).problem).toBe('general');
  });
});
