import { WORK_KINDS, compareWork } from '../src/home-work';
import type { WorkKind } from '../src/home-work';
import { builtInCodes, builtInDefault, registerAllGovernanceRules } from '../src/governance-rules';
import { message } from '../src/messages';

const RISK_KINDS = ['RISK_SCORE_CRITICAL', 'RISK_SCORE_JUMP'] as const;
const COMMITTEE_KINDS = ['COMMITTEE_PROVINCE_BEHIND', 'COMMITTEE_SECTOR_BEHIND', 'COMMITTEE_UNIT_NOT_REPORTING', 'COMMITTEE_DIRECTIVE_OVERDUE'] as const;
const SOURCES: Readonly<Record<string, readonly string[]>> = { PROJECT_RISK: RISK_KINDS, COMMITTEE: COMMITTEE_KINDS };

const entry = (kind: WorkKind) => ({ id: 'x', kind, dueOn: '2027-01-01', originalDueOn: '2027-01-01' });

beforeAll(() => registerAllGovernanceRules());

/** HUBADAPT step 4: the alerts of the risk register (MR-1) and of the committee (BAN-1) as work of the alert centre. */
describe('the kinds of work of the risk register and of the committee', () => {
  it('lists each kind once, with one alert type of the registry of the same code and the source that names it', () => {
    expect(new Set(WORK_KINDS).size).toBe(WORK_KINDS.length);
    for (const [source, kinds] of Object.entries(SOURCES)) {
      for (const kind of kinds) {
        expect(WORK_KINDS as readonly string[]).toContain(kind);
        const type = builtInDefault('ALERT_TYPE', kind);
        expect(type).toBeDefined();
        expect(type?.params.source).toBe(source);
        expect(type?.params.owner).toBeTruthy();
        expect(String(type?.params.expected_action).length).toBeGreaterThan(10);
        expect(String(type?.params.consequence).length).toBeGreaterThan(10);
      }
    }
  });

  it('leaves no alert type of these two sources without a kind of work', () => {
    for (const [source, kinds] of Object.entries(SOURCES)) {
      const typed = builtInCodes('ALERT_TYPE').filter((code) => builtInDefault('ALERT_TYPE', code)?.params.source === source);
      expect({ source, codes: [...typed].sort() }).toEqual({ source, codes: [...kinds].sort() });
    }
  });

  it('gives each of these kinds a priority of its own among all kinds, so that the order of two items of the same day never depends on chance', () => {
    const tied: string[] = [];
    for (const left of [...RISK_KINDS, ...COMMITTEE_KINDS]) {
      for (const right of WORK_KINDS) {
        if (left !== right && compareWork(entry(left), entry(right), '2027-01-01') === 0) tied.push(`${left} ${right}`);
      }
    }
    expect(tied).toEqual([]);
  });

  it('puts a critical risk before a jump, and the head of the committee before the secretariat of the same day', () => {
    expect(compareWork(entry('RISK_SCORE_CRITICAL'), entry('RISK_SCORE_JUMP'), '2027-01-01')).toBeLessThan(0);
    expect(compareWork(entry('COMMITTEE_PROVINCE_BEHIND'), entry('COMMITTEE_UNIT_NOT_REPORTING'), '2027-01-01')).toBeLessThan(0);
  });

  it('has a consequence sentence of its own for each kind, and the words of the titles', () => {
    const sentences = [...RISK_KINDS, ...COMMITTEE_KINDS].map((kind) => message(`home.consequence.${kind.toLowerCase()}`));
    expect(new Set(sentences).size).toBe(sentences.length);
    for (const sentence of sentences) expect(sentence.length).toBeGreaterThan(20);
    expect(message('home.source.risk.critical.title', { project: 'P-1', score: 20 })).toContain('P-1');
    expect(message('home.source.committee.directive_overdue.title', { label: 'Sở Xây dựng', value: 3 })).toContain('3');
  });
});
