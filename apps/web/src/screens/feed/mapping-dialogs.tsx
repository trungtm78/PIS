import { useEffect, useRef, useState } from 'react';
import { useTranslation } from '../../i18n';
import { ConfirmDialog } from '../../ui';
import { useDecide, usePropose, useReload, useRetire } from './feed-hooks';
import { issueLabel, methodLabel, problemText } from './feed-labels';
import { MAX_CODE, MIN_REASON, dayText, describeProblem, proposeBody, validatePropose } from './feed-model';
import type { Mapping, Problem, ProposeErrors, ProposeField, ProposeForm } from './feed-model';
import './feed.css';

export type MappingDialog = { kind: 'propose'; form: ProposeForm; nonce: number; fixedExternal: boolean } | { kind: 'decide'; row: Mapping; decision: 'APPROVE' | 'REJECT' } | { kind: 'retire'; row: Mapping };

export interface MappingDialogsProps {
  dialog: MappingDialog | undefined;
  onClose: () => void;
  /** Called after a command succeeded, with the sentence of the receipt. */
  onDone: (receipt: string) => void;
}

/** The dialogs of the commands of FEED-03: each names the record and the effect, asks for the reason, locks while it sends and says in place why it was refused. */
export function MappingDialogs({ dialog, onClose, onDone }: MappingDialogsProps) {
  if (dialog === undefined) return null;
  if (dialog.kind === 'propose') return <ProposeDialog key={dialog.nonce} initial={dialog.form} fixedExternal={dialog.fixedExternal} onClose={onClose} onDone={onDone} />;
  return <RowDialog key={`${dialog.kind}:${dialog.row.id}`} dialog={dialog} onClose={onClose} onDone={onDone} />;
}

function Reload({ problem, onReload }: { problem: Problem | undefined; onReload: () => void }) {
  const { t } = useTranslation();
  if (problem?.kind !== 'versionConflict') return null;
  return (
    <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={onReload}>
      {t('feed.common.problem.reload.action')}
    </button>
  );
}

function RowDialog({ dialog, onClose, onDone }: { dialog: Exclude<MappingDialog, { kind: 'propose' }>; onClose: () => void; onDone: (receipt: string) => void }) {
  const { t } = useTranslation();
  const decide = useDecide();
  const retire = useRetire();
  const reload = useReload();
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const sending = useRef(false);
  const row = dialog.row;
  const pending = decide.isPending || retire.isPending;
  const validity = t('feed.mapping.cell.validity', { from: dayText(row.validFrom), until: row.validUntil === null ? t('feed.mapping.cell.unlimited') : dayText(row.validUntil) });
  const context = [
    { label: t('feed.mapping.column.external'), value: row.externalCode },
    { label: t('feed.mapping.column.ours'), value: row.ourName === null ? row.ourCode : `${row.ourCode} (${row.ourName})` },
    { label: t('feed.mapping.column.validity'), value: validity },
    ...(row.proposedByName === null ? [] : [{ label: t('feed.mapping.dialog.proposedBy.label'), value: row.proposedByName }]),
  ];
  const fail = (error: unknown): void => {
    sending.current = false;
    setProblem(describeProblem(error));
  };
  const done = (receipt: string): void => {
    sending.current = false;
    onDone(receipt);
    onClose();
  };
  const common = {
    open: true,
    context,
    cancelLabel: t('feed.common.dialog.cancel.action'),
    pending,
    reason: { label: t('feed.common.dialog.reason.label'), required: true, minLength: MIN_REASON, hint: t('feed.common.dialog.reason.hint', { count: MIN_REASON }) },
    onCancel: onClose,
    ...(problem === undefined ? {} : { error: problemText(t, problem) }),
  };
  const send = (run: (text: string) => void) => (text?: string): void => {
    if (sending.current) return;
    sending.current = true;
    setProblem(undefined);
    run((text ?? '').trim());
  };
  const codes = { external: row.externalCode, ours: row.ourCode };
  const refreshAndClose = (): void => {
    void reload();
    onClose();
  };

  if (dialog.kind === 'retire') {
    return (
      <ConfirmDialog
        {...common}
        title={t('feed.mapping.retire.title')}
        confirmLabel={t('feed.mapping.retire.confirm.action')}
        onConfirm={send((text) => retire.mutate({ id: row.id, version: row.version, reason: text }, { onSuccess: () => done(t('feed.mapping.success.retired', codes)), onError: fail }))}
      >
        <p className="feed-note">{t('feed.mapping.retire.effect')}</p>
        <Reload problem={problem} onReload={refreshAndClose} />
      </ConfirmDialog>
    );
  }
  const approve = dialog.decision === 'APPROVE';
  return (
    <ConfirmDialog
      {...common}
      title={approve ? t('feed.mapping.approve.title') : t('feed.mapping.reject.title')}
      confirmLabel={approve ? t('feed.mapping.approve.confirm.action') : t('feed.mapping.reject.confirm.action')}
      onConfirm={send((text) =>
        decide.mutate({ id: row.id, version: row.version, decision: dialog.decision, reason: text }, { onSuccess: () => done(approve ? t('feed.mapping.success.approved', codes) : t('feed.mapping.success.rejected', codes)), onError: fail }),
      )}
    >
      <p className="feed-note">{approve ? t('feed.mapping.approve.effect') : t('feed.mapping.reject.effect')}</p>
      <p className="feed-note">{t('feed.mapping.dialog.maker.note')}</p>
      <Reload problem={problem} onReload={refreshAndClose} />
    </ConfirmDialog>
  );
}

function ProposeDialog({ initial, fixedExternal, onClose, onDone }: { initial: ProposeForm; fixedExternal: boolean; onClose: () => void; onDone: (receipt: string) => void }) {
  const { t } = useTranslation();
  const propose = usePropose();
  const reload = useReload();
  const [form, setForm] = useState<ProposeForm>(initial);
  const [errors, setErrors] = useState<ProposeErrors>({});
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const sending = useRef(false);
  const wrap = useRef<HTMLDivElement>(null);

  // The dialog opens on its first field, not on the reason at its foot.
  useEffect(() => {
    const timer = setTimeout(() => wrap.current?.querySelector<HTMLElement>('input:not([readonly]):not([disabled])')?.focus(), 0);
    return () => clearTimeout(timer);
  }, []);

  const change = <K extends keyof ProposeForm>(key: K, value: ProposeForm[K]): void => {
    setForm((previous) => ({ ...previous, [key]: value }));
    setErrors({});
    setProblem(undefined);
  };
  const SERVER_FIELD: Readonly<Record<string, ProposeField>> = { our_code: 'ourCode', external_code: 'externalCode', valid_from: 'validFrom', valid_until: 'validUntil' };
  const named = (field: ProposeField): string | undefined => {
    const own = errors[field];
    if (own !== undefined) return issueLabel(t, own);
    return problem?.kind === 'validation' && problem.field !== undefined && SERVER_FIELD[problem.field] === field ? problemText(t, problem) : undefined;
  };

  const text = (field: 'ourCode' | 'externalCode', id: string, label: string, readOnly: boolean) => {
    const message = named(field);
    return (
      <div className="field">
        <label htmlFor={id}>{label}</label>
        <input id={id} value={form[field]} readOnly={readOnly} maxLength={MAX_CODE + 20} aria-invalid={message !== undefined} aria-describedby={message === undefined ? undefined : `${id}-error`} autoComplete="off" onChange={(event) => change(field, event.target.value)} />
        {message !== undefined && (
          <span className="feed-error" id={`${id}-error`}>
            {message}
          </span>
        )}
      </div>
    );
  };
  const day = (field: 'validFrom' | 'validUntil', id: string, label: string, hint: string) => {
    const message = named(field);
    return (
      <div className="field">
        <label htmlFor={id}>{label}</label>
        <input id={id} type="date" value={form[field]} aria-invalid={message !== undefined} aria-describedby={message === undefined ? undefined : `${id}-error`} onChange={(event) => change(field, event.target.value)} />
        <span className="sub">{hint}</span>
        {message !== undefined && (
          <span className="feed-error" id={`${id}-error`}>
            {message}
          </span>
        )}
      </div>
    );
  };

  const error = Object.keys(errors).length > 0 ? t('feed.mapping.invalid.summary') : problem === undefined ? undefined : problemText(t, problem);

  const confirm = (reason?: string): void => {
    if (sending.current) return;
    const found = validatePropose(form);
    setErrors(found);
    setProblem(undefined);
    if (Object.keys(found).length > 0) return;
    sending.current = true;
    propose.mutate(proposeBody(form, reason ?? ''), {
      onSuccess: () => {
        sending.current = false;
        onDone(t('feed.mapping.success.proposed', { ours: form.ourCode.trim(), external: form.externalCode.trim() }));
        onClose();
      },
      onError: (failure) => {
        sending.current = false;
        setProblem(describeProblem(failure));
      },
    });
  };

  return (
    <ConfirmDialog
      open
      title={t('feed.mapping.propose.title')}
      context={[
        { label: t('feed.mapping.dialog.source.label'), value: t('feed.mapping.dialog.source.value') },
        { label: t('feed.mapping.column.method'), value: methodLabel(t, 'MANUAL') },
      ]}
      confirmLabel={t('feed.mapping.propose.confirm.action')}
      cancelLabel={t('feed.common.dialog.cancel.action')}
      pending={propose.isPending}
      reason={{ label: t('feed.mapping.propose.reason.label'), required: true, minLength: MIN_REASON, hint: t('feed.common.dialog.reason.hint', { count: MIN_REASON }) }}
      {...(error === undefined ? {} : { error })}
      onCancel={onClose}
      onConfirm={confirm}
    >
      <div ref={wrap} className="feed-form">
        <p className="feed-note">{t('feed.mapping.propose.maker.note')}</p>
        {text('externalCode', 'feed-mapping-external', t('feed.mapping.field.externalCode.label'), fixedExternal)}
        {text('ourCode', 'feed-mapping-ours', t('feed.mapping.field.ourCode.label'), false)}
        {day('validFrom', 'feed-mapping-from', t('feed.mapping.field.validFrom.label'), t('feed.mapping.field.validFrom.hint'))}
        {day('validUntil', 'feed-mapping-until', t('feed.mapping.field.validUntil.label'), t('feed.mapping.field.validUntil.hint'))}
        <Reload
          problem={problem}
          onReload={() => {
            void reload();
            onClose();
          }}
        />
      </div>
    </ConfirmDialog>
  );
}
