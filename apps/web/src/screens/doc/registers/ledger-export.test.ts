import { describe, expect, it } from 'vitest';
import { createTranslator } from '../../../i18n';
import en from '../../../i18n/en.json';
import vi_ from '../../../i18n/vi.json';
import { buildLedgerFile } from './ledger-export';
import { toEntry, toRegister } from './types';

const t = createTranslator({ locale: 'vi', catalogues: { vi: vi_, en }, strict: true }).t;

const REGISTER = toRegister({
  id: 'r1',
  register_code: 'REG-QD-2026',
  name: 'Decisions',
  direction: 'OUTGOING',
  organization_unit_id: 'unit-1',
  year: 2026,
  mode: 'MANAGED',
  last_number: 43,
  status: 'OPEN',
  scope_doc_types: ['QD', 'TB'],
  version: 1,
});

const NUMBERS = Array.from({ length: 43 }, (_, index) => index + 1);
const entry = (number: number) =>
  toEntry({
    allocation_id: `a${number}`,
    number,
    display_number: number < 10 ? `0${number}` : String(number),
    symbol: `${number}/QD`,
    document_id: 'd',
    issued_on: '2026-06-15',
    status: number === 7 ? 'VOIDED' : number === 12 ? 'RECALLED' : 'ALLOCATED',
  });
const sha256 = async (text: string): Promise<string> => {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text).buffer as ArrayBuffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

describe('buildLedgerFile (AC-ST-DOC-002-2, UAT-AC431)', () => {
  it('AC-ST-DOC-002-2 / UAT-AC431: exports 43 rows with two-digit numbers, voided and recalled in words, the scope and a SHA-256 that checks', async () => {
    const file = await buildLedgerFile(t, { register: REGISTER, entries: NUMBERS.map(entry), tenantName: 'Cao Bang', exportedOn: '2026-10-26' });
    const lines = file.content.replace('﻿', '').split('\r\n');
    const headings = [vi_['doc.registers.entries.col.number'], vi_['doc.registers.entries.col.symbol'], vi_['doc.registers.entries.col.issuedOn'], vi_['doc.registers.entries.col.status']].join(',');
    const header = lines.indexOf(headings);
    expect(header).toBeGreaterThan(0);
    const rows = lines.slice(header + 1, header + 1 + 43);
    expect(rows).toHaveLength(43);
    expect(lines[header + 44]).toBe(`${vi_['doc.registers.export.meta.hash']},${file.sha256}`);
    expect(file.rowCount).toBe(43);
    expect(rows[0]).toBe(`01,1/QD,2026-06-15,${vi_['doc.registers.entryStatus.allocated']}`);
    expect(rows[8]?.startsWith('09,')).toBe(true);
    expect(rows[9]?.startsWith('10,')).toBe(true);
    expect(rows[6]?.endsWith(vi_['doc.registers.entryStatus.voided'])).toBe(true);
    expect(rows[11]?.endsWith(vi_['doc.registers.entryStatus.recalled'])).toBe(true);
    expect(rows.filter((row) => row.endsWith(vi_['doc.registers.entryStatus.allocated']))).toHaveLength(41);
    const scope = lines.slice(0, header).join('\n');
    for (const expected of ['Cao Bang', 'unit-1', 'REG-QD-2026 - Decisions', '2026', vi_['doc.registers.direction.outgoing'], 'QD TB', '2026-10-26']) expect(scope).toContain(expected);
    expect(lines.slice(0, header).find((line) => line.startsWith(vi_['doc.registers.export.meta.rows']))).toBe(`${vi_['doc.registers.export.meta.rows']},43`);
    const covered = file.content.slice(0, file.content.lastIndexOf(vi_['doc.registers.export.meta.hash']));
    expect(await sha256(covered)).toBe(file.sha256);
  });

  it('names the file after the register and its year and keeps the name safe to save', async () => {
    const file = await buildLedgerFile(t, { register: { ...REGISTER, registerCode: 'A/B C' }, entries: [], tenantName: '', exportedOn: '2026-10-26' });
    expect(file.name).toBe('register-ledger-A_B_C-2026.csv');
    expect(file.rowCount).toBe(0);
  });

  it('writes a cell that starts like a formula as text', async () => {
    const file = await buildLedgerFile(t, {
      register: REGISTER,
      entries: [toEntry({ number: 3, display_number: '03', symbol: '=1+1', issued_on: '2026-01-02', status: 'ALLOCATED' })],
      tenantName: 'x',
      exportedOn: '2026-10-26',
    });
    expect(file.content).toContain("03,'=1+1,2026-01-02");
  });
});
