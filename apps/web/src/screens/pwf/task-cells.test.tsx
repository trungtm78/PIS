import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { t as translate } from '../../i18n';
import { describeViolations, seriousViolations } from '../../test/axe';
import { BandDot, BlockedByCell, DeadlineCell, ExtensionNote, RemainingCell, TierInfo, UnitHolderCell, ladderText, tierSentence, tierWord } from './task-cells';
import { band, uuid, workflowTask } from './test/fixtures';
import { dayText } from './model';

afterEach(cleanup);

const text = (key: string, params: Record<string, string | number> = {}) => translate(key, params);
const unit = (n: number, name: string, part: 'LEAD' | 'SUPPORT' = 'LEAD') => ({ unit_ref: `UNIT:${n}`, unit_id: uuid(n), unit_name: name, role: 'PROJECT_MANAGER', part });

describe('cell: unit and holder', () => {
  it('says the unit and the person who holds the task', () => {
    const task = workflowTask(1, { receiving_unit_id: uuid(5), receiving_unit_name: 'Sở Xây dựng', receiving_units: [unit(5, 'Sở Xây dựng')], assignee: { membership_id: uuid(9), display_name: 'Trần Văn Hùng' } });
    render(<UnitHolderCell task={task} />);
    expect(screen.getByTestId('cell-unit').textContent).toBe('Sở Xây dựng · Trần Văn Hùng');
    expect(screen.queryByTestId('cell-unclaimed')).toBeNull();
  });

  it('says "nobody has taken it" in words for a task of a unit with no holder, never a blank', () => {
    render(<UnitHolderCell task={workflowTask(1, { receiving_unit_name: 'UBND tỉnh', receiving_units: [unit(5, 'UBND tỉnh')], assignee: null, unclaimed: true })} />);
    expect(screen.getByTestId('cell-unit').textContent).toContain('UBND tỉnh');
    expect(screen.getByTestId('cell-unclaimed').textContent).toContain(text('pwfp.cell.unclaimed.word'));
  });

  it('lists the supporting units as a note and takes the name of the lead from the lead line', () => {
    const task = workflowTask(1, { receiving_units: [unit(6, 'Sở Tài chính', 'SUPPORT'), unit(5, 'Chủ đầu tư')], assignee: null });
    render(<UnitHolderCell task={task} />);
    const cell = screen.getByTestId('cell-unit');
    expect(cell.textContent).toContain('Chủ đầu tư');
    expect(cell.textContent).toContain(text('pwfp.cell.support.text', { units: 'Sở Tài chính' }));
  });

  it('shows the person alone for a task with no receiving unit, and says "not assigned" when there is nobody', () => {
    const { unmount } = render(<UnitHolderCell task={workflowTask(1)} />);
    expect(screen.getByTestId('cell-unit').textContent).toBe('Nguyễn Văn An');
    unmount();
    render(<UnitHolderCell task={workflowTask(1, { assignee: null })} />);
    expect(screen.getByTestId('cell-unit').textContent).toBe(text('pwfp.cell.unassigned.text'));
  });

  it('says only a dash about who is missing on a task that is over', () => {
    render(<UnitHolderCell task={workflowTask(1, { assignee: null, status: 'DONE' })} />);
    expect(screen.getByTestId('cell-unit').textContent).toBe('–');
  });
});

describe('cell: deadline', () => {
  it('shows the committed day, the forecast when it is another day and the star of the deadline of the whole file', () => {
    render(<DeadlineCell task={workflowTask(1, { planned_finish: '2026-12-10', forecast_finish: '2026-12-15', is_overall_deadline: true, status: 'IN_PROGRESS' })} />);
    const cell = screen.getByTestId('cell-deadline');
    expect(cell.textContent).toContain('10/12/2026');
    expect(cell.textContent).toContain(text('pwf6.forecast.finish.text', { day: dayText('2026-12-15') }));
    expect(screen.getByTestId('cell-overall').textContent).toContain(text('pwfp.cell.overall.word'));
  });

  it('names the calendar year that is missing and never a date', () => {
    render(<DeadlineCell task={workflowTask(1, { state: 'CALENDAR_UNAVAILABLE', missing_year: 2028, planned_finish: null, band: band('UNKNOWN', { reason: 'CALENDAR_UNAVAILABLE' }) })} />);
    expect(screen.getByTestId('cell-deadline').textContent).toContain(text('pwf.common.calendarMissingYear.text', { year: 2028 }));
  });
});

describe('cell: the official colour', () => {
  it('shows the colour exactly as the server gave it, with its word and the days left, and never turns one into another', () => {
    for (const given of ['RED', 'YELLOW', 'GREEN'] as const) {
      const { unmount } = render(<RemainingCell task={workflowTask(1, { status: 'IN_PROGRESS', band: band(given) })} />);
      const cell = screen.getByTestId('cell-remaining');
      expect(cell.getAttribute('data-band')).toBe(given);
      expect(within(cell).getByRole('img').getAttribute('data-band')).toBe(given);
      expect(cell.textContent).toContain(text(`pwf.band.${given.toLowerCase()}.word`));
      unmount();
    }
    render(<RemainingCell task={workflowTask(1, { status: 'IN_PROGRESS', band: band('RED', { remaining_days: -2 }) })} />);
    expect(screen.getByTestId('cell-remaining').textContent).toContain(text('pwf.band.overdue.text', { days: 2, unit: text('pwf.unit.working.word') }));
  });

  it('gives a task that is over no colour, and a deadline that cannot be counted the grey dot and the word "unknown"', () => {
    const { unmount } = render(<RemainingCell task={workflowTask(1, { status: 'DONE', band: band('RED') })} />);
    expect(screen.queryByTestId('cell-remaining')).toBeNull();
    expect(screen.getByText(text('pwfp.cell.done.word'))).toBeTruthy();
    unmount();
    render(<RemainingCell task={workflowTask(1, { status: 'IN_PROGRESS', band: band('UNKNOWN', { reason: 'CALENDAR_UNAVAILABLE' }) })} />);
    const cell = screen.getByTestId('cell-remaining');
    expect(cell.getAttribute('data-band')).toBe('UNKNOWN');
    expect(cell.textContent).toContain(text('pwf.band.unknown.word'));
    expect(cell.querySelector('[data-band="GREEN"]')).toBeNull();
  });

  it('puts a name on the dot for a screen reader', () => {
    render(<BandDot band="YELLOW" />);
    expect(screen.getByRole('img', { name: text('pwfp.cell.band.aria', { band: text('pwf.band.yellow.word') }) })).toBeTruthy();
  });

  it('explains the tier of the ladder in words: the step, the policy or the system, with the numbers', () => {
    const ladder = { green_days: 5, yellow_days: 2, red_days: 0 };
    const task = workflowTask(1, { status: 'IN_PROGRESS', band: band('YELLOW'), band_tier: 'STEP', band_thresholds: ladder });
    render(<RemainingCell task={task} asOf="2026-11-12T03:00:00.000Z" />);
    fireEvent.click(screen.getByRole('button', { name: /Công thức và nguồn của/ }));
    const panel = screen.getByRole('dialog');
    expect(panel.textContent).toContain(text('pwfp.cell.tier.step.text'));
    expect(panel.textContent).toContain(tierWord((k, p) => text(k, p), 'STEP'));
    expect(panel.textContent).toContain(ladderText((k, p) => text(k, p), ladder));
  });

  it('has one word and one sentence for each tier, and the exceptions of the policy count as the policy', () => {
    const t = (k: string, p?: Record<string, string | number>) => text(k, p);
    expect(tierWord(t, 'STEP')).toBe('Bước');
    expect(tierWord(t, 'POLICY')).toBe('Chính sách');
    expect(tierWord(t, 'POLICY_OVERRIDE')).toBe('Chính sách');
    expect(tierWord(t, 'SYSTEM')).toBe('Hệ thống');
    expect(new Set((['STEP', 'POLICY_OVERRIDE', 'POLICY', 'SYSTEM'] as const).map((tier) => tierSentence(t, tier))).size).toBe(4);
  });

  it('writes the ladder with "red once overdue" for a red line of -1 and "green above yellow" for no green line', () => {
    const t = (k: string, p?: Record<string, string | number>) => text(k, p);
    expect(ladderText(t, { green_days: 5, yellow_days: 2, red_days: 0 })).toBe('Đỏ từ khi còn 0 ngày làm việc · Vàng từ khi còn 2 · Xanh từ khi còn 5');
    expect(ladderText(t, { green_days: null, yellow_days: 3, red_days: -1 })).toBe('Đỏ khi đã quá hạn · Vàng từ khi còn 3 · Xanh khi còn nhiều hơn 3');
  });

  it('has no "i" when the server sent no tier', () => {
    render(<TierInfo task={{}} asOf={undefined} />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('cell: what blocks', () => {
  it('lists what the row waits for, one line each', () => {
    render(<BlockedByCell blocks={[{ kind: 'approval' }, { kind: 'evidence', open: 2 }, { kind: 'predecessor', code: 'T1', name: 'Thẩm định' }]} />);
    const list = screen.getByTestId('cell-blocked');
    expect(within(list).getAllByRole('listitem').map((item) => item.textContent)).toEqual([text('pwfp.cell.blocked.approval.text'), text('pwfp.cell.blocked.evidence.text', { count: 2 }), text('pwfp.cell.blocked.predecessor.text', { name: 'Thẩm định' })]);
  });

  it('says "not blocked" to a screen reader when there is nothing', () => {
    render(<BlockedByCell blocks={[]} />);
    expect(screen.getByTestId('cell-blocked-none').textContent).toContain(text('pwfp.cell.blocked.none.text'));
  });
});

describe('cell: extension', () => {
  const rule = { allowed: true, max_times: 1, max_value: 10, unit: 'WORKING_DAY' as const, times_used: 0, value_used: 3 };

  it('shows how much of the limit is used, in the unit of the step', () => {
    render(<ExtensionNote task={{ extension: rule }} />);
    expect(screen.getByTestId('cell-extension').textContent).toBe(text('pwfp.cell.extension.used.text', { times: '0/1 lần', value: '3/10 ngày làm việc' }));
  });

  it('says a limit that is not set is not limited, and that a step may not be extended', () => {
    const { unmount } = render(<ExtensionNote task={{ extension: { ...rule, max_times: null, max_value: null, unit: 'MONTH' } }} />);
    expect(screen.getByTestId('cell-extension').textContent).toContain('không giới hạn số lần');
    expect(screen.getByTestId('cell-extension').textContent).toContain('không giới hạn tổng');
    unmount();
    render(<ExtensionNote task={{ extension: { ...rule, allowed: false } }} />);
    expect(screen.getByTestId('cell-extension').textContent).toBe(text('pwfp.cell.extension.denied.text'));
  });

  it('shows nothing for a step whose template has no extension rule', () => {
    render(<ExtensionNote task={{}} />);
    expect(screen.queryByTestId('cell-extension')).toBeNull();
  });
});

describe('cells: accessibility', () => {
  it('has no serious violation with every cell on screen', async () => {
    const task = workflowTask(1, { status: 'IN_PROGRESS', band: band('RED'), band_tier: 'POLICY', band_thresholds: { green_days: 5, yellow_days: 2, red_days: 0 }, receiving_unit_name: 'Sở Xây dựng', unclaimed: true, assignee: null, extension: { allowed: true, max_times: 1, max_value: 10, unit: 'WORKING_DAY', times_used: 0, value_used: 0 } });
    const { container } = render(
      <table>
        <caption>cells</caption>
        <tbody>
          <tr>
            <td>
              <UnitHolderCell task={task} />
            </td>
            <td>
              <DeadlineCell task={task} />
            </td>
            <td>
              <RemainingCell task={task} asOf="2026-11-12T03:00:00.000Z" />
            </td>
            <td>
              <BlockedByCell blocks={[{ kind: 'approval' }]} />
              <ExtensionNote task={task} />
            </td>
          </tr>
        </tbody>
      </table>,
    );
    expect(describeViolations(await seriousViolations(container))).toEqual([]);
  });
});
