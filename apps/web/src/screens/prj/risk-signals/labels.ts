import type { InfoFormulaLabels, Tone } from '../../../ui';
import type { AlertStatus, AlertType, Kind, Level, Refusal, Trend, Unit } from './model';

type Translate = (key: string, params?: Record<string, string | number>) => string;

/** Each key is written out so that the i18n check can see it is in use. */
export function kindText(t: Translate, kind: Kind): string {
  switch (kind) {
    case 'SCHEDULE_DELAY':
      return t('mr1.risk.kind.scheduleDelay');
    case 'PAYMENT_INTEGRITY':
      return t('mr1.risk.kind.paymentIntegrity');
    case 'CLAIM_EARLY_WARNING':
      return t('mr1.risk.kind.claimEarlyWarning');
    case 'FUNDING_GAP':
      return t('mr1.risk.kind.fundingGap');
    case 'PROCUREMENT_DELAY':
      return t('mr1.risk.kind.procurementDelay');
    case 'REGISTER':
      return t('mr1.risk.kind.register');
  }
}

export function levelText(t: Translate, level: Level): string {
  switch (level) {
    case 'LOW':
      return t('mr1.risk.level.low');
    case 'MEDIUM':
      return t('mr1.risk.level.medium');
    case 'CRITICAL':
      return t('mr1.risk.level.critical');
  }
}

/** A level is a word and a glyph, and a tone for the pill: the colour is never the only signal. */
export const levelTone = (level: Level): Tone => (level === 'CRITICAL' ? 'danger' : level === 'MEDIUM' ? 'warning' : 'success');
// Level: white circle, half circle, black circle. Trend: up arrow, down arrow, right arrow, star for a line scored the first time.
export const LEVEL_GLYPH: Readonly<Record<Level, string>> = { LOW: '○', MEDIUM: '◐', CRITICAL: '●' };
export const TREND_GLYPH: Readonly<Record<Trend, string>> = { UP: '↑', DOWN: '↓', FLAT: '→', NEW: '★' };

export function trendText(t: Translate, trend: Trend): string {
  switch (trend) {
    case 'UP':
      return t('mr1.risk.trend.up');
    case 'DOWN':
      return t('mr1.risk.trend.down');
    case 'FLAT':
      return t('mr1.risk.trend.flat');
    case 'NEW':
      return t('mr1.risk.trend.new');
  }
}

/** The name of an indicator; one the screen has no word for is shown as it came, never hidden. */
export function indicatorText(t: Translate, indicator: string): string {
  switch (indicator) {
    case 'SPI_SHORTFALL_PCT':
      return t('mr1.risk.indicator.spiShortfall');
    case 'MILESTONE_SLIP_DAYS':
      return t('mr1.risk.indicator.milestoneSlip');
    case 'PAYMENT_BLOCKED_DRAFTS':
      return t('mr1.risk.indicator.paymentBlocked');
    case 'PAYMENT_SIGNAL_REQUESTS':
      return t('mr1.risk.indicator.paymentSignals');
    case 'OPEN_CLAIMS':
      return t('mr1.risk.indicator.openClaims');
    case 'EARLY_WARNINGS_HIGH':
      return t('mr1.risk.indicator.earlyWarnings');
    case 'FUNDING_GAP_PCT':
      return t('mr1.risk.indicator.fundingGap');
    case 'PROCUREMENT_SLIP_DAYS':
      return t('mr1.risk.indicator.procurementSlip');
    default:
      return indicator;
  }
}

/** A figure with its unit. */
export function unitText(t: Translate, unit: Unit, figure: string): string {
  switch (unit) {
    case 'PERCENT':
      return t('mr1.risk.unit.percent', { value: figure });
    case 'DAYS':
      return t('mr1.risk.unit.days', { value: figure });
    case 'COUNT':
      return t('mr1.risk.unit.count', { value: figure });
  }
}

/** The name of a fact the job kept beside the figures; a fact the screen has no word for is shown under its own key. */
export function factText(t: Translate, key: string): string {
  switch (key) {
    case 'spi':
      return t('mr1.risk.fact.spi');
    case 'milestones':
      return t('mr1.risk.fact.milestones');
    case 'milestones_late':
      return t('mr1.risk.fact.milestonesLate');
    case 'payment_blocked_drafts':
      return t('mr1.risk.fact.paymentBlocked');
    case 'payment_signal_requests':
      return t('mr1.risk.fact.paymentSignals');
    case 'open_claims':
      return t('mr1.risk.fact.openClaims');
    case 'claim_register':
      return t('mr1.risk.fact.claimRegister');
    case 'early_warning_register':
      return t('mr1.risk.fact.warningRegister');
    case 'contract_early_warnings_high':
      return t('mr1.risk.fact.contractWarnings');
    case 'dis_early_warnings_critical':
      return t('mr1.risk.fact.disWarnings');
    case 'funding_year':
      return t('mr1.risk.fact.fundingYear');
    case 'funding_needed_vnd':
      return t('mr1.risk.fact.fundingNeeded');
    case 'funding_allocated_vnd':
      return t('mr1.risk.fact.fundingAllocated');
    case 'procurement_milestones':
      return t('mr1.risk.fact.procurementMilestones');
    default:
      return key;
  }
}

export function alertTypeText(t: Translate, type: AlertType): string {
  return type === 'RISK_SCORE_JUMP' ? t('mr1.risk.alert.type.jump') : t('mr1.risk.alert.type.critical');
}

export function alertStatusText(t: Translate, status: AlertStatus): string {
  switch (status) {
    case 'OPEN':
      return t('mr1.risk.alert.status.open');
    case 'ACKNOWLEDGED':
      return t('mr1.risk.alert.status.acknowledged');
    case 'RESOLVED':
      return t('mr1.risk.alert.status.resolved');
  }
}

export function refusalText(t: Translate, refusal: Refusal): string {
  switch (refusal) {
    case 'alertState':
      return t('mr1.risk.refusal.alertState');
    case 'versionConflict':
      return t('mr1.risk.refusal.versionConflict');
    case 'denied':
      return t('mr1.risk.refusal.denied');
    case 'notFound':
      return t('mr1.risk.refusal.notFound');
    case 'validation':
      return t('mr1.risk.refusal.validation');
    case 'session':
      return t('mr1.risk.refusal.session');
    case 'general':
      return t('mr1.risk.refusal.general');
  }
}

/** The words of the "i" of a figure, shared by the screens of lane MR-1. */
export function infoLabels(t: Translate, name: string): InfoFormulaLabels {
  return {
    open: t('mr1.info.open', { name }),
    close: t('mr1.info.close'),
    formula: t('mr1.info.formula'),
    numerator: t('mr1.info.numerator'),
    denominator: t('mr1.info.denominator'),
    exclusions: t('mr1.info.exclusions'),
    source: t('mr1.info.source'),
    asOf: t('mr1.info.asOf'),
    owner: t('mr1.info.owner'),
    version: t('mr1.info.version'),
    unverified: t('mr1.info.unverified'),
  };
}
