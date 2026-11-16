import { useTranslation } from '../../i18n';
import type { Translator } from '../../i18n';
import { StatusPill } from '../../ui';
import { CalendarMissingCell, FigureInfo, Forecast } from './components';
import { bandWord, remainingText } from './labels';
import { calendarMissing, dayText, hasBand } from './model';
import type { WorkflowTask } from './model';
import type { BlockedBy } from './workflow/step-table-model';
import './pwf-cells.css';

type T = Translator['t'];

/**
 * The small read-only cells every screen of the project workflow shares (R69): who answers (unit and holder), the deadline with its forecast and star, the official colour as a dot with the "i" that says which tier of the ladder
 * judged it, what blocks the row, and the state of an extension. They show what the server read and decide nothing: the band, the days left, the unit and the holder are the server's.
 */

/** What a cell reads of a task: the fields every read of a task has, and the ones that came with the redesign (all optional, so an answer kept from before still shows). */
export type CellTask = Pick<WorkflowTask, 'status' | 'excluded' | 'tracked' | 'state' | 'missing_year' | 'planned_finish' | 'band'> &
  Partial<Pick<WorkflowTask, 'band_tier' | 'band_thresholds' | 'receiving_unit_name' | 'receiving_units' | 'unclaimed' | 'assignee' | 'forecast_finish' | 'is_overall_deadline' | 'extension'>>;

// ---- the words ------------------------------------------------------------------------------------------------------------------------------------------------------------

export type BandTier = NonNullable<WorkflowTask['band_tier']>;

/** The tier of the ladder in one word: the step, the policy or the system (the policy covers its exceptions). Each key is written out so that the i18n check sees it. */
export function tierWord(t: T, tier: BandTier): string {
  switch (tier) {
    case 'STEP':
      return t('pwfp.cell.tier.step.word');
    case 'POLICY_OVERRIDE':
    case 'POLICY':
      return t('pwfp.cell.tier.policy.word');
    case 'SYSTEM':
      return t('pwfp.cell.tier.system.word');
  }
}

/** The sentence that says where the ladder of a colour comes from. */
export function tierSentence(t: T, tier: BandTier): string {
  switch (tier) {
    case 'STEP':
      return t('pwfp.cell.tier.step.text');
    case 'POLICY_OVERRIDE':
      return t('pwfp.cell.tier.override.text');
    case 'POLICY':
      return t('pwfp.cell.tier.policy.text');
    case 'SYSTEM':
      return t('pwfp.cell.tier.system.text');
  }
}

/** The ladder in words: from how many working days left each colour starts ("Đỏ từ khi còn 1 ngày làm việc · Vàng từ khi còn 2 · Xanh từ khi còn 3"); a red line of -1 is "red once overdue", no green line is "green above yellow". */
export function ladderText(t: T, ladder: NonNullable<WorkflowTask['band_thresholds']>): string {
  const red = ladder.red_days < 0 ? t('pwfp.cell.ladder.redOver.text') : t('pwfp.cell.ladder.red.text', { days: ladder.red_days });
  const yellow = t('pwfp.cell.ladder.yellow.text', { days: ladder.yellow_days });
  const green = ladder.green_days === null ? t('pwfp.cell.ladder.greenOpen.text', { days: ladder.yellow_days }) : t('pwfp.cell.ladder.green.text', { days: ladder.green_days });
  return `${red} · ${yellow} · ${green}`;
}

export function extensionUnitWord(t: T, unit: NonNullable<WorkflowTask['extension']>['unit']): string {
  switch (unit) {
    case 'WORKING_DAY':
      return t('pwfp.cell.unit.workingDay.word');
    case 'CALENDAR_DAY':
      return t('pwfp.cell.unit.calendarDay.word');
    case 'MONTH':
      return t('pwfp.cell.unit.month.word');
  }
}

export function blockedWord(t: T, block: BlockedBy): string {
  switch (block.kind) {
    case 'approval':
      return t('pwfp.cell.blocked.approval.text');
    case 'evidence':
      return t('pwfp.cell.blocked.evidence.text', { count: block.open });
    case 'predecessor':
      return t('pwfp.cell.blocked.predecessor.text', { name: block.name });
  }
}

// ---- unit and holder -----------------------------------------------------------------------------------------------------------------------------------------------------

/**
 * Who answers for a task: the unit that receives it and the person who holds it, "Sở Xây dựng · Trần Văn Hùng"; a task nobody took says "Chưa có người nhận" in its own words (R71), never a blank. A task with no receiving unit (a template
 * from before units) shows the person alone, or says it is not assigned. Supporting units come after, as a note.
 */
export function UnitHolderCell({ task }: { task: Pick<CellTask, 'receiving_unit_name' | 'receiving_units' | 'unclaimed' | 'assignee' | 'status' | 'excluded'> }) {
  const { t } = useTranslation();
  const units = task.receiving_units ?? [];
  const lead = units.find((unit) => unit.part === 'LEAD');
  const unit = lead?.unit_name ?? task.receiving_unit_name ?? null;
  const support = units.filter((one) => one.part === 'SUPPORT' && one.unit_name !== null).map((one) => one.unit_name as string);
  const holder = task.assignee?.display_name ?? null;
  const over = task.status === 'DONE' || task.status === 'CANCELLED' || task.excluded;
  return (
    <span className="pwfp-unit" data-testid="cell-unit">
      <span className="pwfp-unit__line">
        {unit === null ? null : <span className="pwfp-unit__name">{unit}</span>}
        {unit !== null && (holder !== null || task.unclaimed === true) ? <span aria-hidden="true"> · </span> : null}
        {task.unclaimed === true ? (
          <span data-testid="cell-unclaimed">
            <StatusPill tone="warning" icon="○">
              {t('pwfp.cell.unclaimed.word')}
            </StatusPill>
          </span>
        ) : holder !== null ? (
          <span className="pwfp-unit__who">{holder}</span>
        ) : over ? null : (
          <span className="pwf-hint">{t('pwfp.cell.unassigned.text')}</span>
        )}
      </span>
      {support.length === 0 ? null : <span className="pwf-hint pwfp-unit__support">{t('pwfp.cell.support.text', { units: support.join(', ') })}</span>}
    </span>
  );
}

// ---- deadline and remaining ----------------------------------------------------------------------------------------------------------------------------------------------

/** The committed deadline of a task: the day (or the missing calendar year, never a guessed date), the star of the deadline of the whole file, and the forecast when the schedule now says another day. */
export function DeadlineCell({ task }: { task: CellTask }) {
  const { t } = useTranslation();
  const missing = calendarMissing(task);
  return (
    <span className="pwfp-due" data-testid="cell-deadline">
      {missing ? <CalendarMissingCell year={task.missing_year} /> : <span className="pwfp-due__day">{dayText(task.planned_finish)}</span>}
      {task.is_overall_deadline === true ? (
        <span className="pwfp-star" title={t('pwfp.cell.overall.text')} data-testid="cell-overall">
          <span aria-hidden="true">★ </span>
          <span className="pwf-hint">{t('pwfp.cell.overall.word')}</span>
        </span>
      ) : null}
      {missing ? null : <Forecast task={{ status: task.status, planned_finish: task.planned_finish, forecast_finish: task.forecast_finish ?? null }} />}
    </span>
  );
}

/** The dot of an official colour with its word (the colour is never the only cue). */
export function BandDot({ band }: { band: CellTask['band']['band'] }) {
  const { t } = useTranslation();
  return <span className="pwfp-dot" data-band={band} aria-label={t('pwfp.cell.band.aria', { band: bandWord(t, band) })} role="img" />;
}

/**
 * The "i" of a colour: which ladder judged it and where that ladder comes from, in words a manager reads (the step of the approved process, the policy of the unit, or the default of the system) with the numbers of the ladder. Without
 * a tier (an answer from before the redesign) there is nothing to explain and no button.
 */
export function TierInfo({ task, asOf }: { task: Pick<CellTask, 'band_tier' | 'band_thresholds'>; asOf: string | null | undefined }) {
  const { t } = useTranslation();
  if (task.band_tier === undefined) return null;
  const tier = task.band_tier;
  return (
    <FigureInfo
      name={t('pwfp.cell.info.name')}
      formula={task.band_thresholds === undefined ? t('pwfp.cell.info.noLadder.text') : ladderText(t, task.band_thresholds)}
      source={tierSentence(t, tier)}
      asOf={asOf}
      version={tierWord(t, tier)}
    />
  );
}

/**
 * How long is left: the dot of the official colour, its word and the days in the unit of the source, and the "i" of the tier. A task that is over says so; one that cannot be counted (calendar of its year missing) says that and has
 * the grey dot, never a green. `asOf` is the day the server read the figures.
 */
export function RemainingCell({ task, asOf }: { task: CellTask; asOf?: string | null | undefined }) {
  const { t } = useTranslation();
  if (task.status === 'DONE') return <span className="pwfp-remaining pwf-hint">{t('pwfp.cell.done.word')}</span>;
  if (task.status === 'CANCELLED') return <span className="pwfp-remaining pwf-hint">{t('pwfp.cell.cancelled.word')}</span>;
  if (!hasBand(task)) return <span className="pwf-hint">–</span>;
  const days = remainingText(t, task.band);
  return (
    <span className="pwfp-remaining" data-testid="cell-remaining" data-band={task.band.band}>
      <BandDot band={task.band.band} />
      <span className="pwfp-remaining__text">
        <strong>{bandWord(t, task.band.band)}</strong>
        {days === undefined ? null : <span className="pwf-hint">{days}</span>}
      </span>
      <TierInfo task={task} asOf={asOf} />
    </span>
  );
}

// ---- what blocks ---------------------------------------------------------------------------------------------------------------------------------------------------------

/** "Đang chặn bởi": what the row waits for (missing evidence, the approver, the task before it), or a dash read as "nothing" by a screen reader. */
export function BlockedByCell({ blocks }: { blocks: readonly BlockedBy[] }) {
  const { t } = useTranslation();
  if (blocks.length === 0) {
    return (
      <span className="pwf-hint" data-testid="cell-blocked-none">
        <span aria-hidden="true">–</span>
        <span className="ui-sr-only">{t('pwfp.cell.blocked.none.text')}</span>
      </span>
    );
  }
  return (
    <ul className="pwfp-blocked" data-testid="cell-blocked">
      {blocks.map((block) => (
        <li key={`${block.kind}:${block.kind === 'predecessor' ? block.code : ''}`} data-block={block.kind}>
          {blockedWord(t, block)}
        </li>
      ))}
    </ul>
  );
}

// ---- extension -----------------------------------------------------------------------------------------------------------------------------------------------------------

/** What the frozen template allows and how much of it is used: "Gia hạn: 0/1 lần, 0/10 ngày làm việc"; a limit that is not set says "không giới hạn". Nothing for a task that may not be extended. */
export function ExtensionNote({ task }: { task: Pick<CellTask, 'extension'> }) {
  const { t } = useTranslation();
  const rule = task.extension;
  if (rule === undefined) return null;
  if (!rule.allowed) {
    return (
      <span className="pwf-hint" data-testid="cell-extension">
        {t('pwfp.cell.extension.denied.text')}
      </span>
    );
  }
  const unit = extensionUnitWord(t, rule.unit);
  return (
    <span className="pwf-hint" data-testid="cell-extension">
      {t('pwfp.cell.extension.used.text', {
        times: rule.max_times === null ? t('pwfp.cell.extension.timesOpen.text', { used: rule.times_used }) : t('pwfp.cell.extension.timesOf.text', { used: rule.times_used, max: rule.max_times }),
        value: rule.max_value === null ? t('pwfp.cell.extension.valueOpen.text', { used: rule.value_used, unit }) : t('pwfp.cell.extension.valueOf.text', { used: rule.value_used, max: rule.max_value, unit }),
      })}
    </span>
  );
}
