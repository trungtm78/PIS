import { describe, expect, it } from 'vitest';
import { translator } from '../../../i18n';
import en from '../../../i18n/en.json';
import vi from '../../../i18n/vi.json';
import { disputeKindLabel, disputeOutcomeLabel, entryProblemLabel, evidenceKeyLabel, evidenceValueText, hitBasisLabel, hitClockLabel, hitMoveLabel, hitStatusLabel, leadKindLabel, leadMoveLabel, leadStatusLabel, linkKindLabel, sourceLabel } from './investigation-labels';
import { HIT_BASES, HIT_SOURCES, HIT_STATUSES, LEAD_KINDS, LEAD_STATUSES, LINK_KINDS, drawGraph, edgeWidth, historyGroups, leadOpen, leadTone, linksOf, nodesOfLead, ocdsFileName, ocdsFileText, parseEntries, rankTone, shortName, traceShares } from './investigation-model';
import type { EntryProblem, LeadEvent, LeadLink, LinkNode } from './investigation-model';

const node = (id: string, over: Partial<LinkNode> = {}): LinkNode => ({ id, name: `Nhà thầu ${id}`, tax_identifier: `T${id}`, restricted: false, cluster: null, ...over });
const link = (a: string, b: string, strength = 90, over: Partial<LeadLink> = {}): LeadLink => ({ a_id: a, b_id: b, strength, status: 'ACTIVE', evidence: [{ kind: 'BANK_ACCOUNT', fingerprint: 'abcdef12', weight: strength }], ...over });
const event = (id: string, at: string, over: Partial<LeadEvent> = {}): LeadEvent => ({ id, move: 'TAKE', from_status: 'NEW', to_status: 'IN_REVIEW', actor_name: 'Lê Thị Hoa', reason: null, rank: 80, at, ...over });

describe('the thickness and the tone', () => {
  it('draws a stronger link thicker, from one to six pixels, and a weak link is still seen', () => {
    expect([0, 20, 50, 95, 100].map(edgeWidth)).toEqual([1, 2, 4, 6, 6]);
    expect(edgeWidth(-5)).toBe(1);
    expect(edgeWidth(500)).toBe(6);
  });
  it('tones the rank without calling it a verdict', () => {
    expect([90, 80, 70, 60, 10].map(rankTone)).toEqual(['danger', 'danger', 'warning', 'warning', 'info']);
    expect(leadTone('DISMISSED')).toBe('neutral');
    expect(leadOpen('NEW')).toBe(true);
    expect(leadOpen('DISMISS_PROPOSED')).toBe(true);
    expect(leadOpen('CONFIRMED')).toBe(false);
  });
  it('cuts a long name for a label and keeps a short one', () => {
    expect(shortName('Công ty ABC')).toBe('Công ty ABC');
    expect(shortName('Công ty trách nhiệm hữu hạn xây dựng rất dài', 12)).toHaveLength(12);
    expect(shortName('Công ty trách nhiệm hữu hạn xây dựng rất dài', 12).endsWith('…')).toBe(true);
  });
  it('says the share of traced bids, and none when there are no bids', () => {
    expect(traceShares({ bids: 20, with_origin: 5, with_files: 8 })).toEqual({ origin: 25, files: 40 });
    expect(traceShares({ bids: 0, with_origin: 0, with_files: 0 })).toEqual({ origin: null, files: null });
  });
});

describe('the drawing of a graph', () => {
  const nodes = [node('a'), node('b', { restricted: true }), node('c'), node('d')];
  const links = [link('a', 'b', 95), link('a', 'c', 40), link('b', 'c', 61, { status: 'STALE' })];

  it('puts the focus in the middle and the others on a circle, the strongest link to the focus first', () => {
    const drawn = drawGraph(nodes, links, 'a');
    const focus = drawn.nodes.find((item) => item.id === 'a');
    expect(focus).toMatchObject({ x: 280, y: 210, focus: true });
    expect(drawn.nodes.map((item) => item.id)).toEqual(['a', 'b', 'c', 'd']);
    const ring = drawn.nodes.filter((item) => !item.focus);
    for (const item of ring) expect(Math.round(Math.hypot(item.x - 280, item.y - 210))).toBe(174);
    expect(drawn.nodes.find((item) => item.id === 'b')).toMatchObject({ restricted: true, y: 36 });
  });

  it('gives the same picture for the same input', () => {
    expect(drawGraph(nodes, links, 'a')).toEqual(drawGraph(nodes, links, 'a'));
    expect(drawGraph(nodes, links, null).nodes).toHaveLength(4);
  });

  it('draws each edge with its thickness, its middle and whether it is stale, and leaves out a link to a stranger', () => {
    const drawn = drawGraph(nodes, [...links, link('a', 'zzz')], 'a');
    expect(drawn.edges).toHaveLength(3);
    const edge = drawn.edges.find((item) => item.key === 'b:c');
    expect(edge).toMatchObject({ width: 4, stale: true, strength: 61 });
    expect(edge?.mx).toBeCloseTo(((edge?.x1 ?? 0) + (edge?.x2 ?? 0)) / 2, 0);
    expect(drawn.edges.find((item) => item.key === 'a:b')).toMatchObject({ width: 6, kinds: ['BANK_ACCOUNT'] });
  });

  it('lists the links of a contractor, strongest first, and makes the nodes of a lead from its contractors', () => {
    expect(linksOf(links, 'a').map((item) => item.strength)).toEqual([95, 40]);
    expect(linksOf(links, 'd')).toEqual([]);
    expect(nodesOfLead([{ id: 'x', name: 'X', tax_identifier: '1', restricted: true }])).toEqual([{ id: 'x', name: 'X', tax_identifier: '1', restricted: true, cluster: null }]);
  });
});

describe('the history as a timeline', () => {
  it('groups the steps by the Vietnam day, the newest day first, with the actor and the reason', () => {
    const groups = historyGroups(
      [event('1', '2026-10-20T20:00:00.000Z', { move: 'SCAN_NEW', actor_name: null }), event('2', '2026-10-21T02:00:00.000Z'), event('3', '2026-10-22T02:00:00.000Z', { reason: 'Địa chỉ của văn phòng chung' })],
      (item) => `${item.move}:${item.to_status}`,
    );
    expect(groups.map((group) => group.date)).toEqual(['2026-10-22', '2026-10-21']);
    expect(groups[1]?.entries.map((entry) => entry.id)).toEqual(['1', '2']);
    expect(groups[1]?.entries[0]?.actor).toBeNull();
    expect(groups[1]?.entries[1]?.actor).toEqual({ name: 'Lê Thị Hoa', initials: 'LH' });
    expect(groups[0]?.entries[0]?.note).toBe('Địa chỉ của văn phòng chung');
  });
});

describe('the entries of a list that is pasted', () => {
  it('reads a JSON array and names a bad item', () => {
    const parsed = parseEntries('[{"ref":"A1","name":"Công ty A","tax_code":"0101234567","valid_from":"2026-01-01"},{"name":"No ref"},{"ref":"A3"},{"ref":"A4","name":"X","valid_from":"01/01/2026"}]');
    expect(parsed.entries).toEqual([{ ref: 'A1', name: 'Công ty A', tax_code: '0101234567', valid_from: '2026-01-01' }]);
    expect(parsed.errors).toEqual([
      { line: 2, problem: 'REF' },
      { line: 3, problem: 'IDENTITY' },
      { line: 4, problem: 'DAY' },
    ]);
  });
  it('reads lines with a comma, a semicolon or a tab, with or without the header, and counts the lines from one', () => {
    const withHeader = parseEntries('ref,name,tax_code\nA1;Công ty A;0101234567\nA2\tCông ty B\n');
    expect(withHeader.entries.map((entry) => entry.ref)).toEqual(['A1', 'A2']);
    expect(withHeader.errors).toEqual([]);
    const bare = parseEntries('A1,Công ty A\n,No ref');
    expect(bare.entries).toHaveLength(1);
    expect(bare.errors).toEqual([{ line: 2, problem: 'REF' }]);
    const wrongPeriod = parseEntries('A1,Công ty A,,2026-05-01,2026-01-01');
    expect(wrongPeriod.errors).toEqual([{ line: 1, problem: 'PERIOD' }]);
  });
  it('refuses an empty text, a broken JSON and too many lines', () => {
    expect(parseEntries('   ').errors).toEqual([{ line: 1, problem: 'EMPTY' }]);
    expect(parseEntries('[{"ref":').errors).toEqual([{ line: 1, problem: 'JSON' }]);
    expect(parseEntries('{"ref":"A"}').errors).toEqual([{ line: 1, problem: 'IDENTITY' }]);
    expect(parseEntries('[1]').errors).toEqual([{ line: 1, problem: 'JSON' }]);
    const many = Array.from({ length: 5001 }, (_, index) => `R${index},Name ${index}`).join('\n');
    expect(parseEntries(many).errors).toEqual([{ line: 1, problem: 'TOO_MANY' }]);
    expect(parseEntries('R1,N,' + 'x'.repeat(41)).errors).toEqual([{ line: 1, problem: 'LENGTH' }]);
  });
});

describe('the file of the export', () => {
  it('is named by the Vietnam day and holds only the parties', () => {
    expect(ocdsFileName('2026-11-08T03:00:00.000Z')).toBe('ocds-parties-2026-11-08.json');
    expect(ocdsFileName('')).toBe('ocds-parties-export.json');
    const text = ocdsFileText({ parties: [{ id: 'VN-MST-1', name: 'A', identifier: { scheme: 'VN-MST', id: '1', legalName: 'A' }, roles: ['tenderer'] }], policy: { code: 'c', version: 'v', unverified: true, formula: 'f', source: 's', as_of: '2026-11-01', params: {} }, owners_included: false, contact_included: false, notice: 'n', as_of: 'x' });
    expect(Object.keys(JSON.parse(text))).toEqual(['parties']);
    expect(text).toContain('\n  ');
  });
});

describe('the words of the closed lists', () => {
  const hasKey = (source: object, key: string): boolean => typeof (source as Record<string, string>)[key] === 'string' && (source as Record<string, string>)[key] !== '';
  type Label = (t: (key: string) => string, code: string) => string;
  /** Every code of a closed list must have its words in both languages: the keys are written as templates, so the i18n lint cannot see a missing one. */
  const walk = (label: Label, codes: readonly string[]): void => {
    for (const code of codes) {
      const keys: string[] = [];
      label((key) => (keys.push(key), key), code);
      expect(keys, code).toHaveLength(1);
      for (const key of keys) {
        expect(hasKey(vi, key), `vi ${key}`).toBe(true);
        expect(hasKey(en, key), `en ${key}`).toBe(true);
      }
    }
  };
  it('has words in both languages for every code of the contract', () => {
    walk(leadKindLabel as Label, LEAD_KINDS);
    walk(leadStatusLabel as Label, LEAD_STATUSES);
    walk(linkKindLabel as Label, LINK_KINDS);
    walk(sourceLabel as Label, HIT_SOURCES);
    walk(hitStatusLabel as Label, HIT_STATUSES);
    walk(hitBasisLabel as Label, HIT_BASES);
    walk(hitClockLabel as Label, ['ON_TIME', 'OVERDUE', 'DECIDED']);
    walk(disputeKindLabel as Label, ['PETITION', 'CLAIM']);
    walk(disputeOutcomeLabel as Label, ['OPEN', 'UPHELD', 'REJECTED', 'WITHDRAWN']);
    walk(leadMoveLabel as Label, ['SCAN_NEW', 'SCAN_UPDATE', 'SCAN_REOPEN', 'TAKE', 'PROPOSE_DISMISS', 'CONFIRM_DISMISS', 'REJECT_DISMISS', 'CONFIRM_SIGNAL', 'REFER']);
    walk(hitMoveLabel as Label, ['FOUND', 'RESCORED', 'CONFIRM', 'DISMISS', 'RESOLVE', 'REOPEN']);
    const problems: EntryProblem[] = ['EMPTY', 'JSON', 'TOO_MANY', 'REF', 'LENGTH', 'DAY', 'IDENTITY', 'PERIOD'];
    walk(((t, code) => entryProblemLabel(t as never, code as EntryProblem)) as Label, problems);
    walk(evidenceKeyLabel as Label, ['close_gap_bp', 'nearest_far_gap_bp', 'bidders', 'pattern', 'step_vnd', 'shared_files', 'fingerprints', 'shared_keys', 'packages', 'winners', 'outsider_wins', 'sequence', 'withdrawals']);
  });
  it('shows a code the catalogue does not know as the server wrote it, and writes an evidence value plainly', () => {
    translator.setLocale('vi');
    expect(leadMoveLabel(translator.t, 'SOMETHING_NEW')).toBe('SOMETHING_NEW');
    expect(hitMoveLabel(translator.t, 'OTHER')).toBe('OTHER');
    expect(evidenceKeyLabel(translator.t, 'new_number')).toBe('new_number');
    expect(evidenceValueText([1, 'a', true])).toBe('1, a, true');
    expect(evidenceValueText({ nested: 1 })).toBe('–');
    expect(evidenceValueText(30)).toBe('30');
  });
  it('keeps the same keys in the two part files of the lane', () => {
    expect(Object.keys(vi).filter((key) => key.startsWith('vnd3.'))).toEqual(expect.arrayContaining(Object.keys(en).filter((key) => key.startsWith('vnd3.'))));
  });
});
