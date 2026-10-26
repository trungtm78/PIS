import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { download } from '../mdm/catalogues';
import { useCloseRegister, useLedgerRead, useRegisterEntries, useRegisters } from './registers/hooks';
import type { RegisterFilter } from './registers/hooks';
import { directionLabel, entryStatusLabel, fieldProblemMessage, modeLabel, problemMessage, statusLabel } from './registers/labels';
import { buildLedgerFile } from './registers/ledger-export';
import { describeProblem } from './registers/problems';
import { closeReasonProblem } from './registers/rules';
import { DIRECTIONS, MANAGE_REGISTERS_PERMISSION, REGISTER_STATUSES } from './registers/types';
import type { Direction, Register, RegisterStatus } from './registers/types';
import './registers/doc.css';

const YEARS_BACK = 3;

interface Filter extends RegisterFilter {
  text: string;
  status: RegisterStatus | '';
}

const matches = (register: Register, filter: Filter): boolean =>
  (filter.status === '' || register.status === filter.status) &&
  (filter.text === '' || `${register.registerCode} ${register.name}`.toLowerCase().includes(filter.text.toLowerCase()));

/** DOC-10: the number registers of the tenant, with the log of the one that is open and the closing of a year. */
export default function NumberRegistersScreen({ route }: ScreenProps) {
  const tenantId = useSession().tenant?.id;
  // The filters, an open register and the closing in progress belong to one tenant: a switch starts the screen over.
  return <NumberRegistersContent key={tenantId ?? 'none'} route={route} />;
}

function NumberRegistersContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode, tenant } = useSession();
  // A suspended tenant (READ_ONLY mode) is read-only for everyone, whatever the grants say.
  const frozen = mode === 'READ_ONLY';
  const canManage = (permissions === undefined || permissions.includes(MANAGE_REGISTERS_PERMISSION)) && !frozen;
  const thisYear = new Date().getFullYear();
  const years = Array.from({ length: YEARS_BACK + 2 }, (_, index) => String(thisYear + 1 - index));
  const initial: Filter = { text: '', status: '', year: String(thisYear), direction: '' };
  const [draft, setDraft] = useState<Filter>(initial);
  const [applied, setApplied] = useState<Filter>(initial);
  const [openId, setOpenId] = useState<string | undefined>(undefined);
  const [closing, setClosing] = useState<Register | undefined>(undefined);
  const [reason, setReason] = useState('');
  const [reasonRefused, setReasonRefused] = useState(false);
  const [closed, setClosed] = useState<string | undefined>(undefined);
  const [exported, setExported] = useState<{ code: string; count: number; hash: string } | undefined>(undefined);
  const list = useRegisters({ year: applied.year, direction: applied.direction });
  const entries = useRegisterEntries(openId);
  const close = useCloseRegister();
  const ledger = useLedgerRead();
  const all = useMemo(() => list.data?.pages.flatMap((page) => page.items) ?? [], [list.data]);
  const shown = useMemo(() => all.filter((register) => matches(register, applied)), [all, applied]);
  // The state replaces the table, not the filters: a year or direction without registers can still be changed.
  const state = useScreenState({ isLoading: list.isLoading, error: list.error, data: list.data === undefined ? undefined : all });
  const opened = all.find((register) => register.id === openId);
  const rows = entries.data?.pages.flatMap((page) => page.items) ?? [];
  const problem = close.isError ? describeProblem(close.error) : undefined;
  const exportProblem = ledger.isError ? describeProblem(ledger.error) : undefined;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setApplied(draft);
    setOpenId(undefined);
  };

  const exportLedger = (register: Register): void => {
    setExported(undefined);
    ledger.mutate(register.id, {
      onSuccess: async (entriesOf) => {
        const file = await buildLedgerFile(t, { register, entries: entriesOf, tenantName: tenant?.name ?? '', exportedOn: new Date().toISOString().slice(0, 10) });
        download(file.name, file.content);
        setExported({ code: register.registerCode, count: file.rowCount, hash: file.sha256 });
      },
    });
  };

  const startClosing = (register: Register): void => {
    close.reset();
    setClosed(undefined);
    setReason('');
    setReasonRefused(false);
    setClosing(register);
  };

  const confirmClose = (event: FormEvent): void => {
    event.preventDefault();
    if (closing === undefined || close.isPending || !canManage) return;
    if (closeReasonProblem(reason) !== undefined) {
      setReasonRefused(true);
      return;
    }
    const target = closing;
    close.mutate(
      { registerId: target.id, version: target.version, reason: reason.trim() },
      {
        onSuccess: () => {
          setClosed(target.registerCode);
          setClosing(undefined);
        },
      },
    );
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('doc.registers.page.title')}</h1>
          <p>{t('doc.registers.page.subtitle')}</p>
        </div>
      </div>
      {exported === undefined ? null : (
        <p className="callout" role="status">
          {t('doc.registers.export.done.notice', { code: exported.code, count: exported.count, hash: exported.hash })}
        </p>
      )}
      {closed === undefined ? null : (
        <p className="callout" role="status">
          {t('doc.registers.closed.notice', { code: closed })}
        </p>
      )}
      <div className="card">
        <form className="filters" onSubmit={submit}>
          <div>
            <label htmlFor="register-search">{t('doc.registers.search.label')}</label>
            <input id="register-search" type="search" value={draft.text} placeholder={t('doc.registers.search.placeholder')} onChange={(event) => setDraft({ ...draft, text: event.target.value })} />
          </div>
          <div>
            <label htmlFor="register-year">{t('doc.registers.year.label')}</label>
            <select id="register-year" value={draft.year} onChange={(event) => setDraft({ ...draft, year: event.target.value })}>
              <option value="">{t('doc.registers.year.all')}</option>
              {years.map((year) => (
                <option key={year} value={year}>
                  {year}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="register-direction">{t('doc.registers.direction.label')}</label>
            <select id="register-direction" value={draft.direction} onChange={(event) => setDraft({ ...draft, direction: event.target.value as Direction | '' })}>
              <option value="">{t('doc.registers.direction.all')}</option>
              {DIRECTIONS.map((direction) => (
                <option key={direction} value={direction}>
                  {directionLabel(t, direction)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="register-status">{t('doc.registers.status.label')}</label>
            <select id="register-status" value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value as RegisterStatus | '' })}>
              <option value="">{t('doc.registers.status.all')}</option>
              {REGISTER_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {statusLabel(t, status)}
                </option>
              ))}
            </select>
          </div>
          <button type="submit">{t('doc.registers.filter.action')}</button>
        </form>
        {frozen ? (
          <p className="callout warning" role="status">
            {t('doc.registers.frozen.notice')}
          </p>
        ) : null}
        <StateBoundary state={state} onRetry={() => void list.refetch()}>
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>{t('doc.registers.col.register')}</th>
                  <th>{t('doc.registers.col.year')}</th>
                  <th>{t('doc.registers.col.direction')}</th>
                  <th>{t('doc.registers.col.counter')}</th>
                  <th>{t('doc.registers.col.status')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shown.map((register) => (
                  <tr key={register.id} data-register-id={register.id} className={register.id === openId ? 'selected' : undefined}>
                    <td>
                      <strong>{register.registerCode}</strong>
                      <div className="sub">
                        {register.name} · {modeLabel(t, register.mode)}
                      </div>
                    </td>
                    <td>{register.year}</td>
                    <td>{directionLabel(t, register.direction)}</td>
                    <td>
                      {register.lastNumber}
                      <div className="sub">{t('doc.registers.next.text', { number: register.nextNumber })}</div>
                    </td>
                    <td>{statusLabel(t, register.status)}</td>
                    <td className="row-actions">
                      <button type="button" aria-label={t('doc.registers.entries.label', { code: register.registerCode })} onClick={() => setOpenId(register.id === openId ? undefined : register.id)}>
                        {t('doc.registers.entries.action')}
                      </button>
                      {canManage && register.status === 'OPEN' ? (
                        <button type="button" aria-label={t('doc.registers.close.label', { code: register.registerCode })} onClick={() => startClosing(register)}>
                          {t('doc.registers.close.action')}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {shown.length === 0 ? <p className="muted">{t('doc.registers.filtered.empty')}</p> : null}
          <div className="row between gap tiny muted">
            <span>{t('doc.registers.count.text', { count: shown.length })}</span>
            {list.hasNextPage ? (
              <button type="button" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                {t('doc.registers.more.action')}
              </button>
            ) : null}
          </div>
        </StateBoundary>
      </div>
      {closing === undefined || !canManage ? null : (
        <form className="card" onSubmit={confirmClose} noValidate aria-label={t('doc.registers.close.title', { code: closing.registerCode })}>
          <h2>{t('doc.registers.close.title', { code: closing.registerCode })}</h2>
          <p className="sub">{t('doc.registers.close.hint')}</p>
          <div className="field">
            <label htmlFor="register-close-reason">{t('doc.registers.close.reason.label')}</label>
            <textarea id="register-close-reason" value={reason} aria-invalid={reasonRefused} onChange={(event) => setReason(event.target.value)} />
            {reasonRefused && closeReasonProblem(reason) !== undefined ? (
              <small role="alert" className="field-error">
                {fieldProblemMessage(t, closeReasonProblem(reason) ?? 'required')}
              </small>
            ) : null}
          </div>
          {problem === undefined ? null : (
            <p className="callout warning" role="alert">
              {problemMessage(t, problem)}
            </p>
          )}
          <div className="row gap">
            <button type="submit" className="primary" disabled={close.isPending}>
              {t('doc.registers.close.confirm.action')}
            </button>
            <button type="button" onClick={() => setClosing(undefined)}>
              {t('doc.registers.close.cancel.action')}
            </button>
          </div>
        </form>
      )}
      {opened === undefined ? null : (
        <div className="card" data-entries-of={opened.id}>
          <div className="row between gap">
            <h2>{t('doc.registers.entries.title', { code: opened.registerCode, year: opened.year })}</h2>
            <button type="button" disabled={ledger.isPending} onClick={() => exportLedger(opened)}>
              {t('doc.registers.export.action')}
            </button>
          </div>
          {ledger.isPending ? (
            <p className="muted" role="status">
              {t('doc.registers.export.running')}
            </p>
          ) : null}
          {exportProblem === undefined ? null : (
            <p className="callout warning" role="alert">
              {problemMessage(t, exportProblem)}
            </p>
          )}
          {entries.isError ? (
            <p className="callout warning" role="alert">
              {problemMessage(t, describeProblem(entries.error))}
            </p>
          ) : entries.isLoading ? (
            <p className="muted" role="status">
              {t('doc.registers.entries.loading')}
            </p>
          ) : rows.length === 0 ? (
            <p className="muted">{t('doc.registers.entries.empty')}</p>
          ) : (
            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th>{t('doc.registers.entries.col.number')}</th>
                    <th>{t('doc.registers.entries.col.symbol')}</th>
                    <th>{t('doc.registers.entries.col.issuedOn')}</th>
                    <th>{t('doc.registers.entries.col.status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((entry) => (
                    <tr key={entry.allocationId} data-entry-number={entry.number}>
                      <td>{entry.displayNumber}</td>
                      <td>{entry.symbol}</td>
                      <td>{entry.issuedOn}</td>
                      <td>{entryStatusLabel(t, entry.status)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {entries.hasNextPage ? (
            <button type="button" disabled={entries.isFetchingNextPage} onClick={() => void entries.fetchNextPage()}>
              {t('doc.registers.entries.more.action')}
            </button>
          ) : null}
        </div>
      )}
      <p className="prototype-note">{t('doc.registers.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
