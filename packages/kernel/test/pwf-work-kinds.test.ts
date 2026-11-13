import { WORK_KINDS, compareWork } from '../src/home-work';
import type { WorkKind } from '../src/home-work';
import { builtInCodes, builtInDefault, registerAllGovernanceRules } from '../src/governance-rules';
import { message } from '../src/messages';

const PWF_KINDS = ['PWF_TASK_DUE_SOON', 'PWF_TASK_OVERDUE', 'PWF_MILESTONE_AT_RISK', 'PWF_LEGAL_BASIS_LAPSED'] as const;
const entry = (kind: WorkKind) => ({ id: 'x', kind, dueOn: '2027-01-01', originalDueOn: '2027-01-01' });

beforeAll(() => registerAllGovernanceRules());

/** PWF-2: the tasks of the project workflow as work of the alert centre (R30). */
describe('the kinds of work of the tasks of a workflow', () => {
  it('lists each kind once, with one alert type of the same code (owner, action and consequence) and the source PROJECT_TASK', () => {
    expect(new Set(WORK_KINDS).size).toBe(WORK_KINDS.length);
    for (const kind of PWF_KINDS) {
      expect(WORK_KINDS as readonly string[]).toContain(kind);
      const type = builtInDefault('ALERT_TYPE', kind);
      expect(type?.params.source).toBe('PROJECT_TASK');
      expect(type?.params.owner).toBeTruthy();
      expect(String(type?.params.expected_action).length).toBeGreaterThan(10);
      expect(String(type?.params.consequence).length).toBeGreaterThan(10);
      expect(type?.params.response_hours).toBeGreaterThan(0);
    }
    const typed = builtInCodes('ALERT_TYPE').filter((code) => builtInDefault('ALERT_TYPE', code)?.params.source === 'PROJECT_TASK');
    expect([...typed].sort()).toEqual([...PWF_KINDS].sort());
  });

  it('gives each kind a priority of its own among all kinds, an overdue task before a milestone at risk before a task that is only due soon', () => {
    const tied: string[] = [];
    for (const left of PWF_KINDS) for (const right of WORK_KINDS) if (left !== right && compareWork(entry(left), entry(right), '2027-01-01') === 0) tied.push(`${left} ${right}`);
    expect(tied).toEqual([]);
    expect(compareWork(entry('PWF_TASK_OVERDUE'), entry('PWF_MILESTONE_AT_RISK'), '2027-01-01')).toBeLessThan(0);
    expect(compareWork(entry('PWF_MILESTONE_AT_RISK'), entry('PWF_TASK_DUE_SOON'), '2027-01-01')).toBeLessThan(0);
  });

  it('has a consequence sentence of its own for each kind, and the words of every title', () => {
    const sentences = PWF_KINDS.map((kind) => message(`home.consequence.${kind.toLowerCase()}`));
    expect(new Set(sentences).size).toBe(sentences.length);
    for (const sentence of sentences) expect(sentence.length).toBeGreaterThan(20);
    expect(message('home.source.pwf.due_soon.title', { task: 'Lập báo cáo', project: 'P-1', days: 3 })).toContain('3 ngày làm việc');
    expect(message('home.source.pwf.due_today.title', { task: 'Lập báo cáo', project: 'P-1' })).toContain('hôm nay');
    expect(message('home.source.pwf.overdue.title', { task: 'Lập báo cáo', project: 'P-1', days: 2 })).toContain('quá hạn 2');
    expect(message('home.source.pwf.overdue.escalated.title', { task: 'Lập báo cáo', project: 'P-1', days: 3 })).toContain('cấp quản lý');
    expect(message('home.source.pwf.milestone.title', { task: 'Mốc A', project: 'P-1', days: 6 })).toContain('trễ 6 ngày');
    expect(message('home.source.pwf.detail', { code: 'T1', phase: 'P1', date: '2027-01-02' })).toContain('02/01/2027');
    expect(message('home.source.pwf.detail.critical', { code: 'T1', phase: 'P1', date: '2027-01-02' })).toContain('đường găng');
    expect(message('home.source.pwf.milestone.detail', { code: 'T1', baseline: '2027-01-02', date: '2027-01-09' })).toContain('dự báo 09/01/2027');
  });
});
