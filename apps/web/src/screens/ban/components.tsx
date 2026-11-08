import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { hasMessage, useTranslation } from '../../i18n';
import type { Translator } from '../../i18n';
import type { WebRoute } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { InfoFormula, KpiTile, SectionCard, StatusPill } from '../../ui';
import type { InfoFormulaLabels } from '../../ui';
import { FigureInfo, FlagPills, figureShown } from '../home/figure-components';
import { changeSentence } from '../home/gov-components';
import type { Tile } from '../home/model';
import {
  ALERT_TYPE_WORD,
  DirectiveFlowError,
  RAG_STYLE,
  REASON_STYLE,
  SEVERITY_STYLE,
  dayText,
  decimalText,
  figureWord,
  lastYearView,
  may,
  outlookView,
  pctText,
  pointsText,
  refusalOf,
  toChangeLines,
  vndText,
} from './model';
import type { Alert, Feed, Outlook, Policy, Rag, Row, Signal, Workspace } from './model';
import './ban.css';

type T = Translator['t'];

/** The page of a screen of the committee: the title, the line under it, and the reference of the screen at the foot. */
export function ScreenFrame({ route, title, subtitle, children }: { route: WebRoute; title: string; subtitle: string; children?: ReactNode }) {
  const { t } = useTranslation();
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title" className="ban-screen">
      <div className="heading">
        <div>
          <h1 id="screen-title">{title}</h1>
          <p>{subtitle}</p>
        </div>
      </div>
      {children}
      <p className="prototype-note">{t('ban.common.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

export interface GuardedProps {
  route: WebRoute;
  /** The right the screen is for; without it nothing is asked of the server and the screen says the scope is hidden, naming nothing. */
  permission: string;
  title: string;
  subtitle: string;
  children: ReactNode;
}

/** The permission gate and the scope of a screen: a membership or a tenant that changes starts the screen over, so nothing of the one is shown to the other. */
export function Guarded({ route, permission, title, subtitle, children }: GuardedProps) {
  const { tenant, permissions } = useSession();
  if (!may(permissions, permission)) {
    return (
      <ScreenFrame route={route} title={title} subtitle={subtitle}>
        <StateBoundary state="denied" />
      </ScreenFrame>
    );
  }
  return (
    <ScreenFrame key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} title={title} subtitle={subtitle}>
      {children}
    </ScreenFrame>
  );
}

/** The sentence of a refused command: each refusal the committee can give has its own words, and the rest say that the command could not be done. */
export function refusalText(t: T, error: unknown): string {
  const refusal = refusalOf(error);
  switch (refusal.code) {
    case 'VERSION_CONFLICT':
      return t('ban.common.error.versionConflict.text');
    case 'SCOPE_DENIED':
      return t('ban.common.error.scope.text');
    case 'RESOURCE_NOT_FOUND':
      return t('ban.common.error.notFound.text');
    case 'COMMITTEE_ROLE_TAKEN':
      return refusal.detail === 'head' ? t('ban.common.error.roleTakenHead.text') : t('ban.common.error.roleTakenPlace.text');
    case 'COMMITTEE_STATE_INVALID':
      switch (refusal.detail) {
        case 'code_exists':
          return t('ban.common.error.codeExists.text');
        case 'committee_ended':
          return t('ban.common.error.committeeEnded.text');
        case 'already_ended':
          return t('ban.common.error.alreadyEnded.text');
        case 'already_acknowledged':
          return t('ban.common.error.alreadyAcknowledged.text');
        case 'alert_resolved':
          return t('ban.common.error.alertResolved.text');
        default:
          return t('ban.common.error.stateInvalid.text');
      }
    case 'VALIDATION_FAILED':
      if (refusal.reason === 'self_appointment') return t('ban.common.error.selfAppointment.text');
      if (refusal.reason === 'membership_not_active') return t('ban.common.error.membershipNotActive.text');
      return t('ban.common.error.validation.text');
    default:
      return t('ban.common.error.generic.text');
  }
}

/** The sentence of a failed directive: the step it failed at and why; a failure after the directive was given says that a new send only records the link. */
export function directiveFailureText(t: T, error: unknown): string {
  if (!(error instanceof DirectiveFlowError)) return refusalText(t, error);
  const step = error.step === 'meeting' ? t('ban.att.directive.step.meeting') : error.step === 'directive' ? t('ban.att.directive.step.directive') : t('ban.att.directive.step.decision');
  const base = t('ban.att.directive.error.step', { step, reason: refusalText(t, error.failure) });
  return error.step === 'decision' ? `${base} ${t('ban.att.directive.error.decisionHint')}` : base;
}

/** The text that stands for an amount, a rate or a difference that is not known: it is said, never 0. */
export function useWords() {
  const { t, locale } = useTranslation();
  const none = t('ban.common.noData.text');
  return {
    none,
    vnd: (value: string | null | undefined): string => vndText(value, locale) ?? none,
    num: (value: string | null | undefined): string => (value === null || value === undefined ? none : decimalText(value, locale)),
    pct: (value: string | null | undefined): string => pctText(value, locale) ?? none,
    points: (value: string | null | undefined): string => pointsText(value, locale) ?? none,
  };
}

/** A colour of the committee as a word and a shape; the tone is a third cue. */
export function RagPill({ rag }: { rag: Rag }) {
  const { t } = useTranslation();
  const style = RAG_STYLE[rag];
  const label = rag === 'RED' ? t('ban.rag.red.label') : rag === 'AMBER' ? t('ban.rag.amber.label') : rag === 'GREEN' ? t('ban.rag.green.label') : t('ban.rag.noData.label');
  return (
    <span data-rag={rag}>
      <StatusPill tone={style.tone} icon={style.icon}>
        {label}
      </StatusPill>
    </span>
  );
}

/** One figure of the register with its "i" (formula, source, as-of, owner, version, unverified) and the flags that sit on it. */
export function FigureTile({ tile }: { tile: Tile }) {
  const { t } = useTranslation();
  const word = figureWord(tile.metricCode);
  const label = hasMessage(`ban.fig.${word}.label`) ? t(`ban.fig.${word}.label`) : (tile.kpi?.name ?? tile.metricCode);
  return (
    <div className="ban-figure" data-testid={`figure-${tile.metricCode}`} data-metric={tile.metricCode}>
      <KpiTile
        label={label}
        value={figureShown(t, tile)}
        sub={
          <span className="ban-figure__sub">
            <FigureInfo tile={tile} />
            <FlagPills tile={tile} />
          </span>
        }
      />
    </div>
  );
}

/** The year-end band: the lowest to the highest estimate, or why there is none; a band held up by one method says so. */
export function OutlookText({ outlook }: { outlook: Outlook }) {
  const { t, locale } = useTranslation();
  const view = outlookView(outlook, locale);
  if (view.kind === 'none') return <span data-outlook="none">{view.reason === 'noPlan' ? t('ban.outlook.noPlan.text') : t('ban.outlook.noData.text')}</span>;
  return (
    <span data-outlook="range">
      {t('ban.outlook.range.text', { low: view.low, high: view.high })}
      {view.lowPct === null || view.highPct === null ? null : <span className="ban-muted"> {t('ban.outlook.percent.text', { low: view.lowPct, high: view.highPct })}</span>}
      {view.thin ? <span className="ban-muted"> {t('ban.outlook.thin.text')}</span> : null}
    </span>
  );
}

/** The comparison with the same period of last year: the amount, or how many lines have one when some do not, or that there is none. */
export function LastYearText({ row }: { row: Pick<Row, 'last_year_vnd' | 'last_year_coverage'> }) {
  const { t, locale } = useTranslation();
  const view = lastYearView(row, locale);
  if (view.kind === 'amount') return <span>{view.amount}</span>;
  if (view.kind === 'partial') return <span data-last-year="partial">{t('ban.lastYear.partial.text', { known: view.known, total: view.total })}</span>;
  return <span data-last-year="none">{t('ban.common.noData.text')}</span>;
}

/** The reasons of a project, each a word with a shape (never colour alone) and the numbers the rule judged. */
export function ReasonList({ signals }: { signals: readonly Signal[] }) {
  const { t, locale } = useTranslation();
  return (
    <ul className="ban-reasons">
      {signals.map((signal) => {
        const style = REASON_STYLE[signal.reason];
        const label = signal.reason === 'DELAYED' ? t('ban.reason.delayed.label') : signal.reason === 'STALLED_PROCEDURE' ? t('ban.reason.stalled.label') : signal.reason === 'OVER_BUDGET_RISK' ? t('ban.reason.overBudget.label') : signal.reason === 'DISBURSEMENT_FAR_BELOW_PLAN' ? t('ban.reason.farBelow.label') : t('ban.reason.notReporting.label');
        const value = signal.value === null ? null : decimalText(signal.value, locale);
        return (
          <li key={signal.reason} data-reason={signal.reason}>
            <span aria-hidden="true">{style.icon}</span> <strong>{label}</strong>
            <span className="ban-muted"> {value === null ? t('ban.reason.noValue.text') : signal.unit === 'DAYS' ? t('ban.reason.days.text', { value, threshold: signal.threshold }) : signal.unit === 'PERCENT' ? t('ban.reason.percent.text', { value, threshold: signal.threshold }) : t('ban.reason.points.text', { value, threshold: signal.threshold })}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** What is said of the rules the thresholds and the curve come from: they are start values nobody confirmed, with their formula, source and day behind the "i". */
export function PolicyNotice({ policy }: { policy: Policy }) {
  const { t } = useTranslation();
  const labels: InfoFormulaLabels = {
    open: t('ban.policy.info.open'),
    close: t('govc.home.info.close'),
    formula: t('govc.home.info.formula'),
    numerator: t('govc.home.info.numerator'),
    denominator: t('govc.home.info.denominator'),
    exclusions: t('govc.home.info.exclusions'),
    source: t('govc.home.info.source'),
    asOf: t('govc.home.info.asOf'),
    owner: t('govc.home.info.owner'),
    version: t('govc.home.info.version.label'),
    unverified: t('govc.home.info.unverified'),
  };
  return (
    <div className={policy.unverified ? 'callout warning ban-policy' : 'callout ban-policy'} role="note" data-testid="policy-notice" data-unverified={policy.unverified ? 'true' : 'false'}>
      <span>{policy.unverified ? t('ban.policy.unverified.text', { code: policy.code }) : t('ban.policy.verified.text', { code: policy.code })}</span>{' '}
      <InfoFormula
        name={t('ban.policy.info.name', { code: policy.code })}
        formula={policy.formula === '' ? '—' : policy.formula}
        source={policy.rule_source === '' ? '—' : policy.rule_source}
        asOf={policy.as_of === '' ? '—' : policy.as_of}
        owner={policy.code}
        version={policy.version === null ? t('govc.home.info.version.default', { version: 0 }) : t('govc.home.info.version', { version: policy.version })}
        unverified={policy.unverified}
        labels={labels}
      />
    </div>
  );
}

/** Where the figures come from: the basis and the reference of the feed, when it last delivered, and that nothing was delivered at all when that is so. */
export function FeedNotice({ feed }: { feed: Feed }) {
  const { t } = useTranslation();
  if (feed.empty) {
    return (
      <p className="callout warning" role="status" data-testid="feed-empty">
        {t('ban.feed.empty.text')}
      </p>
    );
  }
  return (
    <p className="ban-muted" data-testid="feed-basis">
      {t(feed.basis === 'DIS_SNAPSHOT' ? 'ban.feed.basis.snapshot' : 'ban.feed.basis.live', { reference: feed.reference ?? '–', projects: feed.projects, lines: feed.lines })}
      {feed.last_delivered_at === null ? '' : ` ${t('ban.feed.delivered.text', { day: dayText(feed.last_delivered_at) })}`}
    </p>
  );
}

/** "Changes since last week": at most five sentences made by rules; a week with no week before says so, and a quiet week says so. */
export function ChangesBlock({ changes }: { changes: Workspace['changes'] }) {
  const { t } = useTranslation();
  const lines = toChangeLines(changes.lines);
  return (
    <SectionCard title={t('ban.changes.title.text')}>
      <div data-testid="changes">
        {changes.previous_as_of === null ? null : <p className="ban-muted">{t('ban.changes.range.text', { day: dayText(changes.previous_as_of) })}</p>}
        {changes.reason === 'NO_PREVIOUS_WEEK' ? (
          <p role="status" data-testid="changes-no-previous">
            {t('ban.changes.noPrevious.text')}
          </p>
        ) : lines.length === 0 ? (
          <p role="status" data-testid="changes-none">
            {t('ban.changes.none.text')}
          </p>
        ) : (
          <ul className="ban-changes">
            {lines.map((line, index) => (
              <li key={`${line.kind}:${index}`} data-kind={line.kind} data-direction={line.direction}>
                <span aria-hidden="true">{line.direction === 'UP' ? '▲' : '▼'}</span> <span>{changeSentence(t, line)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </SectionCard>
  );
}

/** One alert of the committee: what fired, the number against its threshold, who owns it, what is expected, and what follows if nothing is done. */
export function AlertCard({ alert, actions }: { alert: Alert; actions?: ReactNode }) {
  const { t } = useTranslation();
  const severity = SEVERITY_STYLE[alert.severity];
  const typeLabel = typeLabelOf(t, alert.alert_type);
  const severityLabel = alert.severity === 'URGENT' ? t('ban.alert.severity.urgent') : alert.severity === 'ACTION' ? t('ban.alert.severity.action') : t('ban.alert.severity.watch');
  const statusLabel = alert.status === 'OPEN' ? t('ban.alert.status.open') : alert.status === 'ACKNOWLEDGED' ? t('ban.alert.status.acknowledged') : t('ban.alert.status.resolved');
  return (
    <article className="ban-alert" data-testid={`alert-${alert.id}`} data-status={alert.status} data-severity={alert.severity}>
      <header className="ban-alert__head">
        <StatusPill tone={severity.tone} icon={severity.icon}>
          {severityLabel}
        </StatusPill>
        <strong>{typeLabel}</strong>
        <span className="ban-muted">{alert.subject_label ?? alert.subject_key}</span>
        <StatusPill tone={alert.status === 'RESOLVED' ? 'success' : alert.status === 'ACKNOWLEDGED' ? 'info' : 'warning'}>{statusLabel}</StatusPill>
      </header>
      <dl className="ban-facts">
        <div>
          <dt>{t('ban.alert.fact.value')}</dt>
          <dd>{alert.value === null || alert.value === undefined ? t('ban.common.noData.text') : t('ban.alert.fact.valueOf', { value: alert.value, threshold: alert.threshold ?? '–' })}</dd>
        </div>
        <div>
          <dt>{t('ban.alert.fact.owner')}</dt>
          <dd>{alert.owner ?? '–'}</dd>
        </div>
        <div>
          <dt>{t('ban.alert.fact.action')}</dt>
          <dd>{alert.expected_action ?? '–'}</dd>
        </div>
        <div>
          <dt>{t('ban.alert.fact.consequence')}</dt>
          <dd>{alert.consequence ?? '–'}</dd>
        </div>
        <div>
          <dt>{t('ban.alert.fact.response')}</dt>
          <dd>{alert.response_hours === null || alert.response_hours === undefined ? '–' : t('ban.alert.fact.hours', { hours: alert.response_hours })}</dd>
        </div>
        <div>
          <dt>{t('ban.alert.fact.opened')}</dt>
          <dd>{dayText(alert.opened_on)}</dd>
        </div>
      </dl>
      {alert.status === 'ACKNOWLEDGED' ? (
        <p className="ban-muted" data-testid={`ack-${alert.id}`}>
          {t('ban.alert.ack.text', { name: alert.acknowledged_by_name ?? '–', note: alert.acknowledged_note ?? '–' })}
        </p>
      ) : null}
      {actions}
    </article>
  );
}

export function typeLabelOf(t: T, type: Alert['alert_type']): string {
  switch (ALERT_TYPE_WORD[type]) {
    case 'provinceBehind':
      return t('ban.alert.type.provinceBehind');
    case 'sectorBehind':
      return t('ban.alert.type.sectorBehind');
    case 'unitNotReporting':
      return t('ban.alert.type.unitNotReporting');
    default:
      return t('ban.alert.type.directiveOverdue');
  }
}

/** A part that could not be read: it names itself and retries in place; it is never an empty part. */
export function PartError({ source, onRetry }: { source: string; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div role="alert" className="callout warning" data-testid="part-error">
      <p>{t('ban.common.partError.text', { source })}</p>
      <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={onRetry}>
        {t('ui.common.retry')}
      </button>
    </div>
  );
}

/** The reason a list is empty, in the words of the screen (no data, a filter found nothing, nothing to do), with the action that leads on. */
export function EmptyReason({ text, testId, action }: { text: string; testId: string; action?: ReactNode }) {
  return (
    <div className="ban-empty" role="status" data-testid={testId}>
      <p>{text}</p>
      {action}
    </div>
  );
}

/** A link to another screen of the committee, written as a quiet button. */
export function GoLink({ to, label, testId }: { to: string; label: string; testId?: string }) {
  return (
    <Link className="ui-button ui-button--outline ui-button--small" to={to} data-testid={testId}>
      {label}
    </Link>
  );
}

/** The name of a place in the committee; a role this screen has no word for is shown as the server wrote it. */
export function roleLabelOf(t: T, role: string): string {
  switch (role) {
    case 'HEAD':
      return t('ban.ros.role.head');
    case 'DEPUTY':
      return t('ban.ros.role.deputy');
    case 'MEMBER':
      return t('ban.ros.role.member');
    case 'SECRETARIAT':
      return t('ban.ros.role.secretariat');
    default:
      return role;
  }
}
