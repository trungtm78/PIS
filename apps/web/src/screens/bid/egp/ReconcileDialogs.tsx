import { useRef, useState } from 'react';
import { useTranslation } from '../../../i18n';
import { ConfirmDialog } from '../../../ui';
import { useReload, useResolveItem } from './reconcile-hooks';
import { fieldLabel, invalidText, problemText, resolutionEffect, resolutionLabel, subjectLabel, valueText } from './reconcile-labels';
import { MAX_EVIDENCE, MIN_REASON, RESOLUTIONS, describeProblem, resolveBody, validateResolve, vietnamToday } from './reconcile-model';
import type { FormErrors, Problem, ReconcileItem, ResolutionKind, ResolveForm } from './reconcile-model';
import './reconcile.css';

export interface ResolveDialogProps {
  item: ReconcileItem | undefined;
  onClose: () => void;
  /** Called after the command succeeded, with the sentence of the receipt. */
  onDone: (receipt: string) => void;
}

/** The dialog of the one command of the worklist: it names the difference, offers the four resolutions with what each does, asks for what the chosen one needs and says in place why it was refused. */
export function ResolveDialog({ item, onClose, onDone }: ResolveDialogProps) {
  if (item === undefined) return null;
  return <ResolveContent key={item.id} item={item} onClose={onClose} onDone={onDone} />;
}

function ResolveContent({ item, onClose, onDone }: { item: ReconcileItem; onClose: () => void; onDone: (receipt: string) => void }) {
  const { t, locale } = useTranslation();
  const resolve = useResolveItem();
  const reload = useReload();
  const [kind, setKind] = useState<ResolutionKind>('ACCEPT_EXTERNAL');
  const [form, setForm] = useState<Omit<ResolveForm, 'kind' | 'reason'>>({ evidenceRef: '', reviewOn: '' });
  const [errors, setErrors] = useState<FormErrors>({});
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const sending = useRef(false);

  const change = (patch: Partial<typeof form>): void => {
    setForm((previous) => ({ ...previous, ...patch }));
    setErrors({});
    setProblem(undefined);
  };
  const choose = (next: ResolutionKind): void => {
    setKind(next);
    setErrors({});
    setProblem(undefined);
  };

  const confirm = (reason?: string): void => {
    if (sending.current) return;
    const filled: ResolveForm = { kind, reason: reason ?? '', ...form };
    const found = validateResolve(filled, vietnamToday(new Date()));
    setErrors(found);
    setProblem(undefined);
    if (Object.keys(found).length > 0) return;
    sending.current = true;
    resolve.mutate(
      { id: item.id, version: item.version, body: resolveBody(filled, reason ?? '') },
      {
        onSuccess: () => {
          sending.current = false;
          onDone(t('egp.reconcile.success.resolved', { subject: subjectLabel(t, item.subjectType), code: item.subjectCode, field: fieldLabel(t, item.field), kind: resolutionLabel(t, kind) }));
          onClose();
        },
        onError: (failure) => {
          sending.current = false;
          setProblem(describeProblem(failure));
        },
      },
    );
  };

  const reasonError = errors.reason === undefined ? undefined : invalidText(t, errors.reason, kind);
  const summary = Object.keys(errors).length > 0 ? (reasonError ?? t('egp.reconcile.invalid.summary')) : undefined;
  const error = summary ?? (problem === undefined ? undefined : problemText(t, problem));

  return (
    <ConfirmDialog
      open
      title={t('egp.reconcile.resolve.title')}
      context={[
        { label: t('egp.reconcile.column.subject'), value: `${subjectLabel(t, item.subjectType)} ${item.subjectCode}` },
        { label: t('egp.reconcile.column.field'), value: fieldLabel(t, item.field) },
        { label: t('egp.reconcile.column.ours'), value: valueText(t, locale, item.field, item.ours) },
        { label: t('egp.reconcile.column.theirs'), value: valueText(t, locale, item.field, item.theirs) },
        { label: t('egp.reconcile.column.owner'), value: item.ownerName ?? t('egp.reconcile.cell.none') },
      ]}
      confirmLabel={t('egp.reconcile.resolve.confirm.action')}
      cancelLabel={t('egp.mapping.dialog.cancel.action')}
      pending={resolve.isPending}
      reason={{ label: t('egp.reconcile.dialog.reason.label'), required: true, minLength: MIN_REASON[kind], hint: t('egp.reconcile.dialog.reason.hint', { min: MIN_REASON[kind] }) }}
      {...(error === undefined ? {} : { error })}
      onCancel={onClose}
      onConfirm={confirm}
    >
      <div className="reconcile-form">
        <p className="sub">{t('egp.reconcile.dialog.maker.note')}</p>
        <fieldset className="reconcile-kinds">
          <legend>{t('egp.reconcile.dialog.kind.legend')}</legend>
          {RESOLUTIONS.map((one) => (
            <label key={one} className="reconcile-kind">
              <input type="radio" name="reconcile-kind" value={one} checked={kind === one} onChange={() => choose(one)} />
              <span className="reconcile-kind__body">
                <strong>{resolutionLabel(t, one)}</strong>
                <small>{resolutionEffect(t, one)}</small>
              </span>
            </label>
          ))}
        </fieldset>
        {kind === 'DISPUTE' && (
          <div className="field">
            <label htmlFor="reconcile-evidence">{t('egp.reconcile.dialog.evidence.label')}</label>
            <input id="reconcile-evidence" value={form.evidenceRef} maxLength={MAX_EVIDENCE + 20} autoComplete="off" aria-invalid={errors.evidenceRef !== undefined} aria-describedby="reconcile-evidence-hint" onChange={(event) => change({ evidenceRef: event.target.value })} />
            <span className="sub" id="reconcile-evidence-hint">
              {errors.evidenceRef === undefined ? t('egp.reconcile.dialog.evidence.hint') : <span className="reconcile-error">{invalidText(t, errors.evidenceRef, kind)}</span>}
            </span>
          </div>
        )}
        {kind === 'WAIVE' && (
          <div className="field">
            <label htmlFor="reconcile-review">{t('egp.reconcile.dialog.reviewOn.label')}</label>
            <input id="reconcile-review" type="date" value={form.reviewOn} aria-invalid={errors.reviewOn !== undefined} aria-describedby="reconcile-review-hint" onChange={(event) => change({ reviewOn: event.target.value })} />
            <span className="sub" id="reconcile-review-hint">
              {errors.reviewOn === undefined ? t('egp.reconcile.dialog.reviewOn.hint') : <span className="reconcile-error">{invalidText(t, errors.reviewOn, kind)}</span>}
            </span>
          </div>
        )}
        {problem?.kind === 'versionConflict' && (
          <button
            type="button"
            className="ui-button ui-button--outline ui-button--small"
            onClick={() => {
              void reload();
              onClose();
            }}
          >
            {t('egp.reconcile.problem.reload.action')}
          </button>
        )}
      </div>
    </ConfirmDialog>
  );
}
