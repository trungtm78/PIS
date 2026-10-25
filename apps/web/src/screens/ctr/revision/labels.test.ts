import { describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { decisionLabel, decisionProblemMessage, decisionSubmitLabel, kindLabel, lineChangeLabel, standingLabel } from './labels';
import { DECISIONS } from './model';
import type { DecisionProblem, LineChange, Standing } from './model';

const t = (key: string): string => (vi_ as Record<string, string>)[key] ?? `MISSING ${key}`;

describe('the words of the revisions and of the decision', () => {
  it('names each decision and the button that sends it', () => {
    expect(DECISIONS.map((decision) => decisionLabel(t, decision))).toEqual([vi_['ctr.revision.decision.approve'], vi_['ctr.revision.decision.return'], vi_['ctr.revision.decision.reject']]);
    expect(DECISIONS.map((decision) => decisionSubmitLabel(t, decision))).toEqual([vi_['ctr.revision.submit.approve'], vi_['ctr.revision.submit.return'], vi_['ctr.revision.submit.reject']]);
  });

  it('names how a revision stands, and says plainly that one that waits is not used for payment', () => {
    const standings: Standing[] = ['IN_FORCE', 'WAITING', 'OVER', 'DRAFT', 'REJECTED'];
    expect(standings.map((standing) => standingLabel(t, standing))).toEqual([
      vi_['ctr.revision.standing.inForce'],
      vi_['ctr.revision.standing.waiting'],
      vi_['ctr.revision.standing.over'],
      vi_['ctr.revision.standing.draft'],
      vi_['ctr.revision.standing.rejected'],
    ]);
    expect(vi_['ctr.revision.standing.waiting']).toContain('không dùng cho thanh toán');
  });

  it('names the kinds of revision, and a kind it does not know by itself', () => {
    expect(['BASE', 'AMENDMENT', 'CHANGE_ORDER', 'OTHER'].map((kind) => kindLabel(t, kind))).toEqual([vi_['ctr.revision.kind.base'], vi_['ctr.revision.kind.amendment'], vi_['ctr.revision.kind.changeOrder'], 'OTHER']);
  });

  it('names what became of a line', () => {
    const changes: LineChange[] = ['ADDED', 'REMOVED', 'CHANGED', 'SAME'];
    expect(changes.map((change) => lineChangeLabel(t, change))).toEqual([vi_['ctr.revision.line.added'], vi_['ctr.revision.line.removed'], vi_['ctr.revision.line.changed'], vi_['ctr.revision.line.same']]);
  });

  it('says what is wrong with a field of the decision', () => {
    const problems: DecisionProblem[] = ['choose', 'date', 'past', 'evidence', 'json', 'required', 'tooLong', 'amount', 'days', 'uuid'];
    const messages = problems.map((problem) => decisionProblemMessage(t, problem));
    expect(messages.some((message) => message.startsWith('MISSING'))).toBe(false);
    expect(new Set(messages).size).toBe(problems.length);
  });
});
