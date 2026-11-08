import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from '../../i18n';
import type { Translator } from '../../i18n';
import { ConfirmDialog, InfoFormula } from '../../ui';
import type { InfoFormulaLabels } from '../../ui';
import { useRefresh } from './int-hooks';
import { problemOf } from './int-model';
import type { Problem } from './int-model';
import './int.css';

type T = Translator['t'];

/** The words of a refusal of a command, said inside the dialog; the reason a duplicate or a closed dataset carries is named when it is known. */
export function problemText(t: T, problem: Problem): string {
  switch (problem.kind) {
    case 'versionConflict':
      return t('int.common.problem.versionConflict');
    case 'selfApproval':
      return t('int.common.problem.selfApproval');
    case 'duplicateTaken':
      return t('int.common.problem.duplicateTaken');
    case 'duplicateHolds':
      return t('int.common.problem.duplicateHolds');
    case 'duplicateWaiting':
      return t('int.common.problem.duplicateWaiting');
    case 'duplicate':
      return t('int.common.problem.duplicate');
    case 'stateInvalid':
      return t('int.common.problem.stateInvalid');
    case 'nameTaken':
      return t('int.common.problem.nameTaken');
    case 'systemTaken':
      return t('int.common.problem.systemTaken');
    case 'systemInUse':
      return t('int.common.problem.systemInUse');
    case 'datasetClosed':
      return problem.reason === 'EXPIRED' ? t('int.common.problem.datasetExpired') : t('int.common.problem.datasetNotCertified');
    case 'provisioning':
      return t('int.common.problem.provisioning');
    case 'validation':
      return t('int.common.problem.validation');
    case 'notFound':
      return t('int.common.problem.notFound');
    case 'forbidden':
      return t('int.common.problem.forbidden');
    default:
      return t('int.common.problem.general');
  }
}

export interface CommandDialogProps<Output> {
  title: string;
  context: { label: string; value: string }[];
  confirmLabel: string;
  /** What the command does, in a sentence, above the reason. */
  effect?: ReactNode;
  /** Controls between the effect and the reason. */
  children?: ReactNode;
  /** False for a command that asks no reason. */
  reason?: boolean;
  /** Judges the form before anything is sent; a false answer keeps the dialog open (the form shows why). */
  valid?: () => boolean;
  /** Sends the command with the reason; the promise ends the dialog or says why not. */
  run: (reason: string) => Promise<Output>;
  onDone: (output: Output) => void;
  onClose: () => void;
  /** The field a refusal names, so the form can show it beside the field. */
  onProblem?: (problem: Problem) => void;
}

/** A dialog of a command: it names the record and the effect, asks for the reason, locks while it sends (one send at a time) and says in place why the server refused. */
export function CommandDialog<Output>({ title, context, confirmLabel, effect, children, reason = true, valid, run, onDone, onClose, onProblem }: CommandDialogProps<Output>) {
  const { t } = useTranslation();
  const reload = useRefresh();
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const [pending, setPending] = useState(false);
  const sending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const send = (text?: string): void => {
    if (sending.current) return;
    if (valid !== undefined && !valid()) return;
    sending.current = true;
    setProblem(undefined);
    setPending(true);
    run(text ?? '').then(
      (output) => {
        sending.current = false;
        if (mounted.current) setPending(false);
        onDone(output);
        onClose();
      },
      (error: unknown) => {
        sending.current = false;
        const found = problemOf(error);
        if (mounted.current) {
          setPending(false);
          setProblem(found);
        }
        onProblem?.(found);
      },
    );
  };

  return (
    <ConfirmDialog
      open
      title={title}
      context={context}
      confirmLabel={confirmLabel}
      cancelLabel={t('int.common.dialog.cancel.action')}
      pending={pending}
      onCancel={onClose}
      onConfirm={send}
      {...(reason ? { reason: { label: t('int.common.dialog.reason.label'), required: true, minLength: 10, hint: t('int.common.dialog.reason.hint') } } : {})}
      {...(problem === undefined ? {} : { error: problemText(t, problem) })}
    >
      {effect !== undefined && <p className="sub">{effect}</p>}
      {children}
      {problem?.kind === 'versionConflict' && (
        <button
          type="button"
          className="ui-button ui-button--outline ui-button--small"
          onClick={() => {
            void reload();
            onClose();
          }}
        >
          {t('int.common.problem.reload.action')}
        </button>
      )}
    </ConfirmDialog>
  );
}

export interface SecretItem {
  label: string;
  value: string;
}

/**
 * The dialog that shows a secret ONCE (a client secret, the password of a database login). The values live only in the props of this dialog: nothing is stored, logged or put in the address, and closing it drops them
 * (the screen clears its state on close). It says so, in words, before the person closes it.
 */
export function SecretDialog({ title, intro, items, onClose }: { title: string; intro: string; items: SecretItem[]; onClose: () => void }) {
  const { t } = useTranslation();
  const titleId = useId();
  const closeButton = useRef<HTMLButtonElement>(null);
  const [copied, setCopied] = useState<string | undefined>(undefined);
  useEffect(() => {
    closeButton.current?.focus();
  }, []);
  const copy = (item: SecretItem): void => {
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    if (clipboard === undefined) return;
    void clipboard.writeText(item.value).then(
      () => setCopied(item.label),
      () => setCopied(undefined),
    );
  };
  return createPortal(
    <div className="ui-dialog-backdrop">
      <div
        className="ui-dialog int-secret"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <h2 className="ui-dialog__title" id={titleId}>{title}</h2>
        <p className="callout" role="alert" data-testid="secret-warning">
          {t('int.common.secret.warning')}
        </p>
        <p className="sub">{intro}</p>
        <dl className="int-secret__items">
          {items.map((item) => (
            <div key={item.label} className="int-secret__item">
              <dt>{item.label}</dt>
              <dd>
                <code data-testid={`secret-${item.label}`}>{item.value}</code>
                <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => copy(item)} aria-label={t('int.common.secret.copy.label', { label: item.label })}>
                  {copied === item.label ? t('int.common.secret.copied') : t('int.common.secret.copy.action')}
                </button>
              </dd>
            </div>
          ))}
        </dl>
        <div className="ui-dialog__actions">
          <button ref={closeButton} type="button" className="ui-button ui-button--primary" onClick={onClose}>
            {t('int.common.secret.close.action')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** The block of a failed list, with its retry. */
export function ErrorBlock({ title, body, onRetry }: { title: string; body: string; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="int-state int-state--error" role="alert" data-testid="error">
      <h2>{title}</h2>
      <p>{body}</p>
      <button type="button" className="ui-button ui-button--outline" onClick={onRetry}>
        {t('states.retry.action')}
      </button>
    </div>
  );
}

/** The block shown when the read is refused for scope or right. */
export function DeniedBlock({ title, body }: { title: string; body: string }) {
  return (
    <div className="int-state int-state--denied" role="alert" data-testid="denied">
      <h2>{title}</h2>
      <p>{body}</p>
    </div>
  );
}

/** The block of an empty list, with its own reason. */
export function EmptyBlock({ title, body }: { title: string; body: string }) {
  return (
    <div className="int-state" role="status" data-testid="empty">
      <h2>{title}</h2>
      <p>{body}</p>
    </div>
  );
}

/** "Load more" under a list that comes in pages, with what is shown and why a page failed. */
export function MoreRow({ shown, hasNext, loading, failed, onMore }: { shown: number; hasNext: boolean; loading: boolean; failed: boolean; onMore: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="int-more">
      <span className="sub" role="status" data-testid="shown">
        {t('int.common.paging.summary', { shown })}
      </span>
      {failed && <span role="alert">{t('int.common.paging.error')}</span>}
      {hasNext && (
        <button type="button" className="ui-button ui-button--outline" disabled={loading} onClick={onMore}>
          {loading ? t('int.common.paging.loading') : t('int.common.paging.more')}
        </button>
      )}
    </div>
  );
}

/** The count chips of a status, each with its count: a press sets the status in the address, "all" clears it. */
export function StatusChips({ statuses, counts, active, label, allLabel, chipLabel, onChoose }: { statuses: readonly string[]; counts: Readonly<Record<string, number>>; active: string | undefined; label: string; allLabel: string; chipLabel: (status: string, count: number) => string; onChoose: (status: string | undefined) => void }) {
  return (
    <fieldset className="int-chips">
      <legend>{label}</legend>
      <button type="button" className="int-chip" aria-pressed={active === undefined} onClick={() => onChoose(undefined)}>
        {allLabel}
      </button>
      {statuses.map((status) => (
        <button key={status} type="button" className="int-chip" aria-pressed={active === status} onClick={() => onChoose(status)}>
          {chipLabel(status, counts[status] ?? 0)}
        </button>
      ))}
    </fieldset>
  );
}

/** The "i" of a figure of these screens: the formula in words, the source (the table), the moment it is as of, who answers for it. Every count shown has one. */
export function CountInfo({ name, formula, source, asOf, owner }: { name: string; formula: string; source: string; asOf: string; owner: string }) {
  const { t } = useTranslation();
  const labels: InfoFormulaLabels = {
    open: t('int.common.info.open.label', { name }),
    close: t('int.common.info.close.label'),
    formula: t('int.common.info.formula.label'),
    numerator: t('int.common.info.numerator.label'),
    denominator: t('int.common.info.denominator.label'),
    exclusions: t('int.common.info.exclusions.label'),
    source: t('int.common.info.source.label'),
    asOf: t('int.common.info.asOf.label'),
    owner: t('int.common.info.owner.label'),
    version: t('int.common.info.version.label'),
  };
  return <InfoFormula name={name} formula={formula} source={source} asOf={asOf} owner={owner} version={t('int.common.info.version.text')} labels={labels} />;
}
