import { useId, useState } from 'react';
import { useTranslation } from '../../i18n';
import type { Translator } from '../../i18n';
import { ReadonlyStat, SectionCard, StatusPill, Stepper } from '../../ui';
import type { AdvisoryId } from './advisory-content';
import { BarList, BubbleChart, CheckMark, LockMark, Meter, MockTable, RadarChart, ScenarioChart } from './mock-charts';
import './adv-mock.css';

type T = Translator['t'];

/**
 * The mockups of the advisory group: what each function is planned to look like. Every figure is an example written for the mockup (the line above the mockup says so); nothing is read from the server and
 * no control changes anything. A control either does nothing (the question box) or only changes what the mockup shows (a suggested question, the expert chosen).
 */

const numbers = (count: number): number[] => Array.from({ length: count }, (_, index) => index + 1);

/** ADV-01: the question box, the recommendations of the week, the scenarios to the end of the year, the projects to move capital between and what each plan opens. */
const AI_ACTUAL = [1.2, 3.8, 7.5, 12.1, 17.0, 21.9];
const AI_SCENARIOS = [
  [21.9, 28, 35, 43, 52, 61, 71],
  [21.9, 30, 40, 51, 62, 73, 84],
  [21.9, 33, 45, 58, 70, 82, 93],
];
const AI_CONFIDENCE = [82, 68, 55];
/** Which plans hold each block: standard, pro, premium. */
const AI_BLOCKS: readonly (readonly [boolean, boolean, boolean])[] = [
  [true, true, true],
  [true, true, true],
  [false, true, true],
  [false, true, true],
  [false, false, true],
];

function CapitalAiMock({ t }: { t: T }) {
  const [question, setQuestion] = useState(1);
  const askId = useId();
  const plans = [t('adv.ai.plan.standard.name'), t('adv.ai.plan.pro.name'), t('adv.ai.plan.premium.name')];
  return (
    <div className="adv-mock">
      <div className="adv-col-5">
        <SectionCard title={t('adv.m1.ask.title')}>
          <div className="adv-ask">
            <label htmlFor={askId}>{t('adv.m1.ask.label')}</label>
            <span className="adv-ask__row">
              <input id={askId} type="text" readOnly value={t(`adv.m1.q${question}.text`)} />
              <button type="button" className="primary" disabled>
                {t('adv.m1.ask.send')}
              </button>
            </span>
          </div>
          <p className="adv-hint">{t('adv.m1.ask.hint')}</p>
          <div className="adv-chips" role="group" aria-label={t('adv.m1.ask.suggest')}>
            {numbers(3).map((n) => (
              <button type="button" key={n} className="adv-chip" aria-pressed={question === n} onClick={() => setQuestion(n)}>
                {t(`adv.m1.q${n}.text`)}
              </button>
            ))}
          </div>
        </SectionCard>
        <SectionCard title={t('adv.m1.recs.title')}>
          <ol className="adv-recs">
            {numbers(3).map((n) => (
              <li key={n}>
                <span className="adv-recs__rank" aria-hidden="true">
                  {n}
                </span>
                <div>
                  <strong>{t(`adv.m1.rec${n}.title`)}</strong>
                  <span className="adv-recs__effect">{t(`adv.m1.rec${n}.effect`)}</span>
                  <Meter percent={AI_CONFIDENCE[n - 1] ?? 0}>{t(`adv.m1.rec${n}.conf`)}</Meter>
                </div>
              </li>
            ))}
          </ol>
        </SectionCard>
      </div>
      <div className="adv-col-7">
        <SectionCard title={t('adv.m1.chart.title')}>
          <ScenarioChart
            alt={t('adv.m1.chart.alt')}
            months={numbers(12).map((n) => t('adv.mock.month.short', { n }))}
            actual={AI_ACTUAL}
            actualLabel={t('adv.m1.chart.actual')}
            scenarios={AI_SCENARIOS.map((values, index) => ({ id: `s${index + 1}`, label: t(`adv.m1.scen${index + 1}.name`), values }))}
            unit={t('adv.m1.chart.unit')}
          />
        </SectionCard>
        <SectionCard title={t('adv.m1.table.title')}>
          <MockTable
            label={t('adv.m1.table.title')}
            columns={[t('adv.m1.col.project'), t('adv.m1.col.owner'), t('adv.m1.col.plan'), t('adv.m1.col.rate'), t('adv.m1.col.move')]}
            rows={numbers(5).map((n) => [t(`adv.m1.row${n}.project`), t(`adv.m1.row${n}.owner`), t(`adv.m1.row${n}.plan`), t(`adv.m1.row${n}.rate`), t(`adv.m1.row${n}.move`)])}
          />
        </SectionCard>
      </div>
      <div className="adv-col-12">
        <SectionCard title={t('adv.m1.tiers.title')}>
          <ul className="adv-tiers">
            {plans.map((plan, at) => (
              <li key={plan} className="adv-tier">
                <h3>{plan}</h3>
                <ul>
                  {AI_BLOCKS.map((held, index) => (
                    <li key={index} className={held[at] ? 'adv-tier__open' : 'adv-tier__locked'}>
                      {held[at] ? <CheckMark /> : <LockMark />}
                      <span>{t(`adv.m1.block${index + 1}.name`)}</span>
                      <em>{held[at] ? t('adv.mock.state.open') : t('adv.mock.state.locked')}</em>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </SectionCard>
      </div>
    </div>
  );
}

/** ADV-02: the directory of experts, the sessions of the week, one session with its agenda, the steps of a consultation and how it is paid for. */
const EXPERT_SLOTS: readonly { day: number; booked: boolean }[] = [
  { day: 1, booked: false },
  { day: 2, booked: true },
  { day: 3, booked: false },
  { day: 4, booked: true },
  { day: 4, booked: false },
  { day: 5, booked: false },
];

function ExpertMock({ t }: { t: T }) {
  const [chosen, setChosen] = useState(1);
  return (
    <div className="adv-mock">
      <div className="adv-col-12">
        <SectionCard title={t('adv.m2.experts.title')}>
          <ul className="adv-cards">
            {numbers(3).map((n) => (
              <li key={n} className={`adv-person${chosen === n ? ' is-chosen' : ''}`}>
                <span className="adv-person__avatar" aria-hidden="true">
                  {n}
                </span>
                <div>
                  <h3>{t(`adv.m2.exp${n}.name`)}</h3>
                  <p>{t(`adv.m2.exp${n}.role`)}</p>
                  <p className="adv-person__field">{t(`adv.m2.exp${n}.field`)}</p>
                  <p className="adv-person__slot">{t(`adv.m2.exp${n}.slot`)}</p>
                  <button type="button" className="adv-chip" aria-pressed={chosen === n} onClick={() => setChosen(n)}>
                    {chosen === n ? t('adv.m2.exp.chosen') : t('adv.m2.exp.pick')}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </SectionCard>
      </div>
      <div className="adv-col-7">
        <SectionCard title={t('adv.m2.week.title')}>
          <ol className="adv-week">
            {numbers(5).map((day) => (
              <li key={day}>
                <h3>{t(`adv.m2.day${day}.name`)}</h3>
                <ul>
                  {EXPERT_SLOTS.map((slot, index) =>
                    slot.day !== day ? null : (
                      <li key={index} className={slot.booked ? 'adv-slot adv-slot--booked' : 'adv-slot'}>
                        <strong>{t(`adv.m2.slot${index + 1}.time`)}</strong>
                        <span>{t(`adv.m2.slot${index + 1}.text`)}</span>
                        <em>{slot.booked ? t('adv.mock.slot.booked') : t('adv.mock.slot.free')}</em>
                      </li>
                    ),
                  )}
                </ul>
              </li>
            ))}
          </ol>
        </SectionCard>
        <SectionCard title={t('adv.m2.flow.title')}>
          <ol className="adv-flow">
            {numbers(4).map((n) => (
              <li key={n}>
                <span className="adv-flow__n" aria-hidden="true">
                  {n}
                </span>
                <strong>{t(`adv.m2.flow${n}.name`)}</strong>
                <span>{t(`adv.m2.flow${n}.sub`)}</span>
              </li>
            ))}
          </ol>
        </SectionCard>
      </div>
      <div className="adv-col-5">
        <SectionCard title={t('adv.m2.session.title')} status={<StatusPill tone="info">{t('adv.mock.slot.booked')}</StatusPill>}>
          <h3 className="adv-doc__name">{t('adv.m2.session.name')}</h3>
          <p className="adv-hint">{t('adv.m2.session.when', { expert: t(`adv.m2.exp${chosen}.name`) })}</p>
          <h4 className="adv-sub">{t('adv.m2.session.agenda')}</h4>
          <ol className="adv-list">
            {numbers(3).map((n) => (
              <li key={n}>{t(`adv.m2.agenda${n}.text`)}</li>
            ))}
          </ol>
          <h4 className="adv-sub">{t('adv.m2.session.output')}</h4>
          <ul className="adv-list">
            {numbers(2).map((n) => (
              <li key={n}>{t(`adv.m2.out${n}.text`)}</li>
            ))}
          </ul>
        </SectionCard>
        <p className="callout adv-callout">{t('adv.m2.fee.note')}</p>
      </div>
    </div>
  );
}

/** ADV-03: the targets the options answer to, the options by impact and feasibility, and one draft decision with where it stands. */
const STRATEGY_BUBBLES: readonly (readonly [number, number, number])[] = [
  [78, 84, 3],
  [86, 62, 2],
  [62, 70, 2],
  [40, 52, 1],
  [24, 86, 3],
  [56, 30, 1],
];
const DRAFT_STEPS = ['done', 'current', 'upcoming', 'upcoming'] as const;

function StrategyMock({ t }: { t: T }) {
  return (
    <div className="adv-mock">
      <div className="adv-col-12">
        <SectionCard title={t('adv.m3.kpi.title')}>
          <div className="adv-kpis">
            {numbers(4).map((n) => (
              <ReadonlyStat key={n} label={t(`adv.m3.kpi${n}.label`)} value={t(`adv.m3.kpi${n}.value`)} sub={t(`adv.m3.kpi${n}.sub`)} tone={n === 3 ? 'warning' : n === 1 ? 'info' : 'default'} />
            ))}
          </div>
        </SectionCard>
      </div>
      <div className="adv-col-7">
        <SectionCard title={t('adv.m3.matrix.title')}>
          <BubbleChart
            alt={t('adv.m3.matrix.alt')}
            xLabel={t('adv.m3.axis.x')}
            yLabel={t('adv.m3.axis.y')}
            low={t('adv.mock.axis.low')}
            high={t('adv.mock.axis.high')}
            sizeNote={t('adv.m3.matrix.size')}
            bubbles={STRATEGY_BUBBLES.map(([x, y, size], index) => ({ id: `o${index + 1}`, x, y, size, label: t(`adv.m3.opt${index + 1}.name`), note: t(`adv.m3.opt${index + 1}.effect`) }))}
          />
        </SectionCard>
      </div>
      <div className="adv-col-5">
        <SectionCard title={t('adv.m3.draft.title')} status={<StatusPill tone="neutral">{t('adv.m3.draft.state')}</StatusPill>}>
          <div className="adv-doc">
            <h3 className="adv-doc__name">{t('adv.m3.draft.name')}</h3>
            <h4 className="adv-sub">{t('adv.m3.draft.sections')}</h4>
            <ol className="adv-doc__sections">
              {numbers(4).map((n) => (
                <li key={n}>
                  <span>{t(`adv.m3.sec${n}.name`)}</span>
                  <span className="adv-doc__lines" aria-hidden="true" />
                </li>
              ))}
            </ol>
          </div>
          <h4 className="adv-sub">{t('adv.m3.draft.steps')}</h4>
          <div>
            <Stepper label={t('adv.m3.draft.steps')} steps={DRAFT_STEPS.map((status, index) => ({ code: `s${index + 1}`, label: t(`adv.m3.step${index + 1}.name`), status }))} />
          </div>
        </SectionCard>
      </div>
    </div>
  );
}

/** ADV-04: the procedure in force beside the proposed one, the steps that take the longest and the changes proposed. */
const LANE_CURRENT = [10, 20, 15, 7, 5, 3];
const LANE_PROPOSED = [8, 18, 4, 3, 1];
const BOTTLENECKS: readonly (readonly [number, number])[] = [
  [2, 24],
  [3, 19],
  [1, 11],
  [4, 9],
  [5, 5],
];
const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);

function Lane({ t, name, prefix, days, tone }: { t: T; name: string; prefix: 'cur' | 'pro'; days: readonly number[]; tone: 'current' | 'proposed' }) {
  // What the lane saves against the procedure in force is drawn as an open block at its end, so the two lanes have the same length.
  const saved = sum(LANE_CURRENT) - sum(days);
  return (
    <div className={`adv-lane adv-lane--${tone}`}>
      <h3>
        {name} <span>{t('adv.m4.lane.total', { days: sum(days) })}</span>
      </h3>
      <ol>
        {days.map((count, index) => (
          <li key={index} style={{ flexGrow: count }}>
            <strong>{t(`adv.m4.${prefix}${index + 1}.name`)}</strong>
            <span>{t('adv.mock.days.count', { days: count })}</span>
          </li>
        ))}
        {saved === 0 ? null : (
          <li className="adv-lane__saved" style={{ flexGrow: saved }}>
            <strong>{t('adv.m4.lane.gap', { days: saved })}</strong>
          </li>
        )}
      </ol>
    </div>
  );
}

function ProcessMock({ t }: { t: T }) {
  return (
    <div className="adv-mock">
      <div className="adv-col-12">
        <SectionCard title={t('adv.m4.lanes.title')} status={<StatusPill tone="success">{t('adv.m4.lane.saved')}</StatusPill>}>
          <Lane t={t} name={t('adv.m4.lane.current')} prefix="cur" days={LANE_CURRENT} tone="current" />
          <Lane t={t} name={t('adv.m4.lane.proposed')} prefix="pro" days={LANE_PROPOSED} tone="proposed" />
        </SectionCard>
      </div>
      <div className="adv-col-5">
        <SectionCard title={t('adv.m4.bars.title')}>
          <BarList label={t('adv.m4.bars.title')} max={24} rows={BOTTLENECKS.map(([step, days], index) => ({ id: `b${index + 1}`, label: t(`adv.m4.cur${step}.name`), value: days, text: t(`adv.m4.bar${index + 1}.text`) }))} />
          <p className="adv-hint">{t('adv.m4.bars.note')}</p>
        </SectionCard>
      </div>
      <div className="adv-col-7">
        <SectionCard title={t('adv.m4.changes.title')}>
          <MockTable
            label={t('adv.m4.changes.title')}
            columns={[t('adv.m4.col.change'), t('adv.m4.col.units'), t('adv.m4.col.gain')]}
            rows={numbers(4).map((n) => [t(`adv.m4.ch${n}.name`), t(`adv.m4.ch${n}.units`), t(`adv.m4.ch${n}.gain`)])}
          />
        </SectionCard>
      </div>
    </div>
  );
}

/** ADV-05: the programmes by audience, the sessions of the month, the competencies before and after and how far each unit has come. */
const RADAR_BEFORE = [2.4, 2.8, 2.1, 3.0, 1.9];
const RADAR_AFTER = [3.9, 4.1, 3.8, 4.3, 3.4];
const UNIT_PROGRESS = [92, 78, 64, 50, 40];

function TrainingMock({ t }: { t: T }) {
  return (
    <div className="adv-mock">
      <div className="adv-col-12">
        <SectionCard title={t('adv.m5.catalog.title')}>
          <ul className="adv-cards">
            {numbers(3).map((n) => (
              <li key={n} className="adv-programme">
                <h3>{t(`adv.m5.aud${n}.name`)}</h3>
                <ul>
                  {numbers(2).map((p) => (
                    <li key={p}>
                      <strong>{t(`adv.m5.aud${n}p${p}.name`)}</strong>
                      <span>{t(`adv.m5.aud${n}p${p}.length`)}</span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </SectionCard>
      </div>
      <div className="adv-col-12">
        <SectionCard title={t('adv.m5.calendar.title')}>
          <ol className="adv-calendar">
            {numbers(5).map((n) => (
              <li key={n}>
                <span className="adv-calendar__date">{t(`adv.m5.ses${n}.date`)}</span>
                <strong>{t(`adv.m5.ses${n}.name`)}</strong>
                <span>{t(`adv.m5.ses${n}.who`)}</span>
              </li>
            ))}
          </ol>
        </SectionCard>
      </div>
      <div className="adv-col-5">
        <SectionCard title={t('adv.m5.radar.title')}>
          <RadarChart
            alt={t('adv.m5.radar.alt')}
            axes={numbers(5).map((n) => t(`adv.m5.cap${n}.name`))}
            before={RADAR_BEFORE}
            after={RADAR_AFTER}
            max={5}
            beforeLabel={t('adv.m5.radar.before')}
            afterLabel={t('adv.m5.radar.after')}
            scaleNote={t('adv.m5.radar.scale')}
          />
        </SectionCard>
      </div>
      <div className="adv-col-7">
        <SectionCard title={t('adv.m5.progress.title')}>
          <MockTable
            label={t('adv.m5.progress.title')}
            columns={[t('adv.m5.col.unit'), t('adv.m5.col.enrolled'), t('adv.m5.col.done')]}
            rows={numbers(5).map((n) => [
              t(`adv.m5.unit${n}.name`),
              t(`adv.m5.unit${n}.enrolled`),
              <Meter key="done" percent={UNIT_PROGRESS[n - 1] ?? 0}>
                {t(`adv.m5.unit${n}.done`)}
              </Meter>,
            ])}
          />
        </SectionCard>
      </div>
    </div>
  );
}

const MOCKS: Readonly<Record<AdvisoryId, (props: { t: T }) => JSX.Element>> = {
  'ADV-01': CapitalAiMock,
  'ADV-02': ExpertMock,
  'ADV-03': StrategyMock,
  'ADV-04': ProcessMock,
  'ADV-05': TrainingMock,
};

/** The mockup of a page of the group, under the line that says its figures are examples. */
export function AdvisoryMockup({ id }: { id: AdvisoryId }) {
  const { t } = useTranslation();
  const Mock = MOCKS[id];
  return (
    <div className="adv-mock-ground">
      <p className="adv-example" data-testid="adv-example-note">
        {t('adv.mock.example.note')}
      </p>
      <Mock t={t} />
    </div>
  );
}
