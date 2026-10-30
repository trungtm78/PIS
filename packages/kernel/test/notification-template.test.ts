import { assertTemplateAllowed, assertTemplateIdentity, declaredVariables, placeholdersOf, sampleVariablesOf } from '../src/notification-template';

const SCHEMA = {
  type: 'object',
  properties: {
    code: { type: 'string', classification: 'PUBLIC' },
    unit: { type: 'string', classification: 'INTERNAL' },
    amount: { type: 'money', classification: 'INTERNAL' },
    owner: { type: 'string', classification: 'PERSONAL' },
    secret: { type: 'string', classification: 'CONFIDENTIAL' },
    count: { type: 'integer', classification: 'PUBLIC' },
  },
};

const allowed = (channel: string, body: string, overrides: Record<string, unknown> = {}) =>
  assertTemplateAllowed({ channel, contentAst: { body }, variableSchema: SCHEMA, lockscreenSafe: channel.startsWith('PUSH'), ...overrides });

const refusal = (run: () => void): { code: string; detail: string | undefined } => {
  try {
    run();
  } catch (error) {
    const known = error as { code: string; detail?: string };
    return { code: known.code, detail: known.detail };
  }
  throw new Error('it was allowed');
};

describe('the rules of a message template (ST-NOT-005, BR-NOT-10, BR-NOT-11)', () => {
  it('allows what the channel may carry: any variable on the inbox and e-mail, public or internal text on a phone', () => {
    expect(() => allowed('IN_APP', 'Dossier {{code}} of {{owner}}: {{secret}}')).not.toThrow();
    expect(() => assertTemplateAllowed({ channel: 'EMAIL', contentAst: { subject: 'Dossier {{code}}', body: '{{owner}} owes {{amount}}' }, variableSchema: SCHEMA, lockscreenSafe: false })).not.toThrow();
    expect(() => allowed('SMS', 'Dossier {{code}} of {{unit}} needs a look ({{count}})')).not.toThrow();
    expect(() => allowed('PUSH_FCM', 'A dossier needs a look')).not.toThrow();
  });

  it('UAT-AC28: refuses a money variable on push and SMS, naming the variable and never its value', () => {
    for (const channel of ['PUSH_FCM', 'PUSH_APNS', 'SMS']) {
      expect(refusal(() => allowed(channel, 'You owe {{amount}}'))).toEqual({ code: 'TEMPLATE_VARIABLE_CLASSIFIED', detail: 'variable_schema.amount' });
    }
  });

  it('UAT-AC188: refuses a confidential or personal variable on the channels of the providers', () => {
    for (const channel of ['ZALO_ZNS', 'ZALO_OA', 'WHATSAPP', 'SMS', 'PUSH_FCM']) {
      expect(refusal(() => allowed(channel, 'See {{secret}}')).code).toBe('TEMPLATE_VARIABLE_CLASSIFIED');
      expect(refusal(() => allowed(channel, 'Dear {{owner}}')).code).toBe('TEMPLATE_VARIABLE_CLASSIFIED');
    }
  });

  it('ST-NOT-007: a push is a neutral sentence: it uses no variable, even a public one, and a figure is still told as classified', () => {
    expect(refusal(() => allowed('PUSH_FCM', 'Dossier {{code}} needs a look'))).toEqual({ code: 'TEMPLATE_INVALID', detail: 'content_ast.code' });
    expect(refusal(() => allowed('PUSH_APNS', 'Dossier of {{unit}}')).code).toBe('TEMPLATE_INVALID');
    expect(refusal(() => allowed('PUSH_FCM', 'You owe {{amount}}')).code).toBe('TEMPLATE_VARIABLE_CLASSIFIED');
    // SMS keeps its public and internal variables.
    expect(() => allowed('SMS', 'Dossier {{code}} of {{unit}}')).not.toThrow();
  });

  it('ST-NOT-007: a push longer than a lock screen takes is refused when it is written, because the adapter would refuse every send of it', () => {
    expect(() => allowed('PUSH_FCM', 'x'.repeat(120))).not.toThrow();
    expect(refusal(() => allowed('PUSH_APNS', 'x'.repeat(121)))).toEqual({ code: 'TEMPLATE_INVALID', detail: 'content_ast.body' });
    expect(() => allowed('SMS', 'x'.repeat(121))).not.toThrow();
  });

  it('judges the variables the text uses, not the ones it only declares', () => {
    expect(() => allowed('SMS', 'Dossier {{code}}')).not.toThrow();
  });

  it('refuses a push template that is not lock-screen safe, and a flag on a channel that has no lock screen', () => {
    expect(refusal(() => allowed('PUSH_APNS', 'Hello', { lockscreenSafe: false }))).toEqual({ code: 'TEMPLATE_INVALID', detail: 'lockscreen_safe' });
    expect(refusal(() => allowed('EMAIL', 'Hello', { lockscreenSafe: true })).detail).toBe('lockscreen_safe');
  });

  it('refuses a placeholder that is not declared, a body that is empty or too long, a subject outside e-mail and a channel nobody knows', () => {
    expect(refusal(() => allowed('EMAIL', 'Hello {{nobody}}'))).toEqual({ code: 'TEMPLATE_INVALID', detail: 'content_ast.nobody' });
    expect(refusal(() => allowed('EMAIL', '  ')).detail).toBe('content_ast.body');
    expect(refusal(() => allowed('EMAIL', 'x'.repeat(10_001))).detail).toBe('content_ast.body');
    expect(refusal(() => assertTemplateAllowed({ channel: 'SMS', contentAst: { subject: 'S', body: 'b' }, variableSchema: SCHEMA, lockscreenSafe: false })).detail).toBe('content_ast.subject');
    expect(refusal(() => allowed('TELEGRAM', 'x')).detail).toBe('channel');
    expect(refusal(() => assertTemplateAllowed({ channel: 'EMAIL', contentAst: 'text', variableSchema: SCHEMA, lockscreenSafe: false })).detail).toBe('content_ast.body');
  });

  it('refuses a variable that has no type or classification the platform knows', () => {
    const schema = (property: Record<string, unknown>) => ({ type: 'object', properties: { x: property } });
    expect(refusal(() => declaredVariables(schema({ classification: 'PUBLIC' }))).detail).toBe('variable_schema.x.type');
    expect(refusal(() => declaredVariables(schema({ type: 'string' }))).detail).toBe('variable_schema.x.classification');
    expect(refusal(() => declaredVariables(schema({ type: 'date', classification: 'PUBLIC' }))).detail).toBe('variable_schema.x.type');
    expect(refusal(() => declaredVariables({ properties: { 'bad name': { type: 'string', classification: 'PUBLIC' } } })).detail).toBe('variable_schema.properties');
    expect(refusal(() => declaredVariables('x')).detail).toBe('variable_schema');
    expect(declaredVariables({}).size).toBe(0);
  });

  it('judges the code, the locale and the purpose of a revision', () => {
    expect(() => assertTemplateIdentity({ code: 'report.submitted-a_1', locale: 'vi-VN', purpose: 'REMINDER' })).not.toThrow();
    expect(refusal(() => assertTemplateIdentity({ code: 'X', locale: 'vi-VN', purpose: 'REMINDER' })).detail).toBe('code');
    expect(refusal(() => assertTemplateIdentity({ code: 'Report.A', locale: 'vi-VN', purpose: 'REMINDER' })).detail).toBe('code');
    expect(refusal(() => assertTemplateIdentity({ code: 'abc', locale: 'fr-FR', purpose: 'REMINDER' })).detail).toBe('locale');
    expect(refusal(() => assertTemplateIdentity({ code: 'abc', locale: 'vi-VN', purpose: 'WHATEVER' })).detail).toBe('purpose');
  });

  it('reads the placeholders of a text once each, in order', () => {
    expect(placeholdersOf('{{a}} and {{ b }} and {{a}}, not {{ 1x }} nor {c}')).toEqual(['a', 'b']);
  });

  it('needs a sample for a variable named like a property of a plain object (constructor, toString), not the one it inherits', () => {
    const schema = { type: 'object', properties: { constructor: { type: 'string', classification: 'PUBLIC' } } };
    expect(refusal(() => sampleVariablesOf(schema, { body: '{{constructor}}' }, {}))).toEqual({ code: 'TEMPLATE_INVALID', detail: 'sample_variables.constructor' });
    expect(sampleVariablesOf(schema, { body: '{{constructor}}' }, { constructor: 'own' }).constructor).toBe('own');
  });

  it('takes sample values for the declared variables only, of their type, and needs every variable the text uses', () => {
    const content = { subject: 'Dossier {{code}}', body: 'Count {{count}}' };
    expect(sampleVariablesOf(SCHEMA, content, { code: 'D-1', count: 3 })).toEqual({ code: 'D-1', count: '3' });
    for (const [samples, detail] of [
      [{ code: 'D-1' }, 'sample_variables.count'],
      [{ code: 'D-1', count: 3, extra: 'x' }, 'sample_variables.extra'],
      [{ code: 7, count: 3 }, 'sample_variables.code'],
      [{ code: 'D-1', count: 3.5 }, 'sample_variables.count'],
      [{ code: 'x'.repeat(501), count: 3 }, 'sample_variables.code'],
      ['text', 'sample_variables'],
    ] as const) {
      expect(refusal(() => sampleVariablesOf(SCHEMA, content, samples))).toEqual({ code: 'TEMPLATE_INVALID', detail });
    }
  });
});
