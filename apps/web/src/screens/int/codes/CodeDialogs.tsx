import { useState } from 'react';
import { useTranslation } from '../../../i18n';
import type { Translator } from '../../../i18n';
import { CommandDialog } from '../int-common';
import { useDecideCode, useProposeCode, useRegisterSystem, useRetireCode, useRetireSystem } from '../int-hooks';
import { dayText, fitsPattern } from '../int-model';
import type { Problem, ProjectCode, ProjectCodePage, SourceSystem } from '../int-model';
import { SOURCE_SYSTEM_KINDS } from './code-model';
import { systemKindLabel } from './code-labels';

type T = Translator['t'];

export type CodeDialog =
  | { kind: 'propose' }
  | { kind: 'decide'; code: ProjectCode; decision: 'APPROVE' | 'REJECT' }
  | { kind: 'retire'; code: ProjectCode }
  | { kind: 'register' }
  | { kind: 'retireSystem'; system: SourceSystem };

export interface CodeDialogsProps {
  dialog: CodeDialog | undefined;
  page: ProjectCodePage | undefined;
  onClose: () => void;
  /** Called after a command succeeded, with the sentence of the receipt. */
  onDone: (receipt: string) => void;
}

const codeContext = (t: T, code: ProjectCode): { label: string; value: string }[] => [
  { label: t('int.codes.column.system'), value: code.source_system },
  { label: t('int.codes.column.ours'), value: `${code.project_code} (${code.project_name})` },
  { label: t('int.codes.column.external'), value: code.external_code },
  { label: t('int.codes.column.validity'), value: t('int.codes.cell.validity', { from: dayText(code.valid_from), until: code.valid_until === null ? t('int.codes.cell.unlimited') : dayText(code.valid_until) }) },
  ...(code.proposed_by_name === null ? [] : [{ label: t('int.codes.dialog.proposedBy.label'), value: code.proposed_by_name }]),
];

export function CodeDialogs({ dialog, page, onClose, onDone }: CodeDialogsProps) {
  if (dialog === undefined) return null;
  switch (dialog.kind) {
    case 'propose':
      return <ProposeDialog page={page} onClose={onClose} onDone={onDone} />;
    case 'register':
      return <RegisterDialog onClose={onClose} onDone={onDone} />;
    case 'retireSystem':
      return <RetireSystemDialog key={dialog.system.id} system={dialog.system} onClose={onClose} onDone={onDone} />;
    case 'retire':
      return <RetireCodeDialog key={dialog.code.id} code={dialog.code} onClose={onClose} onDone={onDone} />;
    default:
      return <DecideDialog key={`${dialog.code.id}:${dialog.decision}`} code={dialog.code} decision={dialog.decision} onClose={onClose} onDone={onDone} />;
  }
}

function DecideDialog({ code, decision, onClose, onDone }: { code: ProjectCode; decision: 'APPROVE' | 'REJECT'; onClose: () => void; onDone: (receipt: string) => void }) {
  const { t } = useTranslation();
  const decide = useDecideCode();
  const approve = decision === 'APPROVE';
  const names = { code: code.project_code, external: code.external_code };
  return (
    <CommandDialog
      title={approve ? t('int.codes.approve.title') : t('int.codes.reject.title')}
      context={codeContext(t, code)}
      confirmLabel={approve ? t('int.codes.approve.confirm.action') : t('int.codes.reject.confirm.action')}
      effect={
        <>
          {approve ? t('int.codes.approve.effect') : t('int.codes.reject.effect')} {t('int.codes.dialog.maker.note')}
        </>
      }
      run={(reason) => decide.mutateAsync({ id: code.id, version: code.version, decision, reason })}
      onDone={() => onDone(approve ? t('int.codes.success.approved', names) : t('int.codes.success.rejected', names))}
      onClose={onClose}
    />
  );
}

function RetireCodeDialog({ code, onClose, onDone }: { code: ProjectCode; onClose: () => void; onDone: (receipt: string) => void }) {
  const { t } = useTranslation();
  const retire = useRetireCode();
  return (
    <CommandDialog
      title={t('int.codes.retire.title')}
      context={codeContext(t, code)}
      confirmLabel={t('int.codes.retire.confirm.action')}
      effect={t('int.codes.retire.effect')}
      run={(reason) => retire.mutateAsync({ id: code.id, version: code.version, reason })}
      onDone={() => onDone(t('int.codes.success.retired', { code: code.project_code, external: code.external_code }))}
      onClose={onClose}
    />
  );
}

function RetireSystemDialog({ system, onClose, onDone }: { system: SourceSystem; onClose: () => void; onDone: (receipt: string) => void }) {
  const { t } = useTranslation();
  const retire = useRetireSystem();
  return (
    <CommandDialog
      title={t('int.codes.system.retire.title')}
      context={[
        { label: t('int.codes.system.column.code'), value: system.code },
        { label: t('int.codes.system.column.name'), value: system.name },
        { label: t('int.codes.system.column.active'), value: String(system.active_codes) },
      ]}
      confirmLabel={t('int.codes.systemRetireConfirm.action')}
      effect={t('int.codes.system.retire.effect')}
      run={(reason) => retire.mutateAsync({ id: system.id, version: system.version, reason })}
      onDone={() => onDone(t('int.codes.success.systemRetired', { code: system.code }))}
      onClose={onClose}
    />
  );
}

type SystemKind = (typeof SOURCE_SYSTEM_KINDS)[number];

function RegisterDialog({ onClose, onDone }: { onClose: () => void; onDone: (receipt: string) => void }) {
  const { t } = useTranslation();
  const register = useRegisterSystem();
  const [form, setForm] = useState<{ code: string; name: string; kind: SystemKind; pattern: string }>({ code: '', name: '', kind: 'ERP', pattern: '' });
  const [errors, setErrors] = useState<Partial<Record<'code' | 'name' | 'pattern', true>>>({});
  const judge = (): boolean => {
    const found: typeof errors = {};
    if (!/^[A-Z][A-Z0-9_]{1,29}$/.test(form.code.trim())) found.code = true;
    if (form.name.trim() === '' || form.name.trim().length > 120) found.name = true;
    if (form.pattern.trim() !== '') {
      try {
        new RegExp(form.pattern.trim());
      } catch {
        found.pattern = true;
      }
    }
    setErrors(found);
    return Object.keys(found).length === 0;
  };
  const onProblem = (problem: Problem): void => {
    if (problem.kind === 'systemTaken') setErrors({ code: true });
    else if (problem.kind === 'validation' && (problem.field === 'code' || problem.field === 'name' || problem.field === 'code_pattern')) setErrors({ [problem.field === 'code_pattern' ? 'pattern' : problem.field]: true });
  };
  return (
    <CommandDialog
      title={t('int.codes.system.register.title')}
      context={[]}
      confirmLabel={t('int.codes.systemRegisterConfirm.action')}
      effect={t('int.codes.system.register.effect')}
      reason={false}
      valid={judge}
      run={() => register.mutateAsync({ code: form.code.trim(), name: form.name.trim(), kind: form.kind, ...(form.pattern.trim() === '' ? {} : { code_pattern: form.pattern.trim() }) })}
      onProblem={onProblem}
      onDone={() => onDone(t('int.codes.success.systemRegistered', { code: form.code.trim() }))}
      onClose={onClose}
    >
      <div className="int-form">
        <div className="field">
          <label htmlFor="int-system-code">{t('int.codes.systemFieldCode.label')}</label>
          <input id="int-system-code" value={form.code} maxLength={30} aria-invalid={errors.code === true} onChange={(event) => setForm({ ...form, code: event.target.value.toUpperCase() })} />
          {errors.code === true && (
            <span className="int-error" role="alert">
              {t('int.codes.system.error.code')}
            </span>
          )}
        </div>
        <div className="field">
          <label htmlFor="int-system-name">{t('int.codes.systemFieldName.label')}</label>
          <input id="int-system-name" value={form.name} maxLength={120} aria-invalid={errors.name === true} onChange={(event) => setForm({ ...form, name: event.target.value })} />
          {errors.name === true && (
            <span className="int-error" role="alert">
              {t('int.codes.system.error.name')}
            </span>
          )}
        </div>
        <div className="field">
          <label htmlFor="int-system-kind">{t('int.codes.systemFieldKind.label')}</label>
          <select id="int-system-kind" value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value as SystemKind })}>
            {SOURCE_SYSTEM_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {systemKindLabel(t, kind)}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="int-system-pattern">{t('int.codes.systemFieldPattern.label')}</label>
          <input id="int-system-pattern" value={form.pattern} maxLength={120} aria-invalid={errors.pattern === true} onChange={(event) => setForm({ ...form, pattern: event.target.value })} />
          <span className="sub">{t('int.codes.systemFieldPattern.hint')}</span>
          {errors.pattern === true && (
            <span className="int-error" role="alert">
              {t('int.codes.system.error.pattern')}
            </span>
          )}
        </div>
      </div>
    </CommandDialog>
  );
}

function ProposeDialog({ page, onClose, onDone }: { page: ProjectCodePage | undefined; onClose: () => void; onDone: (receipt: string) => void }) {
  const { t } = useTranslation();
  const propose = useProposeCode();
  const systems = page?.systems ?? [];
  const [form, setForm] = useState({ system: systems[0]?.code ?? '', ours: '', external: '', from: '', until: '' });
  const [errors, setErrors] = useState<Partial<Record<'system' | 'ours' | 'external' | 'until', true>>>({});
  const chosen = systems.find((system) => system.code === form.system);
  const judge = (): boolean => {
    const found: typeof errors = {};
    if (chosen === undefined) found.system = true;
    if (form.ours.trim() === '' || form.ours.trim().length > 100) found.ours = true;
    if (form.external.trim() === '' || form.external.trim().length > 100 || !fitsPattern(chosen?.code_pattern ?? null, form.external.trim())) found.external = true;
    if (form.from !== '' && form.until !== '' && form.until <= form.from) found.until = true;
    setErrors(found);
    return Object.keys(found).length === 0;
  };
  const onProblem = (problem: Problem): void => {
    if (problem.kind === 'duplicateTaken' || problem.kind === 'duplicateHolds' || problem.kind === 'duplicateWaiting' || problem.kind === 'duplicate') setErrors({ external: true });
    else if (problem.kind === 'validation') {
      if (problem.field === 'our_code') setErrors({ ours: true });
      else if (problem.field === 'external_code') setErrors({ external: true });
      else if (problem.field === 'source_system') setErrors({ system: true });
      else if (problem.field === 'valid_until') setErrors({ until: true });
    }
  };
  return (
    <CommandDialog
      title={t('int.codes.propose.title')}
      context={[]}
      confirmLabel={t('int.codes.propose.confirm.action')}
      effect={t('int.codes.propose.effect')}
      valid={judge}
      run={(reason) =>
        propose.mutateAsync({
          source_system: form.system,
          our_code: form.ours.trim(),
          external_code: form.external.trim(),
          ...(form.from === '' ? {} : { valid_from: form.from }),
          ...(form.until === '' ? {} : { valid_until: form.until }),
          reason,
        })
      }
      onProblem={onProblem}
      onDone={() => onDone(t('int.codes.success.proposed', { code: form.ours.trim(), external: form.external.trim() }))}
      onClose={onClose}
    >
      <div className="int-form">
        <div className="field">
          <label htmlFor="int-code-system">{t('int.codes.field.system.label')}</label>
          <select id="int-code-system" value={form.system} aria-invalid={errors.system === true} onChange={(event) => setForm({ ...form, system: event.target.value })}>
            {systems.map((system) => (
              <option key={system.code} value={system.code}>
                {`${system.code} - ${system.name}`}
              </option>
            ))}
          </select>
          {systems.length === 0 && <span className="sub">{t('int.codes.field.system.none')}</span>}
        </div>
        <div className="field">
          <label htmlFor="int-code-ours">{t('int.codes.field.ours.label')}</label>
          <input id="int-code-ours" value={form.ours} maxLength={100} aria-invalid={errors.ours === true} onChange={(event) => setForm({ ...form, ours: event.target.value })} />
          {errors.ours === true && (
            <span className="int-error" role="alert">
              {t('int.codes.error.ours')}
            </span>
          )}
        </div>
        <div className="field">
          <label htmlFor="int-code-external">{t('int.codes.field.external.label')}</label>
          <input id="int-code-external" value={form.external} maxLength={100} aria-invalid={errors.external === true} onChange={(event) => setForm({ ...form, external: event.target.value })} />
          {chosen?.code_pattern !== null && chosen?.code_pattern !== undefined && <span className="sub">{t('int.codes.field.external.pattern', { pattern: chosen.code_pattern })}</span>}
          {errors.external === true && (
            <span className="int-error" role="alert">
              {t('int.codes.error.external')}
            </span>
          )}
        </div>
        <div className="field">
          <label htmlFor="int-code-from">{t('int.codes.field.validFrom.label')}</label>
          <input id="int-code-from" type="date" value={form.from} onChange={(event) => setForm({ ...form, from: event.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="int-code-until">{t('int.codes.field.validUntil.label')}</label>
          <input id="int-code-until" type="date" value={form.until} aria-invalid={errors.until === true} onChange={(event) => setForm({ ...form, until: event.target.value })} />
          {errors.until === true && (
            <span className="int-error" role="alert">
              {t('int.codes.error.until')}
            </span>
          )}
        </div>
      </div>
    </CommandDialog>
  );
}
