import { DomainError, periodCode } from '@machvon/kernel';
import type { FormPeriod } from '@machvon/kernel';

/**
 * The name of an output file. The rule is configuration, not code: a pattern with tokens, so a customer's convention (a group's monthly form, a plant's report) is a row of data. The default is
 * `<code>_<period>_<version>_<sha8>.<ext>`: the layout code, the period (`2026-M10`), the revision of the issued copy (`v02`), the first eight characters of the sha256 of the bytes, and the extension. The sha8
 * makes two different files never share a name and lets a reader see at a glance whether a file is the one that was issued.
 */
export interface FileNameRule {
  /** Tokens: `{code}`, `{org}`, `{period}`, `{version}`, `{sha8}`, `{ext}`, `{date}` (the issue day as YYYYMMDD). Must contain `{ext}`; must contain `{sha8}` unless `allowNoHash`. */
  pattern: string;
  /** How many digits the version is padded to (`v02`): 1 to 4. */
  versionDigits: number;
  /** The text before the number of the version: the default is `v`. Up to four letters or digits; may be empty. */
  versionPrefix: string;
  /** A rule for a receiver that wants a name without the hash (a fixed convention) may say so; the copy is still identified by its recorded sha256. */
  allowNoHash?: boolean | undefined;
  maxLength: number;
}

export const DEFAULT_FILE_NAME_RULE: Readonly<FileNameRule> = Object.freeze({
  pattern: '{code}_{period}_{version}_{sha8}.{ext}',
  versionDigits: 2,
  versionPrefix: 'v',
  maxLength: 120,
});

export interface FileNameParts {
  /** The layout code (`MONTHLY-GROUP`). */
  code: string;
  /** The code of the organisation (a short code, not a name). */
  org?: string | undefined;
  period: FormPeriod;
  /** The revision of the issued copy, from 1. */
  revision: number;
  sha256: string;
  extension: 'xlsx' | 'docx';
  /** The day of the issue, `YYYY-MM-DD`. */
  issuedOn?: string | undefined;
}

const TOKENS = new Set(['code', 'org', 'period', 'version', 'sha8', 'ext', 'date']);
const SAFE_PREFIX = /^[A-Za-z0-9]{0,4}$/;
const SHA256 = /^[0-9a-f]{64}$/;
/** What Windows will not take as a file name, whatever the extension. */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

const refuse = (detail: string): never => {
  throw new DomainError('VALIDATION_FAILED', 422, detail);
};

/** Vietnamese letters to plain ASCII (đ and Đ do not decompose); anything else that a file name should not hold becomes an underscore. */
export function asciiSlug(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^[_.-]+|[_.-]+$/g, '');
}

/** The rule must be a name that a file system takes: known tokens only, an extension, a hash (unless allowed), and a length that fits. */
export function assertFileNameRule(rule: FileNameRule): void {
  const tokens = [...rule.pattern.matchAll(/\{([^{}]*)\}/g)].map((match) => match[1] as string);
  const stripped = rule.pattern.replace(/\{[^{}]*\}/g, '');
  const bad =
    tokens.some((token) => !TOKENS.has(token)) ||
    /[{}]/.test(stripped) ||
    /[\\/:*?"<>|\s]/.test(stripped) ||
    !rule.pattern.endsWith('.{ext}') ||
    (rule.allowNoHash !== true && !tokens.includes('sha8')) ||
    !Number.isInteger(rule.versionDigits) ||
    rule.versionDigits < 1 ||
    rule.versionDigits > 4 ||
    !SAFE_PREFIX.test(rule.versionPrefix) ||
    !Number.isInteger(rule.maxLength) ||
    rule.maxLength < 24 ||
    rule.maxLength > 200;
  if (bad) refuse('file_name_rule');
}

/** The file name for an output under a rule. The extension and the hash are never cut; a name that is too long loses the end of the layout code first. */
export function reportFileName(parts: FileNameParts, rule: FileNameRule = DEFAULT_FILE_NAME_RULE): string {
  assertFileNameRule(rule);
  if (!Number.isInteger(parts.revision) || parts.revision < 1 || parts.revision >= 10 ** rule.versionDigits || !SHA256.test(parts.sha256)) refuse('file_name_parts');
  const values: Record<string, string> = {
    code: asciiSlug(parts.code),
    org: asciiSlug(parts.org ?? ''),
    period: periodCode(parts.period),
    version: `${rule.versionPrefix}${String(parts.revision).padStart(rule.versionDigits, '0')}`,
    sha8: parts.sha256.slice(0, 8),
    ext: parts.extension,
    date: (parts.issuedOn ?? '').replaceAll('-', ''),
  };
  if (values.code === '') refuse('file_name_parts');
  if (rule.pattern.includes('{org}') && values.org === '') refuse('file_name_parts');
  if (rule.pattern.includes('{date}') && !/^\d{8}$/.test(values.date as string)) refuse('file_name_parts');
  const render = (): string => rule.pattern.replace(/\{([a-z0-9]+)\}/g, (_match, token: string) => values[token] as string);
  let name = render();
  if (name.length > rule.maxLength) {
    const code = values.code as string;
    const cut = code.slice(0, Math.max(1, code.length - (name.length - rule.maxLength))).replace(/[_.-]+$/, '');
    values.code = cut === '' ? code.slice(0, 1) : cut;
    name = render();
  }
  if (name.length > rule.maxLength) refuse('file_name_length');
  if (RESERVED.test(name.slice(0, name.lastIndexOf('.')))) refuse('file_name_parts');
  return name;
}
