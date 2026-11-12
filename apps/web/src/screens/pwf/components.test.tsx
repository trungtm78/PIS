import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeViolations, seriousViolations } from '../../test/axe';
import { BandBadge, CalendarMissingCell, CalendarMissingNote, FigureInfo, ProblemBanner, UnverifiedLabel } from './components';
import { bandWord, blockerWord, dependencyWord, exceptionWord, formProblemText, gateWord, kindWord, missingReasonWord, priorityWord, problemText, remainingText, roleWord, statusWord, unitWord } from './labels';
import { BANDS, describeProblem } from './model';
import type { BlockerCode, DependencyKind, ExceptionKind, FormProblem, GateTarget, Priority, ProblemKind, TaskKind, TaskStatus } from './model';
import { band, refusal, text } from './test/fixtures';

afterEach(cleanup);

const wrap = (node: React.ReactElement) => render(<MemoryRouter>{node}</MemoryRouter>);

describe('PWF components: the band badge', () => {
  it('shows the word, the glyph and the days left in the unit of the source', () => {
    wrap(<BandBadge band={band('YELLOW')} />);
    expect(screen.getByText(text('pwf.band.yellow.word'))).toBeTruthy();
    expect(screen.getByText('⚠')).toBeTruthy();
    expect(screen.getByText(text('pwf.band.remaining.text', { days: 2, unit: text('pwf.unit.working.word') }))).toBeTruthy();
  });

  it('says overdue for a negative count and today for zero, in calendar days when the source counts them', () => {
    const { unmount } = wrap(<BandBadge band={band('RED', { unit: 'CALENDAR' })} />);
    expect(screen.getByText(text('pwf.band.overdue.text', { days: 2, unit: text('pwf.unit.calendar.word') }))).toBeTruthy();
    unmount();
    wrap(<BandBadge band={band('RED', { remaining_days: 0 })} />);
    expect(screen.getByText(text('pwf.band.today.text'))).toBeTruthy();
  });

  it('shows no days for a band that has none, and can leave them out', () => {
    const { container, unmount } = wrap(<BandBadge band={band('UNKNOWN', { reason: 'CALENDAR_UNAVAILABLE' })} />);
    expect(container.querySelector('.pwf-band__days')).toBeNull();
    expect(screen.getByText(text('pwf.band.unknown.word'))).toBeTruthy();
    unmount();
    const second = wrap(<BandBadge band={band('GREEN')} showDays={false} />);
    expect(second.container.querySelector('.pwf-band__days')).toBeNull();
  });
});

describe('PWF components: notices', () => {
  it('labels an unconfirmed template and names the missing calendar years, never a date', () => {
    wrap(
      <>
        <UnverifiedLabel />
        <CalendarMissingNote years={[2028, 2029]} />
        <CalendarMissingCell year={2028} />
        <CalendarMissingCell year={null} />
      </>,
    );
    expect(screen.getByText(text('pwf.common.unverified.label'))).toBeTruthy();
    expect(screen.getByTestId('calendar-missing').textContent).toContain('2028, 2029');
    expect(screen.getByText(text('pwf.common.calendarMissingYear.text', { year: 2028 }))).toBeTruthy();
    expect(screen.getByText(text('pwf.common.noDue.text'))).toBeTruthy();
  });

  it('says nothing when no calendar is missing', () => {
    const { container } = wrap(<CalendarMissingNote years={[]} />);
    expect(container.innerHTML).toBe('');
  });

  it('opens the "i" of a figure with formula, source and the day', () => {
    wrap(<FigureInfo name="Số việc" formula="đếm việc mở" source="Bảng việc" asOf="2026-11-12T03:00:00.000Z" version="Lịch v2" />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('dialog').textContent).toContain('đếm việc mở');
    expect(screen.getByRole('dialog').textContent).toContain('12/11/2026');
    expect(screen.getByRole('dialog').textContent).toContain(text('pwf.info.owner.label'));
  });
});

describe('PWF components: the refusal banner', () => {
  it('lists the blockers of a completion and the tasks a gate waits for, with a link to each task', () => {
    wrap(
      <ProblemBanner
        problem={describeProblem(
          refusal('PWF_GATE_CLOSED', 422, {
            blockers: [{ code: 'EVIDENCE_MISSING', subject: 'E1' }],
            missing: [
              { task: 'T1', task_id: '00000000-0000-4000-8000-000000000001', phase: 'P', reason: 'NOT_DONE' },
              { task: 'T2', task_id: null, phase: 'P', reason: 'NO_STATE' },
            ],
          }),
        )}
      />,
    );
    expect(screen.getByRole('alert').textContent).toContain(text('pwf.problem.gateClosed.error'));
    expect(screen.getByTestId('problem-blockers').textContent).toContain(text('pwf.blocker.evidence.text', { subject: 'E1' }));
    expect(screen.getByRole('link', { name: 'T1' }).getAttribute('href')).toContain('/pwf/pwf-04?id=00000000-0000-4000-8000-000000000001');
    expect(screen.getByTestId('problem-missing').textContent).toContain(text('pwf.missing.noState.text'));
  });

  it('offers to read the newer version for a conflict, and only then', () => {
    const reload = vi.fn();
    const { unmount } = wrap(<ProblemBanner problem={describeProblem(refusal('PWF_SCHEDULE_VERSION_CONFLICT', 409))} onReload={reload} />);
    fireEvent.click(screen.getByText(text('pwf.problem.reload.action')));
    expect(reload).toHaveBeenCalledTimes(1);
    unmount();
    wrap(<ProblemBanner problem={describeProblem(refusal('SELF_APPROVAL_DENIED'))} onReload={reload} />);
    expect(screen.queryByText(text('pwf.problem.reload.action'))).toBeNull();
  });

  it('has no serious accessibility violation', async () => {
    const { container } = wrap(
      <main>
        <BandBadge band={band('RED')} />
        <ProblemBanner problem={describeProblem(refusal('PWF_TASK_COMPLETION_BLOCKED', 422, { blockers: [{ code: 'FORM_MISSING', subject: 'F1' }] }))} />
        <CalendarMissingNote years={[2028]} />
      </main>,
    );
    expect(describeViolations(await seriousViolations(container))).toEqual([]);
  });
});

describe('PWF labels', () => {
  const t = (key: string, params?: Record<string, string | number>) => text(key, params);

  it('has a word for every value of every enumeration of the contract', () => {
    const statuses: TaskStatus[] = ['NOT_STARTED', 'IN_PROGRESS', 'AWAITING_APPROVAL', 'DONE', 'ON_HOLD', 'CANCELLED'];
    const kinds: TaskKind[] = ['TASK', 'MILESTONE'];
    const priorities: Priority[] = ['LOW', 'NORMAL', 'HIGH', 'CRITICAL'];
    const dependencies: DependencyKind[] = ['FS', 'SS', 'FF', 'SF'];
    const gates: GateTarget[] = ['submitProjectForAppraisal', 'decideProjectAppraisal', 'capital.plan_published.v1', 'startProjectImplementation', 'suspendProject', 'resumeProject', 'completeProject', 'settlement.closed.v1', 'closeProject'];
    const exceptions: ExceptionKind[] = ['WAIVE_REQUIREMENT', 'CANCEL_TASK', 'PAUSE', 'EXTERNAL_DELAY'];
    const blockers: BlockerCode[] = ['CHECKLIST_ITEM_OPEN', 'EVIDENCE_MISSING', 'LEGAL_DOC_MISSING', 'FORM_MISSING', 'APPROVER_REQUIRED', 'MAKER_IS_APPROVER'];
    const words = [
      ...BANDS.map((one) => bandWord(t, one)),
      ...statuses.map((one) => statusWord(t, one)),
      ...kinds.map((one) => kindWord(t, one)),
      ...priorities.map((one) => priorityWord(t, one)),
      ...dependencies.map((one) => dependencyWord(t, one)),
      ...gates.map((one) => gateWord(t, one)),
      ...exceptions.map((one) => exceptionWord(t, one)),
      ...(['RESPONSIBLE', 'ACCOUNTABLE', 'CONSULTED', 'INFORMED'] as const).map((one) => roleWord(t, one)),
      ...blockers.map((one) => blockerWord(t, one, 'X')),
      ...(['NO_STATE', 'NOT_DONE', 'COMPLETION_NOT_APPROVED', 'CANCELLED_WITHOUT_APPROVAL'] as const).map((one) => missingReasonWord(t, one)),
      unitWord(t, 'WORKING'),
      unitWord(t, 'CALENDAR'),
    ];
    expect(words.every((word) => word !== '' && !word.startsWith('pwf.'))).toBe(true);
    expect(new Set(words).size).toBeGreaterThan(40);
  });

  it('has a sentence for every kind of refusal and every form problem', () => {
    const kinds: ProblemKind[] = [
      'versionConflict',
      'scheduleConflict',
      'selfApproval',
      'completionBlocked',
      'gateClosed',
      'taskState',
      'workflowExists',
      'templateNotFound',
      'factsRequired',
      'adoptInvalid',
      'scheduleInvalid',
      'dependencyCycle',
      'calendarNotEffective',
      'reschedulePending',
      'exceptionInvalid',
      'assignmentInvalid',
      'legalDocUnknown',
      'templateInvalid',
      'bandThresholds',
      'bandUnit',
      'validation',
      'notFound',
      'denied',
      'general',
    ];
    for (const kind of kinds) {
      expect(problemText(t, { kind, field: undefined, blockers: [], missing: [] })).not.toMatch(/^pwf\./);
    }
    expect(problemText(t, { kind: 'templateInvalid', field: 'tasks[0]', blockers: [], missing: [] })).toContain('tasks[0]');
    expect(problemText(t, { kind: 'validation', field: 'reason', blockers: [], missing: [] })).toContain('reason');
    const form: FormProblem[] = ['required', 'tooShort', 'tooLong', 'invalidDay', 'invalidNumber', 'pickOne'];
    for (const problem of form) expect(formProblemText(t, problem, { min: 20, max: 80 })).not.toMatch(/^pwf\./);
    expect(formProblemText(t, 'tooShort', { min: 20 })).toContain('20');
    expect(formProblemText(t, 'tooShort')).toContain('0');
  });

  it('writes the days left of a band, and nothing for a band without a count', () => {
    expect(remainingText(t, band('GREEN'))).toContain('5');
    expect(remainingText(t, band('NONE'))).toBeUndefined();
  });
});
