import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import {
  camel,
  dayText,
  describeProblem,
  effectiveTone,
  extractionTone,
  foldEntries,
  reasonOk,
  resourceIdOf,
  reviewTone,
  reviewerTone,
  sideWords,
  sizeText,
  stageTone,
  stamp,
  toComparison,
  toDocumentPage,
  toLinkOption,
  versionTone,
} from './model';
import type { CompareEntry } from './model';

const error = (code: string, status: number) => new ApiError({ status, code, correlationId: 'c' });
const entry = (op: CompareEntry['op'], over: Partial<CompareEntry> = {}): CompareEntry => ({ op, before: null, after: null, words: null, ...over });

describe('the model of the repository screens', () => {
  it('reads an instant as the Vietnam day and minute, a day as day/month/year, and leaves what it cannot read', () => {
    expect(stamp('2026-11-08T03:05:00.000Z')).toBe('08/11/2026 10:05');
    expect(stamp('2026-11-08T20:00:00.000Z')).toBe('09/11/2026 03:00');
    expect(stamp(null)).toBe('');
    expect(stamp('later')).toBe('later');
    expect(dayText('2026-01-31')).toBe('31/01/2026');
    expect(dayText(null)).toBe('');
    expect(dayText('soon')).toBe('soon');
  });

  it('keeps the size of a file short with its unit', () => {
    expect(sizeText(900)).toEqual({ value: '900', unit: 'B' });
    expect(sizeText(2048)).toEqual({ value: '2.0', unit: 'KiB' });
    expect(sizeText(5 * 1024 * 1024)).toEqual({ value: '5.0', unit: 'MiB' });
  });

  it('makes a key segment of a class and measures a reason', () => {
    expect(camel('LEGAL_BASIS')).toBe('legalBasis');
    expect(camel('OTHER')).toBe('other');
    expect(reasonOk('  ngắn  ')).toBe(false);
    expect(reasonOk('đủ mười ký tự rồi')).toBe(true);
  });

  it('gives each state a tone, and never colour alone: neutral is the default', () => {
    expect([versionTone('APPROVED'), versionTone('IN_REVIEW'), versionTone('SUPPLEMENT_REQUESTED'), versionTone('REJECTED'), versionTone('DRAFT')]).toEqual(['success', 'info', 'warning', 'danger', 'neutral']);
    expect([reviewTone('APPROVED'), reviewTone('WITHDRAWN')]).toEqual(['success', 'neutral']);
    expect([effectiveTone('IN_FORCE'), effectiveTone('EXPIRED'), effectiveTone('NOT_YET'), effectiveTone('UNDATED')]).toEqual(['success', 'danger', 'info', 'neutral']);
    expect([stageTone('DONE'), stageTone('CURRENT'), stageTone('SUPPLEMENT_REQUESTED'), stageTone('REJECTED'), stageTone('SKIPPED')]).toEqual(['success', 'info', 'warning', 'danger', 'neutral']);
    expect([reviewerTone('APPROVED'), reviewerTone('PENDING'), reviewerTone('EXPIRED'), reviewerTone('REJECTED'), reviewerTone('NOT_NEEDED')]).toEqual(['success', 'info', 'warning', 'danger', 'neutral']);
    expect([extractionTone('EXTRACTED'), extractionTone('FAILED'), extractionTone('NO_TEXT'), extractionTone('PENDING')]).toEqual(['success', 'danger', 'warning', 'neutral']);
  });

  it('turns a refusal into the one word the screen has a sentence for', () => {
    expect(describeProblem(error('VERSION_CONFLICT', 409))).toBe('versionConflict');
    expect(describeProblem(error('DOC_VERSION_LOCKED', 409))).toBe('locked');
    expect(describeProblem(error('DOC_REVIEW_VERSION_NOT_NEWER', 422))).toBe('versionNotNewer');
    expect(describeProblem(error('WORKFLOW_NOT_CONFIGURED', 422))).toBe('workflowMissing');
    expect(describeProblem(error('SOMETHING_NEW', 403))).toBe('denied');
    expect(describeProblem(error('SOMETHING_NEW', 404))).toBe('notFound');
    expect(describeProblem(error('SOMETHING_NEW', 500))).toBe('general');
    expect(describeProblem(new Error('network'))).toBe('general');
  });

  it('folds runs of equal units and never folds a change', () => {
    const entries = [entry('EQUAL'), entry('EQUAL'), entry('CHANGED'), entry('EQUAL'), entry('ADDED')];
    const folded = foldEntries(entries, false);
    expect(folded.map((item) => item.kind)).toEqual(['equal', 'entry', 'equal', 'entry']);
    expect(folded[0]).toMatchObject({ kind: 'equal', from: 0 });
    expect((folded[0] as { entries: unknown[] }).entries).toHaveLength(2);
    expect(foldEntries(entries, true).every((item) => item.kind === 'entry')).toBe(true);
  });

  it('shows on each side the words that stayed and the ones that left or came in', () => {
    const changed = entry('CHANGED', {
      before: { citation_id: 'cit_00000000000000000001', label: 'p1', kind: 'PARAGRAPH', text: 'a 100 b', seq: 1 },
      after: { citation_id: 'cit_00000000000000000001', label: 'p1', kind: 'PARAGRAPH', text: 'a 120 b', seq: 1 },
      words: [
        { op: 'EQUAL', text: 'a' },
        { op: 'REMOVED', text: '100' },
        { op: 'ADDED', text: '120' },
        { op: 'EQUAL', text: 'b' },
      ],
    });
    expect(sideWords(changed, 'before')).toEqual([{ text: 'a', mark: false }, { text: '100', mark: true }, { text: 'b', mark: false }]);
    expect(sideWords(changed, 'after')).toEqual([{ text: 'a', mark: false }, { text: '120', mark: true }, { text: 'b', mark: false }]);
    expect(sideWords(entry('ADDED', { after: { citation_id: 'cit_00000000000000000002', label: 'p2', kind: 'PARAGRAPH', text: 'new', seq: 2 } }), 'after')).toEqual([{ text: 'new', mark: false }]);
    expect(sideWords(entry('ADDED'), 'before')).toEqual([]);
  });

  it('reads the id a command answers with and the options of a register, and refuses a shape that is not the contract', () => {
    expect(resourceIdOf({ resource_id: 'abc' })).toBe('abc');
    expect(resourceIdOf({})).toBeUndefined();
    expect(resourceIdOf(null)).toBeUndefined();
    expect(toLinkOption({ id: 'p1', code: 'DA-01', name: 'Cầu' }, 'name')).toEqual({ id: 'p1', label: 'DA-01 - Cầu', projectId: null });
    expect(toLinkOption({ id: 'c1', code: 'HD-1', project_id: 'p1' }, 'title')).toEqual({ id: 'c1', label: 'HD-1', projectId: 'p1' });
    expect(toLinkOption({ code: 'x' }, 'name')).toBeUndefined();
    expect(() => toDocumentPage({ items: 'no' })).toThrow();
    expect(() => toComparison({ entries: [] })).toThrow();
  });
});
