import { ApiError } from '@machvon/api-client';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { ConfirmDialog, ContextBar, DataTable, MakerCheckerBadge, SectionCard, StatusPill } from '../../ui';
import type { DataTableColumn } from '../../ui';
import { ClockChip, Field, Notice, PolicyNote, Select, StatusChip } from './components';
import { useDefaultDirective, useDirCommand, useDirectiveDetail, useMemberOptions, useUnitOptions } from './hooks';
import type { CommandInput } from './hooks';
import { errorText, eventLabel, extensionStatusLabel } from './labels';
import { BOARD_PATH, asOfText, dayText, extensionProblem, idFrom, meetingPath, parseIds } from './model';
import type { DirectiveDetail, Extension, TimelineEvent } from './model';

const NEVER_EMPTY = (): boolean => false;

type ActionKind = 'progress' | 'extension' | 'approve' | 'reject' | 'close' | 'cancel' | 'reopen' | 'assign';
/** The actions that need more than a reason: they open a panel first. */
const NEEDS_PANEL: readonly ActionKind[] = ['progress', 'extension', 'close', 'assign'];

interface Fields {
  pct: string;
  evidence: string;
  proposed: string;
  unitId: string;
  memberId: string;
}
const NO_FIELDS: Fields = { pct: '', evidence: '', proposed: '', unitId: '', memberId: '' };
const KEEP_PERSON = '';
const NO_PERSON = 'none';

/**
 * DIR-04: one directive. The head says what it is and where it stands on its clock; the timeline is the history nobody edits; the requests to move the due day and the evidence are listed. Every command is
 * a dialog that names the directive, what will happen and who must differ (the closer is neither whoever recorded the directive nor whoever must do it; an extension is decided by someone other than who asked), and
 * asks for the reason; the buttons are the commands the server says the reader may give, in the state the directive is in. A conflict of versions reads the directive again, and a refusal is said in words.
 */
export default function DirectiveDetailScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <DirectiveDetailContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function DirectiveDetailContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { tenant, mode } = useSession();
  const [params] = useSearchParams();
  const namedId = idFrom(params.get('directive'));
  // Opened without a directive in the address, the most urgent one of the scope is shown (the board stays one click away to choose another).
  const fallback = useDefaultDirective(namedId === undefined);
  const directiveId = namedId ?? fallback.directive?.id;
  const read = useDirectiveDetail(directiveId);
  const data = read.data ?? undefined;
  const state = useScreenState({ isLoading: read.isLoading, error: read.data === undefined ? read.error : undefined, data: read.data, isEmpty: NEVER_EMPTY });
  const stale = read.isError && read.data !== undefined;
  const [action, setAction] = useState<ActionKind | undefined>(undefined);
  const [confirming, setConfirming] = useState(false);
  const [fields, setFields] = useState<Fields>(NO_FIELDS);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | undefined>(undefined);
  const progress = useDirCommand('recordDirectiveProgress');
  const extension = useDirCommand('requestDirectiveExtension');
  const decide = useDirCommand('decideDirectiveExtension');
  const close = useDirCommand('closeDirective');
  const cancel = useDirCommand('cancelDirective');
  const reopen = useDirCommand('reopenDirective');
  const assign = useDirCommand('assignDirective');
  const units = useUnitOptions(action === 'assign');
  const members = useMemberOptions(action === 'assign');
  const writable = mode !== 'READ_ONLY';
  const pending = [progress, extension, decide, close, cancel, reopen, assign].some((command) => command.isPending);

  const start = (kind: ActionKind): void => {
    setMessage(undefined);
    setProblem(undefined);
    setFields({ ...NO_FIELDS, unitId: data?.directive.assigneeUnit.id ?? '' });
    setAction(kind);
    setConfirming(!NEEDS_PANEL.includes(kind));
  };
  const stop = (): void => {
    setAction(undefined);
    setConfirming(false);
    setProblem(undefined);
  };

  /** The reason why the panel cannot be sent yet, in words; undefined when it can. */
  const check = (detail: DirectiveDetail): string | undefined => {
    if (action === 'progress') {
      const pct = fields.pct.trim();
      if (pct !== '' && (!/^\d{1,3}$/.test(pct) || Number(pct) > 100)) return t('dir.form.pct.error');
      if (parseIds(fields.evidence).invalid.length > 0) return t('dir.form.documents.error');
    }
    if (action === 'close') {
      const parsed = parseIds(fields.evidence);
      if (parsed.invalid.length > 0) return t('dir.form.documents.error');
      if (detail.policy.closeRequiresEvidence && detail.directive.evidenceCount + parsed.ids.length < 1) return t('dir.error.evidenceRequired.text');
    }
    if (action === 'extension') {
      const why = extensionProblem(detail.directive.dueOn, fields.proposed, detail.policy, detail.directive.extensionCount);
      if (why === 'day') return t('dir.form.day.error');
      if (why === 'order') return t('dir.extension.order.error', { day: dayText(detail.directive.dueOn) });
      if (why === 'days') return t('dir.extension.days.error', { days: detail.policy.maxExtensionDays });
      if (why === 'limit') return t('dir.extension.limit.error', { count: detail.policy.maxExtensions });
    }
    if (action === 'assign') {
      const sameUnit = fields.unitId === detail.directive.assigneeUnit.id;
      if (fields.unitId === '' || (sameUnit && fields.memberId === KEEP_PERSON)) return t('dir.assign.nothing.error');
    }
    return undefined;
  };

  const review = (detail: DirectiveDetail): void => {
    const why = check(detail);
    setProblem(why);
    if (why === undefined) setConfirming(true);
  };

  const finish = (text: string): void => {
    stop();
    setMessage({ tone: 'ok', text });
  };
  const refuse = (error: unknown, detail: DirectiveDetail): void => {
    stop();
    setMessage({ tone: 'error', text: errorText(t, error, detail.policy) });
    // What was read is not what is there any more: read it again, and the buttons follow.
    if (error instanceof ApiError && (error.code === 'VERSION_CONFLICT' || error.code === 'DIRECTIVE_STATE_INVALID' || error.code === 'DIRECTIVE_EXTENSION_STATE_INVALID')) void read.refetch();
  };

  const send = (detail: DirectiveDetail, reason: string): void => {
    const line = detail.directive;
    const evidence = parseIds(fields.evidence).ids;
    const handlers = { onSuccess: () => finish(t('dir.done.text')), onError: (error: Error) => refuse(error, detail) };
    const run = (command: ReturnType<typeof useDirCommand>, input: CommandInput): void => command.mutate(input, handlers);
    switch (action) {
      case 'progress':
        run(progress, { id: line.id, body: { note: reason, ...(fields.pct.trim() === '' ? {} : { progress_pct: Number(fields.pct) }), ...(evidence.length === 0 ? {} : { evidence_document_version_ids: evidence }) } });
        break;
      case 'extension':
        run(extension, { id: line.id, body: { proposed_due_on: fields.proposed, reason } });
        break;
      case 'approve':
      case 'reject':
        if (line.openExtension !== null) run(decide, { id: line.openExtension.id, version: line.openExtension.version, body: { decision: action, reason } });
        break;
      case 'close':
        run(close, { id: line.id, version: line.version, body: { note: reason, ...(evidence.length === 0 ? {} : { evidence_document_version_ids: evidence }) } });
        break;
      case 'cancel':
        run(cancel, { id: line.id, version: line.version, body: { reason } });
        break;
      case 'reopen':
        run(reopen, { id: line.id, version: line.version, body: { reason } });
        break;
      case 'assign':
        run(assign, {
          id: line.id,
          version: line.version,
          body: {
            ...(fields.unitId !== line.assigneeUnit.id ? { assignee_unit_id: fields.unitId } : {}),
            ...(fields.memberId === KEEP_PERSON ? {} : { assignee_membership_id: fields.memberId === NO_PERSON ? null : fields.memberId }),
            ...(reason.trim() === '' ? {} : { note: reason.trim() }),
          },
        });
        break;
      default:
        break;
    }
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <p className="dir-back-link">
        <Link to={data === undefined ? BOARD_PATH : meetingPath(data.directive.meeting.id)}>
          <span aria-hidden="true">← </span>
          {data === undefined ? t('dir.directive.back.board') : t('dir.directive.back.meeting', { code: data.directive.meeting.code })}
        </Link>
      </p>
      <div className="heading">
        <div>
          <h1 id="screen-title">{data === undefined ? t('dir.directive.page.title') : data.directive.code}</h1>
          <p>{t('dir.directive.page.subtitle')}</p>
        </div>
        {data === undefined ? null : (
          <div className="dir-actions">
            <StatusChip status={data.directive.status} />
            <ClockChip line={data.directive} />
          </div>
        )}
      </div>
      <ContextBar
        items={[{ label: t('dir.ctx.scope.label'), value: tenant?.name ?? t('dir.ctx.scope.all') }, ...(data === undefined ? [] : [{ label: t('dir.directive.ctx.version'), value: String(data.directive.version) }])]}
        {...(data === undefined || data.asOf === '' ? {} : { asOf: asOfText(data.asOf) })}
        stale={stale}
      />
      {directiveId === undefined ? (
        fallback.isLoading ? (
          <StateBoundary state="loading" />
        ) : (
          <p className="callout" data-testid="no-target">
            {t('dir.directive.noTarget.text')}
          </p>
        )
      ) : (
        <StateBoundary state={state} onRetry={() => void read.refetch()}>
          {namedId === undefined && data !== undefined ? (
            <p className="callout" role="status" data-testid="default-target">
              {t('dir.directive.default.text')}
            </p>
          ) : null}
          {data === undefined ? (
            <p className="callout" data-testid="missing">
              {t('dir.directive.missing.text')}
            </p>
          ) : (
            <>
              {message === undefined ? null : (
                <Notice tone={message.tone} testId="message">
                  {message.text}
                </Notice>
              )}
              <Facts detail={data} />
              {writable ? <Buttons detail={data} onStart={start} /> : null}
              {data.directive.openExtension === null ? null : <PendingExtension detail={data} />}
              {action !== undefined && NEEDS_PANEL.includes(action) ? (
                <ActionPanel
                  kind={action}
                  detail={data}
                  fields={fields}
                  onChange={(next) => setFields({ ...fields, ...next })}
                  problem={problem}
                  units={units.data ?? []}
                  members={members.data ?? []}
                  onReview={() => review(data)}
                  onCancel={stop}
                />
              ) : null}
              <Timeline events={data.timeline} />
              <Extensions extensions={data.extensions} />
              <EvidenceList detail={data} />
              <PolicyNote policy={data.policy} />
              <ConfirmDialog
                open={confirming && action !== undefined}
                title={action === undefined ? '' : titleOf(t, action)}
                context={action === undefined ? [] : contextOf(t, action, data, fields)}
                confirmLabel={action === undefined ? '' : confirmOf(t, action)}
                cancelLabel={t('dir.form.cancel.action')}
                pending={pending}
                reason={{ label: action === undefined ? '' : reasonOf(t, action), required: action !== 'assign' }}
                onCancel={() => (NEEDS_PANEL.includes(action ?? 'cancel') ? setConfirming(false) : stop())}
                onConfirm={(reason) => {
                  if (action !== 'assign' && (reason === undefined || reason.trim() === '')) return;
                  send(data, (reason ?? '').trim());
                }}
              />
            </>
          )}
        </StateBoundary>
      )}
      <p className="prototype-note">{t('dir.footer.text', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

type T = ReturnType<typeof useTranslation>['t'];

function titleOf(t: T, action: ActionKind): string {
  switch (action) {
    case 'progress':
      return t('dir.confirm.progress.title');
    case 'extension':
      return t('dir.confirm.extension.title');
    case 'approve':
      return t('dir.confirm.approve.title');
    case 'reject':
      return t('dir.confirm.reject.title');
    case 'close':
      return t('dir.confirm.close.title');
    case 'cancel':
      return t('dir.confirm.cancel.title');
    case 'reopen':
      return t('dir.confirm.reopen.title');
    case 'assign':
      return t('dir.confirm.assign.title');
  }
}

function confirmOf(t: T, action: ActionKind): string {
  switch (action) {
    case 'progress':
      return t('dir.confirm.progress.action');
    case 'extension':
      return t('dir.confirm.extension.action');
    case 'approve':
      return t('dir.confirm.approve.action');
    case 'reject':
      return t('dir.confirm.reject.action');
    case 'close':
      return t('dir.confirm.close.action');
    case 'cancel':
      return t('dir.confirm.cancel.action');
    case 'reopen':
      return t('dir.confirm.reopen.action');
    case 'assign':
      return t('dir.confirm.assign.action');
  }
}

function reasonOf(t: T, action: ActionKind): string {
  switch (action) {
    case 'progress':
      return t('dir.confirm.progress.reason');
    case 'extension':
      return t('dir.confirm.extension.reason');
    case 'approve':
    case 'reject':
      return t('dir.confirm.decide.reason');
    case 'close':
      return t('dir.confirm.close.reason');
    case 'cancel':
      return t('dir.confirm.cancel.reason');
    case 'reopen':
      return t('dir.confirm.reopen.reason');
    case 'assign':
      return t('dir.confirm.assign.reason');
  }
}

/** What the dialog names before anything is sent: the directive, the effect, the consequence, and who must differ. */
function contextOf(t: T, action: ActionKind, detail: DirectiveDetail, fields: Fields): { label: string; value: string }[] {
  const line = detail.directive;
  const base = [
    { label: t('dir.confirm.directive.label'), value: `${line.code} · ${line.text}` },
    { label: t('dir.confirm.due.label'), value: dayText(line.dueOn) },
  ];
  switch (action) {
    case 'progress':
      return [...base, { label: t('dir.confirm.effect.label'), value: line.storedStatus === 'OPEN' ? t('dir.confirm.progress.effectOpen') : t('dir.confirm.progress.effect') }];
    case 'extension':
      return [
        ...base,
        { label: t('dir.confirm.proposed.label'), value: dayText(fields.proposed) },
        { label: t('dir.confirm.effect.label'), value: t('dir.confirm.extension.effect') },
        { label: t('dir.confirm.rule.label'), value: t('dir.confirm.extension.rule', { count: detail.policy.maxExtensions, days: detail.policy.maxExtensionDays }) },
      ];
    case 'approve':
    case 'reject': {
      const open = line.openExtension;
      return [
        ...base,
        { label: t('dir.confirm.proposed.label'), value: dayText(open?.proposedDueOn ?? null) },
        { label: t('dir.confirm.effect.label'), value: action === 'approve' ? t('dir.confirm.approve.effect') : t('dir.confirm.reject.effect') },
        { label: t('dir.confirm.rule.label'), value: t('dir.confirm.decide.rule') },
      ];
    }
    case 'close':
      return [
        ...base,
        { label: t('dir.confirm.effect.label'), value: t('dir.confirm.close.effect') },
        { label: t('dir.confirm.rule.label'), value: t('dir.confirm.close.rule', { creator: line.createdBy.displayName, assignee: line.assignee?.displayName ?? t('dir.confirm.close.noAssignee') }) },
      ];
    case 'cancel':
      return [...base, { label: t('dir.confirm.effect.label'), value: t('dir.confirm.cancel.effect') }];
    case 'reopen':
      return [...base, { label: t('dir.confirm.effect.label'), value: line.storedStatus === 'DONE' ? t('dir.confirm.reopen.effectDone') : t('dir.confirm.reopen.effectCancelled') }];
    case 'assign':
      return [...base, { label: t('dir.confirm.effect.label'), value: t('dir.confirm.assign.effect') }];
  }
}

function Facts({ detail }: { detail: DirectiveDetail }) {
  const { t } = useTranslation();
  const line = detail.directive;
  return (
    <SectionCard title={t('dir.directive.facts.title')}>
      <p data-testid="directive-text">{line.text}</p>
      <dl className="dir-facts">
        <dt>{t('dir.directive.meeting.label')}</dt>
        <dd>
          <Link to={meetingPath(line.meeting.id)}>{`${line.meeting.code} · ${line.meeting.title}`}</Link>
        </dd>
        <dt>{t('dir.directive.about.label')}</dt>
        <dd>{line.project === null ? t('dir.directive.about.unit', { unit: `${line.scopeUnit.code} · ${line.scopeUnit.name}` }) : `${line.project.code} · ${line.project.name}`}</dd>
        <dt>{t('dir.directive.assigneeUnit.label')}</dt>
        <dd>{`${line.assigneeUnit.code} · ${line.assigneeUnit.name}`}</dd>
        <dt>{t('dir.directive.assignee.label')}</dt>
        <dd>{line.assignee === null ? t('dir.directive.assignee.none') : line.assignee.displayName}</dd>
        <dt>{t('dir.directive.originalDue.label')}</dt>
        <dd>{dayText(line.originalDueOn)}</dd>
        <dt>{t('dir.directive.due.label')}</dt>
        <dd>{dayText(line.dueOn)}</dd>
        <dt>{t('dir.directive.extensions.label')}</dt>
        <dd>{t('dir.directive.extensions.text', { count: line.extensionCount, max: detail.policy.maxExtensions })}</dd>
        <dt>{t('dir.directive.createdBy.label')}</dt>
        <dd>
          <MakerCheckerBadge maker={line.createdBy.displayName} />
        </dd>
        <dt>{t('dir.directive.evidence.label')}</dt>
        <dd>{String(line.evidenceCount)}</dd>
        {line.escalatesOn === null ? null : (
          <>
            <dt>{t('dir.directive.escalates.label')}</dt>
            <dd>{t('dir.directive.escalates.text', { day: dayText(line.escalatesOn) })}</dd>
          </>
        )}
      </dl>
    </SectionCard>
  );
}

/** The commands the reader may give, in the state the directive is in: only the ones the server offered. */
function Buttons({ detail, onStart }: { detail: DirectiveDetail; onStart: (kind: ActionKind) => void }) {
  const { t } = useTranslation();
  const a = detail.actions;
  const items: Array<[ActionKind, boolean, string]> = [
    ['progress', a.recordProgress, t('dir.action.progress.action')],
    ['extension', a.requestExtension, t('dir.action.extension.action')],
    ['approve', a.decideExtension, t('dir.action.approve.action')],
    ['reject', a.decideExtension, t('dir.action.reject.action')],
    ['assign', a.assign, t('dir.action.assign.action')],
    ['close', a.close, t('dir.action.close.action')],
    ['cancel', a.cancel, t('dir.action.cancel.action')],
    ['reopen', a.reopen, t('dir.action.reopen.action')],
  ];
  const shown = items.filter(([, allowed]) => allowed);
  if (shown.length === 0) return null;
  return (
    <div className="dir-actions" role="group" aria-label={t('dir.action.group.label')}>
      {shown.map(([kind, , label]) => (
        <button key={kind} type="button" className="ui-button ui-button--outline" data-action={kind} onClick={() => onStart(kind)}>
          {label}
        </button>
      ))}
    </div>
  );
}

function PendingExtension({ detail }: { detail: DirectiveDetail }) {
  const { t } = useTranslation();
  const open = detail.directive.openExtension;
  const request = detail.extensions.find((extension) => extension.id === open?.id);
  if (open === null || open === undefined) return null;
  return (
    <Notice tone="info" testId="pending-extension">
      {t('dir.extension.pending.text', { day: dayText(open.proposedDueOn), who: request?.requestedBy.displayName ?? '', reason: request?.reason ?? '' })}
    </Notice>
  );
}

interface PanelProps {
  kind: ActionKind;
  detail: DirectiveDetail;
  fields: Fields;
  onChange: (next: Partial<Fields>) => void;
  problem: string | undefined;
  units: Array<{ id: string; label: string }>;
  members: Array<{ id: string; label: string }>;
  onReview: () => void;
  onCancel: () => void;
}

/** The fields a command needs besides its reason; "review" checks them and opens the dialog that asks for the reason. */
function ActionPanel({ kind, detail, fields, onChange, problem, units, members, onReview, onCancel }: PanelProps) {
  const { t } = useTranslation();
  const line = detail.directive;
  return (
    <SectionCard title={titleOf(t, kind)}>
      <form
        className="dir-form"
        aria-label={titleOf(t, kind)}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          onReview();
        }}
      >
        {problem === undefined ? null : <Notice tone="error">{problem}</Notice>}
        {kind === 'progress' ? (
          <Field id="dir-pct" label={t('dir.form.pct.label')} hint={t('dir.form.pct.hint')}>
            <input id="dir-pct" type="number" min={0} max={100} step={1} value={fields.pct} onChange={(event) => onChange({ pct: event.target.value })} />
          </Field>
        ) : null}
        {kind === 'progress' || kind === 'close' ? (
          <Field id="dir-evidence" label={t('dir.form.documents.label')} hint={kind === 'close' && detail.policy.closeRequiresEvidence ? t('dir.form.documents.required', { count: line.evidenceCount }) : t('dir.form.document.hint')}>
            <textarea id="dir-evidence" rows={2} value={fields.evidence} onChange={(event) => onChange({ evidence: event.target.value })} />
          </Field>
        ) : null}
        {kind === 'extension' ? (
          <Field id="dir-proposed" label={t('dir.form.proposed.label')} hint={t('dir.form.proposed.hint', { days: detail.policy.maxExtensionDays, count: detail.policy.maxExtensions, used: line.extensionCount })}>
            <input id="dir-proposed" type="date" min={line.dueOn} value={fields.proposed} onChange={(event) => onChange({ proposed: event.target.value })} />
          </Field>
        ) : null}
        {kind === 'assign' ? (
          <>
            <Select id="dir-assign-unit" label={t('dir.assign.unit.label')} value={fields.unitId} onChange={(value) => onChange({ unitId: value })} options={units} />
            <Select
              id="dir-assign-member"
              label={t('dir.assign.member.label')}
              value={fields.memberId}
              onChange={(value) => onChange({ memberId: value })}
              options={[{ id: NO_PERSON, label: t('dir.assign.member.none') }, ...members]}
              emptyLabel={t('dir.assign.member.keep')}
            />
          </>
        ) : null}
        <div className="dir-actions dir-wide">
          <button type="submit" className="ui-button">
            {t('dir.form.review.action')}
          </button>
          <button type="button" className="ui-button ui-button--outline" onClick={onCancel}>
            {t('dir.form.cancel.action')}
          </button>
        </div>
      </form>
    </SectionCard>
  );
}

function eventText(t: T, event: TimelineEvent): string[] {
  const lines: string[] = [];
  if (event.type === 'ASSIGNED' || event.type === 'CREATED') {
    if (event.toAssigneeUnit !== null) lines.push(event.fromAssigneeUnit === null ? t('dir.event.to.text', { unit: event.toAssigneeUnit.code }) : t('dir.event.fromTo.text', { from: event.fromAssigneeUnit.code, unit: event.toAssigneeUnit.code }));
  }
  if (event.type === 'CREATED' && event.toDueOn !== null) lines.push(t('dir.event.due.text', { day: dayText(event.toDueOn) }));
  if ((event.type === 'EXTENSION_REQUESTED' || event.type === 'EXTENSION_APPROVED') && event.fromDueOn !== null && event.toDueOn !== null) lines.push(t('dir.event.dueMove.text', { from: dayText(event.fromDueOn), to: dayText(event.toDueOn) }));
  if (event.progressPct !== null) lines.push(t('dir.event.pct.text', { pct: event.progressPct }));
  if (event.approver !== null) lines.push(t('dir.event.approver.text', { name: event.approver.displayName }));
  return lines;
}

function Timeline({ events }: { events: TimelineEvent[] }) {
  const { t } = useTranslation();
  return (
    <SectionCard title={t('dir.timeline.title')} status={<StatusPill tone="neutral">{t('dir.timeline.count', { count: events.length })}</StatusPill>}>
      <ol className="dir-timeline" aria-label={t('dir.timeline.title')}>
        {events.map((event) => (
          <li key={event.id} data-event={event.type}>
            <strong>{eventLabel(t, event.type)}</strong> <span className="muted">{t('dir.timeline.by.text', { name: event.actor.displayName, time: asOfText(event.occurredAt) })}</span>
            {eventText(t, event).map((text) => (
              <p key={text} className="muted">
                {text}
              </p>
            ))}
            {event.note === null ? null : <p>{event.note}</p>}
          </li>
        ))}
      </ol>
    </SectionCard>
  );
}

function Extensions({ extensions }: { extensions: Extension[] }) {
  const { t } = useTranslation();
  const columns: DataTableColumn<Extension>[] = [
    { key: 'from', header: t('dir.extension.from.header'), render: (row) => dayText(row.fromDueOn) },
    { key: 'to', header: t('dir.extension.to.header'), render: (row) => dayText(row.proposedDueOn) },
    { key: 'reason', header: t('dir.extension.reason.header'), render: (row) => row.reason },
    { key: 'status', header: t('dir.extension.state.header'), render: (row) => <StatusPill tone={row.status === 'APPROVED' ? 'success' : row.status === 'REJECTED' ? 'danger' : 'warning'}>{extensionStatusLabel(t, row.status)}</StatusPill> },
    { key: 'who', header: t('dir.extension.who.header'), render: (row) => <MakerCheckerBadge maker={row.requestedBy.displayName} checker={row.decidedBy?.displayName ?? null} /> },
    { key: 'why', header: t('dir.extension.decision.header'), render: (row) => row.decisionReason ?? '' },
  ];
  return (
    <SectionCard title={t('dir.extension.title')}>
      <DataTable caption={t('dir.extension.title')} columns={columns} rows={extensions} rowKey={(row) => row.id} state={extensions.length === 0 ? 'empty' : 'ready'} />
    </SectionCard>
  );
}

function EvidenceList({ detail }: { detail: DirectiveDetail }) {
  const { t } = useTranslation();
  const columns: DataTableColumn<DirectiveDetail['evidence'][number]>[] = [
    { key: 'title', header: t('dir.evidence.title.header'), render: (row) => row.title ?? t('dir.evidence.untitled.text') },
    { key: 'id', header: t('dir.evidence.version.header'), render: (row) => row.documentVersionId },
    { key: 'by', header: t('dir.evidence.by.header'), render: (row) => row.addedBy.displayName },
    { key: 'at', header: t('dir.evidence.at.header'), render: (row) => asOfText(row.addedAt) },
  ];
  return (
    <SectionCard title={t('dir.evidence.title')}>
      <DataTable caption={t('dir.evidence.title')} columns={columns} rows={detail.evidence} rowKey={(row) => row.id} state={detail.evidence.length === 0 ? 'empty' : 'ready'} />
    </SectionCard>
  );
}
