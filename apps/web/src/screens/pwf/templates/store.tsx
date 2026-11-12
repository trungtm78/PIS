import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { MakerCheckerBadge, SectionCard } from '../../../ui';
import { BlockNote, MoveDialog, VersionPill, periodText, personText } from '../../adm/governance/components';
import type { Receipt } from '../../adm/governance/components';
import { useCreateDraft, useEffective, useVersions } from '../../adm/governance/hooks';
import { moveText, receiptText, refusalText } from '../../adm/governance/labels';
import { REASON_MAX, REASON_MIN, describeRefusal, isDay, isReason, momentText, movesOf, periodNotices, resourceIdOf } from '../../adm/governance/model';
import type { Params, PeriodNotice, Refusal, RuleVersion } from '../../adm/governance/model';
import { problemText } from '../labels';
import { describeProblem, todayInVietnam } from '../model';
import type { Problem } from '../model';
import '../../adm/governance/governance.css';

// The rule store flow both editors share (the template of a workflow and the three-colour policy): write a draft, then submit, withdraw, approve or retire a version, with the maker and the checker two different people.

/** A refusal of the store, or of the module's own checks of the params, in words. */
export function storeRefusalText(t: ReturnType<typeof useTranslation>['t'], refusal: Refusal, problem: Problem): string {
  if (refusal.kind === 'general' && problem.kind !== 'general') return problemText(t, problem);
  return refusalText(t, refusal);
}

function Notice({ notice }: { notice: PeriodNotice }) {
  const { t } = useTranslation();
  switch (notice.kind) {
    case 'takeover':
      return (
        <p className="gova1-callout" role="status" data-testid="notice-takeover">
          <span aria-hidden="true">ⓘ </span>
          {t('gova1.notice.takeover', { version: notice.version, day: periodDay(notice.endsOn) })}
        </p>
      );
    case 'conflict':
      return (
        <p className="gova1-callout gova1-callout--warn" role="status" data-testid="notice-conflict">
          <span aria-hidden="true">⚠ </span>
          {t('gova1.notice.conflict', { version: notice.version, from: periodDay(notice.from), to: notice.to === null ? t('gova1.period.noEnd') : periodDay(notice.to) })}
        </p>
      );
    case 'startPast':
      return (
        <p className="gova1-callout gova1-callout--warn" role="status" data-testid="notice-past">
          <span aria-hidden="true">⚠ </span>
          {t('gova1.notice.startPast')}
        </p>
      );
    case 'endBeforeStart':
      return (
        <p className="gova1-callout gova1-callout--error" role="status" data-testid="notice-end">
          <span aria-hidden="true">⚠ </span>
          {t('gova1.notice.endBeforeStart')}
        </p>
      );
  }
}

const periodDay = (day: string): string => `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`;
const noticeKey = (notice: PeriodNotice): string => (notice.kind === 'takeover' || notice.kind === 'conflict' ? `${notice.kind}:${notice.version}` : notice.kind);

export interface RuleSavePanelProps {
  ruleType: string;
  code: string;
  /** The code is in the form the store takes (the caller says why when it is not). */
  codeValid: boolean;
  /** The params to write; called only when the form has no problem. */
  params: () => Params;
  /** The form holds no problem the person has to fix first. */
  formOk: boolean;
  /** Called when the person tries to save, so the form can show every problem next to its field. */
  onAttempt: () => void;
  disabled: boolean;
}

/** The period, the reason and the Save button of a draft; what the store refuses is said under the button, in words. */
export function RuleSavePanel({ ruleType, code, codeValid, params, formOk, onAttempt, disabled }: RuleSavePanelProps) {
  const { t, locale } = useTranslation();
  const create = useCreateDraft();
  const versionsRead = useVersions(ruleType, codeValid ? code : undefined, undefined, codeValid);
  const effective = useEffective(ruleType, codeValid ? code : undefined, undefined, codeValid);
  // The first day a version can start is today as the server counts it (Vietnam time, also when the code is new and has no rule in force yet); the versions in the store tell what the new period would overlap.
  const today = effective.data?.asOf ?? todayInVietnam();
  const versions = versionsRead.data ?? [];
  const [fromDay, setFromDay] = useState<string | undefined>(undefined);
  const [toDay, setToDay] = useState('');
  const [reason, setReason] = useState('');
  const [attempted, setAttempted] = useState(false);
  const [refusal, setRefusal] = useState<{ refusal: Refusal; problem: Problem } | undefined>(undefined);
  const [written, setWritten] = useState<{ id: string; time: string } | undefined>(undefined);
  const from = fromDay ?? today;
  const toOk = toDay === '' || (isDay(toDay) && (!isDay(from) || toDay > from));
  const notices = isDay(from) && (toDay === '' || isDay(toDay)) ? periodNotices(versions, from, toDay === '' ? null : toDay, today) : [];
  const locked = disabled || create.isPending || written !== undefined;
  const periodProblems: string[] = [];
  if (attempted) {
    if (!codeValid) periodProblems.push(t('gova1.form.error.code'));
    if (!isDay(from)) periodProblems.push(t('gova1.form.error.from'));
    if (!toOk) periodProblems.push(t('gova1.form.error.to'));
    if (!isReason(reason)) periodProblems.push(t('gova1.form.error.reason', { min: REASON_MIN, max: REASON_MAX }));
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setAttempted(true);
    setRefusal(undefined);
    onAttempt();
    if (!(formOk && codeValid && isDay(from) && toOk && isReason(reason))) return;
    create.mutate(
      { ruleType, code, unitId: undefined, params: params(), effectiveFrom: from, effectiveTo: toDay === '' ? undefined : toDay, reason: reason.trim() },
      {
        onSuccess: (result) => setWritten({ id: resourceIdOf(result) ?? '', time: momentText(new Date().toISOString(), locale) }),
        onError: (error) => setRefusal({ refusal: describeRefusal(error), problem: describeProblem(error) }),
      },
    );
  };

  return (
    <SectionCard title={t('pwf.store.save.title')}>
      {written === undefined ? null : (
        <div className="gova1-callout gova1-callout--ok" role="status" data-testid="written">
          <p>{t('pwf.store.written.text', { code, time: written.time })}</p>
          <button
            type="button"
            className="ui-button ui-button--outline ui-button--small"
            data-testid="again"
            onClick={() => {
              setWritten(undefined);
              setAttempted(false);
              setReason('');
            }}
          >
            {t('gova1.form.written.again')}
          </button>
        </div>
      )}
      {refusal === undefined ? null : (
        <p className="gova1-callout gova1-callout--error" role="alert" data-testid="refusal">
          {storeRefusalText(t, refusal.refusal, refusal.problem)}
        </p>
      )}
      {periodProblems.length === 0 ? null : (
        <div className="gova1-callout gova1-callout--error" role="alert" data-testid="period-problems">
          <ul>
            {periodProblems.map((text) => (
              <li key={text}>{text}</li>
            ))}
          </ul>
        </div>
      )}
      <form onSubmit={submit} noValidate aria-label={t('pwf.store.save.title')}>
        <div className="gova1-head">
          <div className="gova1-field">
            <label htmlFor="pwf-store-from">{t('gova1.form.from')}</label>
            <input id="pwf-store-from" type="date" value={from} disabled={locked} aria-invalid={attempted && !isDay(from)} data-testid="from" onChange={(event) => setFromDay(event.target.value)} />
            <span className="gova1-hint">{t('gova1.form.from.hint')}</span>
          </div>
          <div className="gova1-field">
            <label htmlFor="pwf-store-to">
              {t('gova1.form.to')} <span className="gova1-optional">({t('gova1.form.optional')})</span>
            </label>
            <input id="pwf-store-to" type="date" value={toDay} disabled={locked} aria-invalid={attempted && !toOk} data-testid="to" onChange={(event) => setToDay(event.target.value)} />
            <span className="gova1-hint">{t('gova1.form.to.hint')}</span>
          </div>
        </div>
        <div data-testid="notices">
          {notices.map((notice) => (
            <Notice key={noticeKey(notice)} notice={notice} />
          ))}
        </div>
        {isDay(from) ? <p className="adm-kit-sub">{periodText(t, from, toDay === '' ? null : toDay)}</p> : null}
        <div className="gova1-field">
          <label htmlFor="pwf-store-reason">{t('gova1.form.reason')}</label>
          <textarea id="pwf-store-reason" rows={3} value={reason} disabled={locked} aria-invalid={attempted && !isReason(reason)} aria-describedby="pwf-store-reason-hint" data-testid="reason" onChange={(event) => setReason(event.target.value)} />
          <span className="gova1-hint" id="pwf-store-reason-hint">
            {t('gova1.form.reason.hint', { min: REASON_MIN, max: REASON_MAX })}
          </span>
        </div>
        <p className="gova1-actions">
          <button type="submit" className="ui-button ui-button--primary" disabled={locked} data-testid="save">
            {create.isPending ? t('gova1.form.saving') : t('gova1.form.save')}
          </button>
          <span className="adm-kit-sub">{t('pwf.store.save.hint')}</span>
        </p>
      </form>
    </SectionCard>
  );
}

export interface RuleVersionListProps {
  ruleType: string;
  code: string;
  canManage: boolean;
  canApprove: boolean;
  /** The session is not read-only. */
  writable: boolean;
  /** Where "write a new version from this one" goes. */
  editLink: (versionId: string) => string;
  /** Where two versions are compared (the diff screen of the rule store). */
  diffLink: (versionId: string, againstId: string | undefined) => string;
}

/** The versions of one code with who made and who checked each, and the moves a person may make (never their own approval). */
export function RuleVersionList({ ruleType, code, canManage, canApprove, writable, editLink, diffLink }: RuleVersionListProps) {
  const { t, locale } = useTranslation();
  const { tenant } = useSession();
  const me = tenant?.membershipId;
  const versions = useVersions(ruleType, code, undefined, true);
  const effective = useEffective(ruleType, code, undefined, true);
  const [dialog, setDialog] = useState<{ version: RuleVersion; move: ReturnType<typeof movesOf>[number]['move'] } | undefined>(undefined);
  const [receipt, setReceipt] = useState<Receipt | undefined>(undefined);
  const state = useScreenState({ isLoading: versions.isLoading, error: versions.error, data: versions.data, isEmpty: () => false });
  const list = versions.data ?? [];
  const today = effective.data?.asOf ?? todayInVietnam();

  return (
    <SectionCard title={t('gova1.detail.versions.title')}>
      {receipt === undefined ? null : (
        <p className="gova1-callout gova1-callout--ok" role="status" data-testid="receipt">
          {receiptText(t, receipt.move, { version: receipt.version, code: receipt.code, time: receipt.time })}
        </p>
      )}
      <StateBoundary state={state} onRetry={() => void versions.refetch()}>
        {list.length === 0 ? (
          <p className="adm-kit-empty" data-testid="no-versions">
            {t('gova1.detail.versions.none')}
          </p>
        ) : (
          <ol className="gova1-timeline" aria-label={t('gova1.detail.versions.caption', { type: ruleType, code })} data-testid="versions">
            {list.map((version, index) => {
              const previous = list[index + 1];
              const options = writable ? movesOf(version, { me, canManage, canApprove, today }).filter((option) => option.allowed || option.block !== undefined) : [];
              return (
                <li key={version.id} data-version={version.id} data-phase={version.phase} data-status={version.status}>
                  <div className="gova1-chips">
                    <h3>{t('gova1.detail.version.title', { version: version.version })}</h3>
                    <VersionPill version={version} />
                    <MakerCheckerBadge maker={personText(t, version.createdBy, me)} checker={version.approvedBy === null ? null : personText(t, version.approvedBy, me)} />
                  </div>
                  <p>{periodText(t, version.effectiveFrom, version.effectiveTo)}</p>
                  <p data-testid="version-reason">{t('gova1.detail.version.reason', { reason: version.reason })}</p>
                  <p className="adm-kit-sub">
                    {t('gova1.detail.version.people', { maker: personText(t, version.createdBy, me), made: momentText(version.createdAt, locale) })}
                    {version.submittedBy === null ? '' : ` · ${t('gova1.detail.version.submitted', { who: personText(t, version.submittedBy, me), at: momentText(version.submittedAt, locale) })}`}
                  </p>
                  <div className="gova1-actions">
                    <Link to={diffLink(version.id, previous?.id)} data-testid={`diff-${version.version}`}>
                      {previous === undefined ? t('gova1.detail.version.diffDefault') : t('gova1.detail.version.diff', { version: previous.version })}
                    </Link>
                    {canManage ? (
                      <Link to={editLink(version.id)} data-testid={`from-${version.version}`}>
                        {t('gova1.detail.version.from')}
                      </Link>
                    ) : null}
                    {options.map((option) => (
                      <span key={option.move}>
                        <button
                          type="button"
                          className={option.move === 'approve' || option.move === 'submit' ? 'ui-button ui-button--primary ui-button--small' : 'ui-button ui-button--outline ui-button--small'}
                          data-action={`${option.move}-${version.version}`}
                          disabled={!option.allowed}
                          aria-describedby={option.block === undefined ? undefined : `block-${version.id}-${option.move}`}
                          onClick={() => {
                            setReceipt(undefined);
                            setDialog({ version, move: option.move });
                          }}
                        >
                          {moveText(t, option.move, version.status)}
                        </button>
                        {option.block === undefined ? null : (
                          <span id={`block-${version.id}-${option.move}`}>
                            <BlockNote block={option.block} />
                          </span>
                        )}
                      </span>
                    ))}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </StateBoundary>
      {dialog === undefined ? null : (
        <MoveDialog
          version={dialog.version}
          move={dialog.move}
          me={me}
          onClose={() => setDialog(undefined)}
          onDone={(done) => {
            setDialog(undefined);
            setReceipt(done);
          }}
        />
      )}
    </SectionCard>
  );
}
