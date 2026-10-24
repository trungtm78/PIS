/**
 * One finding of a rule check that the request schema cannot state (BR-ADM-04, `validateWorkCalendar`): the field it is
 * about, a machine code and the i18n key of an explanation. The client writes the sentence; the server never sends prose.
 */
export interface RuleFinding {
  field: string;
  code: string;
  /** i18n key of the explanation, lower camel case under the given prefix. */
  message: string;
}

/** `OUT_OF_YEAR` under `adm.calendar.error` is explained by `adm.calendar.error.outOfYear`: keys are lower camel case, codes are not. */
export function findingOf(keyPrefix: string, field: string, code: string): RuleFinding {
  const camel = code.toLowerCase().replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
  return { field, code, message: `${keyPrefix}.${camel}` };
}
