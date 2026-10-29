import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { linkOf } from '../dis/export/model';
import { useArchive, useFileLink, useManifest, useOffboard, useRenew, useRequestExport, useTenantExit, useTenantExports } from './offboarding/hooks';
import { problemMessage, scopeLabel, statusLabel, statusTone, tenantStatusLabel } from './offboarding/labels';
import {
  DEFAULT_WINDOW_DAYS,
  EXPORT_PERMISSION,
  MANAGE_PERMISSION,
  MANIFEST_PATH,
  MAX_REASON,
  MAX_WINDOW_DAYS,
  MIN_WINDOW_DAYS,
  READ_PERMISSION,
  canArchive,
  canOffboard,
  describeProblem,
  downloadedOf,
  isDateValid,
  isPending,
  isReasonValid,
  isServable,
  isWindowValid,
  looksLikePublicKey,
} from './offboarding/model';
import type { ExportScope, ExportView, LinkView } from './offboarding/model';
import { TenantPicker } from './subscription/TenantPicker';
import { useTenantChoice } from './subscription/hooks';
import { toneClass } from './tenants/labels';
import './tenants/sas.css';
import './billing/billing.css';

type Leaving = 'offboard' | 'archive' | 'renew';

/**
 * SAS-17: the data of a tenant that leaves (BR-SAS-03). The owner of a tenant asks for an export of its data (all of it, or the business data only; optionally encrypted for a key of its own), watches it being made, reads its
 * manifest (every file with its size and sha256, the rows of every table) and downloads the files, each through a link of a few minutes; the export is Delivered when every file was downloaded, and expires 72 hours after it is ready.
 * The System Admin starts the offboarding of a tenant (the end of its contract and the days of the window to export), sees the window, whether an export was delivered and the legal holds in force, and archives the tenant once an export
 * was delivered or the window is over; a tenant whose contract is renewed in the window is brought back. Archiving deletes nothing: the purge that follows keeps what a legal hold holds.
 */
export default function OffboardingScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The forms and the notices belong to one membership: a switch starts the screen over.
  return <OffboardingContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function OffboardingContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions } = useSession();
  const canExport = permissions === undefined || permissions.includes(EXPORT_PERMISSION);
  const canRead = permissions === undefined ? false : permissions.includes(READ_PERMISSION) || permissions.includes(MANAGE_PERMISSION);
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title" className="sas-billing">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('sas.exit.page.title')}</h1>
          <p>{t('sas.exit.page.subtitle')}</p>
        </div>
      </div>
      {canExport ? <ExportSection /> : null}
      {canRead ? <LeavingSection canManage={permissions?.includes(MANAGE_PERMISSION) === true} /> : null}
    </section>
  );
}

function ExportSection() {
  const { t, locale } = useTranslation();
  const exports = useTenantExports(true);
  const request = useRequestExport();
  const file = useFileLink();
  const [scope, setScope] = useState<ExportScope>('FULL');
  const [key, setKey] = useState('');
  const [reason, setReason] = useState('');
  const [invalid, setInvalid] = useState<ReadonlySet<'reason' | 'key'>>(new Set());
  const [sent, setSent] = useState(false);
  const [opened, setOpened] = useState<string | undefined>(undefined);
  const [links, setLinks] = useState<Record<string, LinkView>>({});
  // The moment the screen judges the links by. It moves when the next link ends, so a link left idle is replaced by the button that asks for another, whether or not anything else makes the screen draw again.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const current = Date.now();
    const ends = Object.values(links)
      .map((link) => new Date(link.expiresAt).getTime())
      .filter((end) => end > current);
    if (ends.length === 0) return undefined;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.min(...ends) - current + 50);
    return () => window.clearTimeout(timer);
  }, [links, now]);
  const manifest = useManifest(opened);

  const state = useScreenState({ isLoading: exports.isLoading, error: exports.error, data: exports.data, isEmpty: () => false });
  const items = (exports.data?.pages ?? []).flatMap((page) => page.items);
  const version = exports.data?.pages[0]?.exportsVersion ?? 0;
  const waiting = items.some(isPending);
  const problem = request.isError ? describeProblem(request.error) : file.isError ? describeProblem(file.error) : undefined;
  const day = (value: string): string => new Date(value).toLocaleString(locale, { timeZone: 'UTC' });
  const size = (bytes: number | string): string => Number(bytes).toLocaleString(locale);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (request.isPending || waiting) return;
    const bad = new Set<'reason' | 'key'>();
    if (!isReasonValid(reason)) bad.add('reason');
    if (key.trim() !== '' && !looksLikePublicKey(key)) bad.add('key');
    if (bad.size > 0) {
      setInvalid(bad);
      return;
    }
    setSent(false);
    request.mutate(
      { scope, publicKeyPem: key.trim() === '' ? undefined : key.trim(), reason: reason.trim(), version },
      {
        onSuccess: () => {
          setSent(true);
          setReason('');
          setKey('');
          setInvalid(new Set());
        },
      },
    );
  };

  const ask = (exportId: string, path: string): void =>
    file.mutate(
      { exportId, path },
      {
        onSuccess: (link) => {
          if (link !== undefined) {
            setNow(Date.now());
            setLinks((current) => ({ ...current, [`${exportId}:${path}`]: link }));
          }
        },
      },
    );

  return (
    <>
      <div className="card">
        <h2>{t('sas.exit.export.title')}</h2>
        <p className="sub">{t('sas.exit.export.rule')}</p>
        {sent ? (
          <p className="callout" role="status">
            {t('sas.exit.export.done')}
          </p>
        ) : null}
        {problem === undefined ? null : (
          <div className="callout warning" role="alert">
            <p>{problemMessage(t, problem)}</p>
          </div>
        )}
        <form onSubmit={submit} noValidate aria-label={t('sas.exit.export.aria')} className="billing-issue">
          <fieldset className="field">
            <legend>{t('sas.exit.export.scope.legend')}</legend>
            <label>
              <input type="radio" name="export-scope" checked={scope === 'FULL'} onChange={() => setScope('FULL')} /> {t('sas.exit.scope.full')}
            </label>{' '}
            <label>
              <input type="radio" name="export-scope" checked={scope === 'BUSINESS_DATA_ONLY'} onChange={() => setScope('BUSINESS_DATA_ONLY')} /> {t('sas.exit.scope.business')}
            </label>
          </fieldset>
          <div className="field">
            <label htmlFor="export-key">{t('sas.exit.export.key.label')}</label>
            <textarea id="export-key" rows={3} value={key} aria-invalid={invalid.has('key')} onChange={(event) => setKey(event.target.value)} />
            <small className="sub">{t('sas.exit.export.key.hint')}</small>
            {invalid.has('key') ? (
              <small role="alert" className="field-error">
                {t('sas.exit.export.key.invalid')}
              </small>
            ) : null}
          </div>
          <div className="field">
            <label htmlFor="export-reason">{t('sas.exit.export.reason.label')}</label>
            <textarea id="export-reason" rows={2} maxLength={MAX_REASON} value={reason} aria-invalid={invalid.has('reason')} onChange={(event) => setReason(event.target.value)} />
            {invalid.has('reason') ? (
              <small role="alert" className="field-error">
                {t('sas.exit.export.reason.tooShort')}
              </small>
            ) : null}
          </div>
          <div className="row gap">
            <button type="submit" className="primary" disabled={request.isPending || waiting}>
              {t('sas.exit.export.submit.action')}
            </button>
            {waiting ? <span className="sub">{t('sas.exit.export.waiting')}</span> : null}
          </div>
        </form>
      </div>
      <StateBoundary state={state} onRetry={() => void exports.refetch()}>
        <div className="card">
          <h2>{t('sas.exit.list.title')}</h2>
          {items.length === 0 ? (
            <p className="sub" role="status">
              {t('sas.exit.list.none')}
            </p>
          ) : (
            <table className="table" data-exports>
              <thead>
                <tr>
                  <th scope="col">{t('sas.exit.column.requested')}</th>
                  <th scope="col">{t('sas.exit.column.scope')}</th>
                  <th scope="col">{t('sas.exit.column.status')}</th>
                  <th scope="col">{t('sas.exit.column.ready')}</th>
                  <th scope="col">{t('sas.exit.column.files')}</th>
                  <th scope="col">
                    <span className="visually-hidden">{t('sas.exit.column.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((entry) => (
                  <ExportRow key={entry.id} entry={entry} day={day} size={size} onOpen={() => setOpened(opened === entry.id ? undefined : entry.id)} open={opened === entry.id} />
                ))}
              </tbody>
            </table>
          )}
          {exports.hasNextPage ? (
            <div className="row gap">
              <button type="button" disabled={exports.isFetchingNextPage} onClick={() => void exports.fetchNextPage()}>
                {t('sas.exit.list.more.action')}
              </button>
            </div>
          ) : null}
          {opened === undefined ? null : (
            <div data-manifest>
              <h3>{t('sas.exit.manifest.title')}</h3>
              {manifest.isLoading ? (
                <p className="sub" role="status">
                  {t('sas.exit.manifest.loading')}
                </p>
              ) : manifest.isError || manifest.data === undefined ? (
                <p className="callout warning" role="alert">
                  {t('sas.exit.manifest.error')}
                </p>
              ) : (
                <>
                  <p className="sub">{t('sas.exit.manifest.summary', { at: day(manifest.data.snapshotAt), files: manifest.data.files.length, scope: scopeLabel(t, manifest.data.scope) })}</p>
                  <p className="sub">{t('sas.exit.manifest.verify')}</p>
                  {manifest.data.missingFiles.length === 0 ? null : (
                    <p className="callout warning" role="alert" data-missing-files>
                      {t('sas.exit.manifest.missing', { count: manifest.data.missingFiles.length })}
                    </p>
                  )}
                  {manifest.data.withheldFiles.length === 0 ? null : (
                    <p className="callout warning" role="alert" data-withheld-files>
                      {t('sas.exit.manifest.withheld', { count: manifest.data.withheldFiles.length })}
                    </p>
                  )}
                  {manifest.data.unreadableTables.length === 0 ? null : (
                    <p className="callout warning" role="alert" data-unreadable-tables>
                      {t('sas.exit.manifest.unreadable', { tables: manifest.data.unreadableTables.join(', ') })}
                    </p>
                  )}
                  {Object.keys(manifest.data.omittedColumns).length === 0 ? null : <p className="sub">{t('sas.exit.manifest.omitted', { tables: Object.keys(manifest.data.omittedColumns).join(', ') })}</p>}
                  {manifest.data.keyFingerprint === undefined ? null : <p className="sub">{t('sas.exit.manifest.key', { fingerprint: manifest.data.keyFingerprint })}</p>}
                  <table className="table" data-files>
                    <thead>
                      <tr>
                        <th scope="col">{t('sas.exit.file.path')}</th>
                        <th scope="col" className="amount">
                          {t('sas.exit.file.bytes')}
                        </th>
                        <th scope="col" className="amount">
                          {t('sas.exit.file.rows')}
                        </th>
                        <th scope="col">{t('sas.exit.file.sha256')}</th>
                        <th scope="col">
                          <span className="visually-hidden">{t('sas.exit.column.actions')}</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {[{ path: MANIFEST_PATH, bytes: 0, sha256: '', rows: undefined }, ...manifest.data.files].map((row) => {
                        const known = links[`${opened}:${row.path}`];
                        // A link lives five minutes; one that ended is asked for again.
                        const link = known !== undefined && new Date(known.expiresAt).getTime() > now ? known : undefined;
                        const target = items.find((entry) => entry.id === opened);
                        return (
                          <tr key={row.path} data-path={row.path}>
                            <td>
                              <code>{row.path}</code>
                            </td>
                            <td className="amount">{row.path === MANIFEST_PATH ? '' : size(row.bytes)}</td>
                            <td className="amount">{row.rows === undefined ? '' : size(row.rows)}</td>
                            <td>{row.sha256 === '' ? '' : <code>{row.sha256.slice(0, 16)}…</code>}</td>
                            <td>
                              {link !== undefined ? (
                                <a href={linkOf(link.url, import.meta.env.VITE_API_BASE_URL ?? '')} download>
                                  {t('sas.exit.file.download.link')}
                                </a>
                              ) : target !== undefined && isServable(target, new Date(now)) ? (
                                <button type="button" disabled={file.isPending} onClick={() => ask(target.id, row.path)}>
                                  {t('sas.exit.file.link.action')}
                                </button>
                              ) : null}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </>
              )}
            </div>
          )}
        </div>
      </StateBoundary>
    </>
  );
}

function ExportRow({ entry, day, size, onOpen, open }: { entry: ExportView; day: (value: string) => string; size: (value: number | string) => string; onOpen: () => void; open: boolean }) {
  const { t } = useTranslation();
  return (
    <tr data-export-id={entry.id} data-status={entry.status}>
      <td>
        {day(entry.requestedAt)}
        <br />
        <small className="sub">{entry.reason}</small>
      </td>
      <td>
        {scopeLabel(t, entry.scope)}
        {entry.encrypted ? <small className="sub"> · {t('sas.exit.export.encrypted')}</small> : null}
      </td>
      <td>
        <span className={toneClass(statusTone(entry.status))}>{statusLabel(t, entry.status)}</span>
        {entry.errorCode === undefined ? null : <small className="sub"> · {entry.errorCode}</small>}
      </td>
      <td>{entry.readyAt === undefined ? '—' : t('sas.exit.column.expires', { ready: day(entry.readyAt), expires: entry.expiresAt === undefined ? '—' : day(entry.expiresAt) })}</td>
      <td data-downloaded>{entry.fileCount === undefined ? '—' : t('sas.exit.column.downloaded', { done: downloadedOf(entry), bytes: size(entry.totalBytes ?? 0) })}</td>
      <td>
        {entry.status === 'Ready' || entry.status === 'Delivered' ? (
          <button type="button" aria-expanded={open} onClick={onOpen}>
            {open ? t('sas.exit.manifest.hide.action') : t('sas.exit.manifest.show.action')}
          </button>
        ) : null}
      </td>
    </tr>
  );
}

function LeavingSection({ canManage }: { canManage: boolean }) {
  const { t, locale } = useTranslation();
  const choice = useTenantChoice();
  const exit = useTenantExit(choice.chosen, true);
  const offboard = useOffboard();
  const archive = useArchive();
  const renew = useRenew();
  // The confirmation and the notice belong to the tenant they were opened for: choosing another tenant leaves them behind, so an action prepared for one never reaches another.
  const [action, setAction] = useState<{ what: Leaving; tenantId: string | undefined } | undefined>(undefined);
  const [finished, setFinished] = useState<{ what: Leaving; tenantId: string | undefined } | undefined>(undefined);
  const acting = action?.tenantId === choice.chosen ? action?.what : undefined;
  const done = finished?.tenantId === choice.chosen ? finished?.what : undefined;
  // Choosing another tenant drops the confirmation, what was typed with it and the notice, so that coming back to a tenant starts over.
  const pick = (tenantId: string): void => {
    setAction(undefined);
    setFinished(undefined);
    setReason('');
    choice.choose(tenantId);
  };
  const setActing = (what: Leaving | undefined): void => setAction(what === undefined ? undefined : { what, tenantId: choice.chosen });
  const setDone = (what: Leaving | undefined): void => setFinished(what === undefined ? undefined : { what, tenantId: choice.chosen });
  const [reason, setReason] = useState('');
  const [endDate, setEndDate] = useState('');
  const [days, setDays] = useState(String(DEFAULT_WINDOW_DAYS));
  const [invalid, setInvalid] = useState<ReadonlySet<'reason' | 'date' | 'days'>>(new Set());

  const state = useScreenState({ isLoading: exit.isLoading, error: exit.error, data: exit.data, isEmpty: () => false });
  const view = exit.data;
  const problem = offboard.isError ? describeProblem(offboard.error) : archive.isError ? describeProblem(archive.error) : renew.isError ? describeProblem(renew.error) : undefined;
  const day = (value: string): string => new Date(value).toLocaleString(locale, { timeZone: 'UTC' });

  const open = (what: Leaving): void => {
    offboard.reset();
    archive.reset();
    renew.reset();
    setDone(undefined);
    setInvalid(new Set());
    setReason('');
    setActing(what);
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (acting === undefined || view === undefined || choice.chosen === undefined || offboard.isPending || archive.isPending || renew.isPending || !canManage) return;
    const bad = new Set<'reason' | 'date' | 'days'>();
    if (!isReasonValid(reason)) bad.add('reason');
    if (acting === 'offboard' && !isDateValid(endDate)) bad.add('date');
    if (acting === 'offboard' && !isWindowValid(Number(days))) bad.add('days');
    if (bad.size > 0) {
      setInvalid(bad);
      return;
    }
    const finished = {
      onSuccess: () => {
        setDone(acting);
        setActing(undefined);
        setReason('');
      },
    };
    const base = { tenantId: choice.chosen, version: view.version, reason: reason.trim() };
    if (acting === 'offboard') offboard.mutate({ ...base, contractEndDate: endDate, windowDays: Number(days) }, finished);
    else if (acting === 'archive') archive.mutate(base, finished);
    else renew.mutate(base, finished);
  };

  return (
    <>
      <TenantPicker id="exit-tenant" label={t('sas.exit.tenant.label')} moreLabel={t('sas.exit.tenant.more.action')} choice={{ ...choice, choose: pick }} />
      <StateBoundary state={state} onRetry={() => void exit.refetch()}>
        {view === undefined ? null : (
          <div className="card" data-tenant-exit>
            <h2>{t('sas.exit.leaving.title')}</h2>
            {done === undefined ? null : (
              <p className="callout" role="status">
                {done === 'offboard' ? t('sas.exit.done.offboard') : done === 'archive' ? t('sas.exit.done.archive') : t('sas.exit.done.renew')}
              </p>
            )}
            {problem === undefined ? null : (
              <div className="callout warning" role="alert">
                <p>{problemMessage(t, problem)}</p>
              </div>
            )}
            <dl className="kv" data-window>
              <dt>{t('sas.exit.leaving.status')}</dt>
              <dd>{tenantStatusLabel(t, view.status)}</dd>
              <dt>{t('sas.exit.leaving.contractEnd')}</dt>
              <dd>{view.contractEndDate ?? '—'}</dd>
              <dt>{t('sas.exit.leaving.window')}</dt>
              <dd>{view.exportWindowEndsAt === undefined ? '—' : t('sas.exit.leaving.windowEnds', { days: view.exportWindowDays ?? 0, at: day(view.exportWindowEndsAt) })}</dd>
              <dt>{t('sas.exit.leaving.delivered')}</dt>
              <dd data-delivered>{view.exportDelivered ? t('sas.exit.leaving.yes') : t('sas.exit.leaving.no')}</dd>
              <dt>{t('sas.exit.leaving.holds')}</dt>
              <dd data-holds>{view.legalHoldsActive === 0 ? t('sas.exit.leaving.noHolds') : t('sas.exit.leaving.holdsActive', { count: view.legalHoldsActive })}</dd>
            </dl>
            {view.legalHoldsActive > 0 ? <p className="callout warning">{t('sas.exit.leaving.holdsRule')}</p> : null}
            {canManage ? (
              <div className="row gap">
                {canOffboard(view.status) ? (
                  <button type="button" onClick={() => open('offboard')}>
                    {t('sas.exit.offboard.action')}
                  </button>
                ) : null}
                {canArchive(view.status) ? (
                  <>
                    <button type="button" onClick={() => open('archive')}>
                      {t('sas.exit.archive.action')}
                    </button>
                    <button type="button" onClick={() => open('renew')}>
                      {t('sas.exit.renew.action')}
                    </button>
                  </>
                ) : null}
              </div>
            ) : null}
            {acting === undefined ? null : (
              <form onSubmit={submit} noValidate aria-label={t('sas.exit.act.aria')} className="billing-issue">
                <p className="callout">{acting === 'offboard' ? t('sas.exit.offboard.rule') : acting === 'archive' ? t('sas.exit.archive.rule') : t('sas.exit.renew.rule')}</p>
                {acting === 'offboard' ? (
                  <>
                    <div className="field">
                      <label htmlFor="exit-end">{t('sas.exit.offboard.end.label')}</label>
                      <input id="exit-end" type="date" value={endDate} aria-invalid={invalid.has('date')} onChange={(event) => setEndDate(event.target.value)} />
                      {invalid.has('date') ? (
                        <small role="alert" className="field-error">
                          {t('sas.exit.offboard.end.invalid')}
                        </small>
                      ) : null}
                    </div>
                    <div className="field">
                      <label htmlFor="exit-days">{t('sas.exit.offboard.days.label', { min: MIN_WINDOW_DAYS, max: MAX_WINDOW_DAYS })}</label>
                      <input id="exit-days" type="number" inputMode="numeric" value={days} aria-invalid={invalid.has('days')} onChange={(event) => setDays(event.target.value)} />
                      {invalid.has('days') ? (
                        <small role="alert" className="field-error">
                          {t('sas.exit.offboard.days.invalid', { min: MIN_WINDOW_DAYS, max: MAX_WINDOW_DAYS })}
                        </small>
                      ) : null}
                    </div>
                  </>
                ) : null}
                <div className="field">
                  <label htmlFor="exit-reason">{t('sas.exit.act.reason.label')}</label>
                  <textarea id="exit-reason" rows={2} maxLength={MAX_REASON} value={reason} aria-invalid={invalid.has('reason')} onChange={(event) => setReason(event.target.value)} />
                  {invalid.has('reason') ? (
                    <small role="alert" className="field-error">
                      {t('sas.exit.act.reason.tooShort')}
                    </small>
                  ) : null}
                </div>
                <div className="row gap">
                  <button type="submit" className="primary" disabled={offboard.isPending || archive.isPending || renew.isPending}>
                    {t('sas.exit.act.confirm.action')}
                  </button>
                  <button type="button" onClick={() => setActing(undefined)}>
                    {t('sas.exit.act.abort.action')}
                  </button>
                </div>
              </form>
            )}
            {view.items.length === 0 ? (
              <p className="sub" role="status">
                {t('sas.exit.leaving.noExports')}
              </p>
            ) : (
              <table className="table" data-tenant-exports>
                <thead>
                  <tr>
                    <th scope="col">{t('sas.exit.column.requested')}</th>
                    <th scope="col">{t('sas.exit.column.scope')}</th>
                    <th scope="col">{t('sas.exit.column.status')}</th>
                    <th scope="col">{t('sas.exit.column.ready')}</th>
                  </tr>
                </thead>
                <tbody>
                  {view.items.map((entry) => (
                    <tr key={entry.id} data-export-id={entry.id} data-status={entry.status}>
                      <td>{day(entry.requestedAt)}</td>
                      <td>{scopeLabel(t, entry.scope)}</td>
                      <td>
                        <span className={toneClass(statusTone(entry.status))}>{statusLabel(t, entry.status)}</span>
                      </td>
                      <td>{entry.deliveredAt !== undefined ? t('sas.exit.leaving.deliveredAt', { at: day(entry.deliveredAt) }) : entry.expiresAt === undefined ? '—' : t('sas.exit.leaving.expiresAt', { at: day(entry.expiresAt) })}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </StateBoundary>
    </>
  );
}
