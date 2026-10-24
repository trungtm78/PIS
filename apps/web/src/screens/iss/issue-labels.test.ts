import { describe, expect, it } from 'vitest';
import en from '../../i18n/en.json';
import vi_ from '../../i18n/vi.json';
import { dueLabel, eventLabel, issueFieldMessage, issueProblemMessage, sourceLabel, statusLabel } from './issue-labels';
import { EVENT_KINDS, ISSUE_SOURCES, ISSUE_STATUSES } from './issue-model';
import type { DueState, FieldProblem, ProblemReason } from './issue-model';

/** A translator that answers the key it was asked for: a label that names no key of the catalogues is seen at once. */
const key = (name: string): string => name;
const catalogues = [vi_, en] as ReadonlyArray<Record<string, string>>;
const inBoth = (name: string): boolean => catalogues.every((catalogue) => typeof catalogue[name] === 'string');

describe('the labels of the issue screens name keys of both catalogues', () => {
  it('has a label for every status, source, event kind and deadline state, each different from the others', () => {
    const groups = [
      ISSUE_STATUSES.map((status) => statusLabel(key, status)),
      ISSUE_SOURCES.map((source) => sourceLabel(key, source)),
      EVENT_KINDS.map((kind) => eventLabel(key, kind, { from: 'a', to: 'b' })),
      (['closed', 'overdue', 'dueSoon', 'onTrack'] as DueState[]).map((state) => dueLabel(key, state)),
    ];
    for (const labels of groups) {
      expect(new Set(labels).size).toBe(labels.length);
      for (const label of labels) expect(inBoth(label)).toBe(true);
    }
  });

  it('has a message for every problem of a field and every refusal of a command', () => {
    const fields: FieldProblem[] = ['required', 'tooLong', 'invalidLatitude', 'invalidLongitude', 'invalidAccuracy', 'consentRequired', 'pairRequired', 'rejected'];
    const reasons: ProblemReason[] = ['noPolicy', 'duplicateSource', 'stateInvalid', 'assigneeOutOfScope', 'documentNotClean', 'versionConflict', 'operationConflict', 'validation', 'denied', 'notFound', 'general'];
    const messages = [...fields.map((problem) => issueFieldMessage(key, problem)), ...reasons.map((reason) => issueProblemMessage(key, { reason, field: undefined }))];
    expect(new Set(messages).size).toBe(messages.length);
    for (const message of messages) expect(inBoth(message)).toBe(true);
  });
});
