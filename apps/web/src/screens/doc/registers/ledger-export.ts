import type { Translator } from '../../../i18n';
import { sha256Hex } from '../../ctr/boq-model';
import { toCsv } from '../../mdm/catalogues';
import { directionLabel, entryStatusLabel, modeLabel, statusLabel } from './labels';
import type { Register, RegisterEntry } from './types';

type T = Translator['t'];

export interface LedgerFile {
  name: string;
  content: string;
  /** SHA-256 of every byte of the file above its last line, which is the line that carries it. */
  sha256: string;
  rowCount: number;
}

export interface LedgerInput {
  register: Register;
  entries: readonly RegisterEntry[];
  tenantName: string;
  /** The day of the export, as `yyyy-mm-dd`. */
  exportedOn: string;
}

/**
 * The ledger of one register as the file a records manager keeps (UAT-AC431): the scope lines (tenant, unit, register, year, direction, the
 * document types the register serves), one row for every number with its two-digit form and its state in words, and a last line with the
 * SHA-256 of everything above it, so that the file can be checked later.
 */
export async function buildLedgerFile(t: T, input: LedgerInput): Promise<LedgerFile> {
  const { register, entries } = input;
  const scope: string[][] = [
    [t('doc.registers.export.meta.tenant'), input.tenantName],
    [t('doc.registers.export.meta.unit'), register.organizationUnitId],
    [t('doc.registers.export.meta.register'), `${register.registerCode} - ${register.name}`],
    [t('doc.registers.export.meta.year'), String(register.year)],
    [t('doc.registers.export.meta.direction'), directionLabel(t, register.direction)],
    [t('doc.registers.export.meta.mode'), modeLabel(t, register.mode)],
    [t('doc.registers.export.meta.status'), statusLabel(t, register.status)],
    [t('doc.registers.export.meta.types'), register.scopeDocTypes.join(' ')],
    [t('doc.registers.export.meta.rows'), String(entries.length)],
    [t('doc.registers.export.meta.exportedOn'), input.exportedOn],
  ];
  const rows = entries.map((entry) => [entry.displayNumber, entry.symbol, entry.issuedOn, entryStatusLabel(t, entry.status)]);
  const [first = [], ...rest] = scope;
  const body = toCsv(first, [
    ...rest,
    [],
    [t('doc.registers.entries.col.number'), t('doc.registers.entries.col.symbol'), t('doc.registers.entries.col.issuedOn'), t('doc.registers.entries.col.status')],
    ...rows,
  ]);
  const sha256 = await sha256Hex(new TextEncoder().encode(body).buffer as ArrayBuffer);
  return {
    name: `register-ledger-${register.registerCode}-${register.year}.csv`.replaceAll(/[^A-Za-z0-9._-]/g, '_'),
    content: `${body}${t('doc.registers.export.meta.hash')},${sha256}\r\n`,
    sha256,
    rowCount: entries.length,
  };
}
