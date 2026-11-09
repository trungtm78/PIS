import { useTranslation } from '../../i18n';
import { InfoFormula, StatusPill } from '../../ui';
import type { InfoFormulaLabels, Tone } from '../../ui';
import { clockAndDay } from '../../ui/alerts/format';
import type { RedFlagBand, RedFlagStatus, RungState } from './model';
import './gov10.css';

/** The "i" of a figure of lane GOV-10: the formula in words, the source, the day, the owner and the version of the rule, and the label "default, not confirmed" while nobody confirmed the numbers. */
export function Provenance({ name, formula, source, asOf, version, unverified, owner }: { name: string; formula: string | null; source: string | null; asOf: string | null; version: string; unverified: boolean; owner: string }) {
  const { t } = useTranslation();
  const labels: InfoFormulaLabels = {
    open: t('gov10.info.open', { name }),
    close: t('gov10.info.close'),
    formula: t('gov10.info.formula'),
    numerator: t('gov10.info.numerator'),
    denominator: t('gov10.info.denominator'),
    exclusions: t('gov10.info.exclusions'),
    source: t('gov10.info.source'),
    asOf: t('gov10.info.asOf'),
    owner: t('gov10.info.owner'),
    version: t('gov10.info.version'),
    unverified: t('gov10.info.unverified'),
  };
  return <InfoFormula name={name} formula={formula ?? t('gov10.info.noFormula')} source={source ?? t('gov10.info.noSource')} asOf={asOf ?? t('gov10.info.noDay')} owner={owner} version={version} unverified={unverified} labels={labels} />;
}

/** The time of an ISO instant as the screens of the alert centre write it. */
export const when = (iso: string | null): string => (iso === null || iso === '' ? '—' : clockAndDay(iso));

/** Previous and next page of a list that is read by offset. */
export function Pager({ offset, size, hasMore, onOffset }: { offset: number; size: number; hasMore: boolean; onOffset: (offset: number) => void }) {
  const { t } = useTranslation();
  if (offset === 0 && !hasMore) return null;
  return (
    <nav className="gov10-pager" aria-label={t('gov10.pager.label')}>
      <button type="button" className="mv-alert-button" disabled={offset === 0} onClick={() => onOffset(Math.max(0, offset - size))}>
        {t('gov10.pager.previous')}
      </button>
      <span>{t('gov10.pager.page', { page: Math.floor(offset / size) + 1 })}</span>
      <button type="button" className="mv-alert-button" disabled={!hasMore} onClick={() => onOffset(offset + size)}>
        {t('gov10.pager.next')}
      </button>
    </nav>
  );
}

const BAND_TONE: Readonly<Record<RedFlagBand, Tone>> = { NONE: 'neutral', LOW: 'info', MEDIUM: 'warning', HIGH: 'danger' };

/** The band of a score as a pill with its word (never colour alone). */
export function BandPill({ band }: { band: RedFlagBand }) {
  const { t } = useTranslation();
  return <StatusPill tone={BAND_TONE[band]}>{bandLabel(t, band)}</StatusPill>;
}

type T = ReturnType<typeof useTranslation>['t'];

export function bandLabel(t: T, band: RedFlagBand): string {
  switch (band) {
    case 'HIGH':
      return t('gov10.red.band.high');
    case 'MEDIUM':
      return t('gov10.red.band.medium');
    case 'LOW':
      return t('gov10.red.band.low');
    default:
      return t('gov10.red.band.none');
  }
}

export function redStatusLabel(t: T, status: RedFlagStatus): string {
  switch (status) {
    case 'NEW':
      return t('gov10.red.status.new');
    case 'IN_REVIEW':
      return t('gov10.red.status.inReview');
    case 'CLEAR_PROPOSED':
      return t('gov10.red.status.clearProposed');
    case 'CLEARED':
      return t('gov10.red.status.cleared');
    default:
      return t('gov10.red.status.referred');
  }
}

export function indicatorLabel(t: T, code: string): string {
  switch (code) {
    case 'SPLIT_PROCUREMENT':
      return t('gov10.red.indicator.splitProcurement');
    case 'THRESHOLD_MANIPULATION':
      return t('gov10.red.indicator.thresholdManipulation');
    case 'NEAR_THRESHOLD_DIRECT_AWARDS':
      return t('gov10.red.indicator.nearThresholdDirectAwards');
    case 'DIRECT_AWARD_THEN_CHANGE':
      return t('gov10.red.indicator.directAwardThenChange');
    case 'AWARD_VS_FINAL_PRICE_GAP':
      return t('gov10.red.indicator.awardVsFinalPriceGap');
    case 'ADDENDUM_PRICE_INCREASE':
      return t('gov10.red.indicator.addendumPriceIncrease');
    case 'CONTRACT_AMENDED':
      return t('gov10.red.indicator.contractAmended');
    case 'SINGLE_BIDDER':
      return t('gov10.red.indicator.singleBidder');
    case 'SHORT_TENDER_PERIOD':
      return t('gov10.red.indicator.shortTenderPeriod');
    case 'AWARD_AT_OR_ABOVE_ESTIMATE':
      return t('gov10.red.indicator.awardAtOrAboveEstimate');
    case 'DEBARRED_BIDDER':
      return t('gov10.red.indicator.debarredBidder');
    case 'IDENTICAL_BID_PRICES':
      return t('gov10.red.indicator.identicalBidPrices');
    default:
      return code;
  }
}

const RUNG_TONE: Readonly<Record<RungState, Tone>> = { QUEUED: 'neutral', SENT: 'info', DELIVERED: 'success', SEEN: 'success', FAILED: 'danger', SUPPRESSED: 'warning' };

export function rungStateLabel(t: T, state: RungState): string {
  switch (state) {
    case 'QUEUED':
      return t('gov10.ladder.state.queued');
    case 'SENT':
      return t('gov10.ladder.state.sent');
    case 'DELIVERED':
      return t('gov10.ladder.state.delivered');
    case 'SEEN':
      return t('gov10.ladder.state.seen');
    case 'FAILED':
      return t('gov10.ladder.state.failed');
    default:
      return t('gov10.ladder.state.suppressed');
  }
}

export function suppressionLabel(t: T, reason: string | null): string {
  switch (reason) {
    case 'NO_CONSENT':
      return t('gov10.ladder.reason.noConsent');
    case 'QUIET_HOURS':
      return t('gov10.ladder.reason.quietHours');
    case 'DAILY_CAP':
      return t('gov10.ladder.reason.dailyCap');
    case 'NO_CONTACT':
      return t('gov10.ladder.reason.noContact');
    case 'NO_WORKFLOW':
      return t('gov10.ladder.reason.noWorkflow');
    case 'PROFILE':
      return t('gov10.ladder.reason.profile');
    default:
      return '';
  }
}

export function channelLabel(t: T, channel: string): string {
  switch (channel) {
    case 'IN_APP':
      return t('gov10.ladder.channel.inApp');
    case 'PUSH':
      return t('gov10.ladder.channel.push');
    case 'EMAIL':
      return t('gov10.ladder.channel.email');
    case 'TEAMS':
      return t('gov10.ladder.channel.teams');
    case 'ZALO':
      return t('gov10.ladder.channel.zalo');
    default:
      return t('gov10.ladder.channel.sms');
  }
}

/** The state of a rung as a pill with its word and, for a rung that was not sent, the reason. */
export function RungPill({ channel, state, reason }: { channel: string; state: RungState; reason: string | null }) {
  const { t } = useTranslation();
  return (
    <span className="gov10-rung" data-state={state}>
      <StatusPill tone={RUNG_TONE[state]}>
        {channelLabel(t, channel)}: {rungStateLabel(t, state)}
      </StatusPill>
      {reason === null ? null : <span className="gov10-rung__reason">{suppressionLabel(t, reason)}</span>}
    </span>
  );
}

export function feedbackReasonLabel(t: T, reason: string): string {
  switch (reason) {
    case 'NOT_APPLICABLE':
      return t('gov10.feedback.reason.notApplicable');
    case 'WRONG_DATA':
      return t('gov10.feedback.reason.wrongData');
    case 'DUPLICATE':
      return t('gov10.feedback.reason.duplicate');
    case 'ALREADY_HANDLED':
      return t('gov10.feedback.reason.alreadyHandled');
    case 'NOT_MY_ROLE':
      return t('gov10.feedback.reason.notMyRole');
    case 'TOO_EARLY':
      return t('gov10.feedback.reason.tooEarly');
    default:
      return t('gov10.feedback.reason.other');
  }
}

export function feedbackStatusLabel(t: T, status: string): string {
  switch (status) {
    case 'PENDING':
      return t('gov10.feedback.status.pending');
    case 'ACCEPTED_FOR_TUNING':
      return t('gov10.feedback.status.accepted');
    case 'REJECTED':
      return t('gov10.feedback.status.rejected');
    case 'DUPLICATE_OF':
      return t('gov10.feedback.status.duplicate');
    default:
      return t('gov10.feedback.status.withdrawn');
  }
}
