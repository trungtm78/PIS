import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { listItems, useDraftList } from './drafts/hooks';
import { fieldProblemMessage, statusLabel } from './drafts/labels';
import type { FieldProblem } from './drafts/rules';
import { useRegisters, useUnitOptions } from './registers/hooks';
import { useAttachSigned, useRegisterExternal, useUploadDocumentFile } from './signed/hooks';
import { chainLabel, fileProblemMessage, findingLabel, overallLabel, overallMark, problemMessage, roleLabel } from './signed/labels';
import { describeProblem } from './signed/problems';
import type { SignedProblem } from './signed/problems';
import { EMPTY_REGISTRATION, attachable, fileProblem, registersFor, registrationBody, registrationProblems } from './signed/rules';
import type { RegistrationForm } from './signed/rules';
import { REGISTER_EXTERNAL_PERMISSION, UPLOAD_FILE_PERMISSION, UPLOAD_SIGNED_PERMISSION } from './signed/types';
import type { AttachResult, FileCheck, Mode } from './signed/types';
import './drafts/drafts.css';
import './signed/signed.css';

const BACK_PATH = '/doc/doc-08';
const NUMBERING_PATH = '/doc/doc-06';
const LIST_PATH = '/doc/doc-03';
const SHORT_ID = 8;
const shortId = (id: string | null): string => (id === null || id === '' ? '' : id.slice(-SHORT_ID));

/** DOC-09: a document signed outside the system comes in as a file; what its signatures hold is shown before anything is attached to a document. */
export default function SignedUploadScreen({ route }: ScreenProps) {
  const tenantId = useSession().tenant?.id;
  // The file, its verdict and the form belong to one tenant: a switch starts the screen over.
  return <SignedUploadContent key={tenantId ?? 'none'} route={route} />;
}

function SignedUploadContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode: sessionMode } = useSession();
  // A suspended tenant (READ_ONLY mode) is read-only for everyone, whatever the grants say.
  const frozen = sessionMode === 'READ_ONLY';
  const holds = (permission: string): boolean => (permissions === undefined || permissions.includes(permission)) && !frozen;
  const [mode, setMode] = useState<Mode>('LEADER');
  const canUpload = holds(UPLOAD_FILE_PERMISSION);
  const canAttach = holds(mode === 'LEADER' ? UPLOAD_SIGNED_PERMISSION : REGISTER_EXTERNAL_PERMISSION);

  const [file, setFile] = useState<File | undefined>(undefined);
  const [fileRefused, setFileRefused] = useState(false);
  const [check, setCheck] = useState<FileCheck | undefined>(undefined);
  const [documentId, setDocumentId] = useState('');
  const [form, setForm] = useState<RegistrationForm>(EMPTY_REGISTRATION);
  const [refused, setRefused] = useState<FieldProblem[]>([]);
  const [problem, setProblem] = useState<SignedProblem | undefined>(undefined);
  const [done, setDone] = useState<(AttachResult & { mode: Mode }) | undefined>(undefined);

  const upload = useUploadDocumentFile();
  const attach = useAttachSigned();
  const register = useRegisterExternal();
  const waiting = useDraftList({ status: 'SUBMITTED', docTypeCode: '', year: '' });
  const queue = useMemo(() => listItems(waiting.data), [waiting.data]);
  const registers = useRegisters({ year: '', direction: 'OUTGOING' });
  const units = useUnitOptions();
  const busy = upload.isPending || attach.isPending || register.isPending;

  const firstPage = registers.data?.pages[0];
  const docTypes = useMemo(() => [...new Set((firstPage?.docTypes ?? []).map((type) => type.code))], [firstPage]);
  const allRegisters = useMemo(() => (registers.data?.pages ?? []).flatMap((page) => page.items), [registers.data]);
  const openRegisters = useMemo(() => registersFor(allRegisters, form), [allRegisters, form]);
  const chosen = queue.find((row) => row.id === documentId);
  const fileError = fileRefused ? fileProblem(file) : undefined;

  const change = (patch: Partial<RegistrationForm>): void => {
    setForm({ ...form, ...patch });
    setRefused([]);
  };

  const choose = (next: File | undefined): void => {
    setFile(next);
    setCheck(undefined);
    setFileRefused(false);
    setProblem(undefined);
    setDone(undefined);
  };

  const switchMode = (next: Mode): void => {
    setMode(next);
    setProblem(undefined);
    setDone(undefined);
    setRefused([]);
  };

  const read = (): void => {
    if (!canUpload || busy) return;
    if (file === undefined || fileProblem(file) !== undefined) {
      setFileRefused(true);
      return;
    }
    setProblem(undefined);
    setDone(undefined);
    upload.mutate(file, { onSuccess: (result) => setCheck(result), onError: (error) => setProblem(describeProblem(error)) });
  };

  const onDone = (result: AttachResult): void => setDone({ ...result, mode });
  const onError = (error: unknown): void => setProblem(describeProblem(error));

  const attachLeader = (): void => {
    if (!canAttach || busy || check === undefined || chosen === undefined || !attachable(check)) return;
    setProblem(undefined);
    attach.mutate({ documentId: chosen.id, version: chosen.version, fileObjectKey: check.fileObjectKey, fileSha256: check.fileSha256 }, { onSuccess: onDone, onError });
  };

  const registerExternal = (event: FormEvent): void => {
    event.preventDefault();
    if (!canAttach || busy || check === undefined || !attachable(check)) return;
    const problems = registrationProblems(form);
    setRefused(problems);
    if (problems.length > 0) return;
    setProblem(undefined);
    register.mutate(registrationBody(form, check), { onSuccess: onDone, onError });
  };

  const fieldError = (name: string) => {
    const found = refused.find((entry) => entry.field === name);
    return found === undefined ? null : (
      <small role="alert" className="field-error">
        {fieldProblemMessage(t, found)}
      </small>
    );
  };
  const mark = (name: string): { 'aria-invalid': boolean } => ({ 'aria-invalid': refused.some((entry) => entry.field === name) });

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title" className="doc-drafts doc-signed">
      <p className="back-link">
        <Link to={BACK_PATH}>
          <span aria-hidden="true">← </span>
          {t('doc.signed.back.link')}
        </Link>
      </p>
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('doc.signed.page.title')}</h1>
          <p>{t('doc.signed.page.subtitle')}</p>
        </div>
      </div>
      {frozen ? (
        <p className="callout warning" role="status">
          {t('doc.signed.frozen.notice')}
        </p>
      ) : !canUpload ? (
        <p className="callout warning" role="status" data-readonly="true">
          {t('doc.signed.denied.notice')}
        </p>
      ) : null}
      <>
        <div className="card">
          <fieldset className="mode-choice">
            <legend>{t('doc.signed.mode.title')}</legend>
            <div className="check">
              <input id="signed-mode-leader" type="radio" name="signed-mode" checked={mode === 'LEADER'} onChange={() => switchMode('LEADER')} />
              <label htmlFor="signed-mode-leader">{t('doc.signed.mode.leader.label')}</label>
            </div>
            <div className="check">
              <input id="signed-mode-external" type="radio" name="signed-mode" checked={mode === 'EXTERNAL'} onChange={() => switchMode('EXTERNAL')} />
              <label htmlFor="signed-mode-external">{t('doc.signed.mode.external.label')}</label>
            </div>
          </fieldset>
          <h2>{t('doc.signed.file.title')}</h2>
          <fieldset disabled={!canUpload || busy} className="plain">
            <div className="field">
              <label htmlFor="signed-file">{t('doc.signed.file.label')}</label>
              <input id="signed-file" type="file" accept="application/pdf,.pdf" aria-invalid={fileError !== undefined} onChange={(event) => choose(event.target.files?.[0])} />
              {fileError === undefined ? null : (
                <small role="alert" className="field-error">
                  {fileProblemMessage(t, fileError)}
                </small>
              )}
              <small className="muted">{t('doc.signed.file.hint')}</small>
            </div>
            <button type="button" className="primary" onClick={read} disabled={file === undefined || upload.isPending}>
              {upload.isPending ? t('doc.signed.file.reading.text') : t('doc.signed.file.read.action')}
            </button>
          </fieldset>
          {check === undefined ? null : (
            <div className="verdict" data-testid="verdict" data-overall={check.overall}>
              <h3>{t('doc.signed.result.title')}</h3>
              <p className={check.overall === 'VALID' ? 'callout' : 'callout warning'} role="status">
                <span aria-hidden="true">{overallMark(check.overall)} </span>
                {overallLabel(t, check.overall)}
              </p>
              <dl className="facts">
                <div>
                  <dt>{t('doc.signed.result.sha')}</dt>
                  <dd className="hash" data-sha={check.fileSha256}>
                    {check.fileSha256}
                  </dd>
                </div>
                <div>
                  <dt>{t('doc.signed.result.pages')}</dt>
                  <dd>{check.pageCount}</dd>
                </div>
                <div>
                  <dt>{t('doc.signed.result.size')}</dt>
                  <dd>{t('doc.signed.result.sizeValue', { kb: Math.max(1, Math.round(check.sizeBytes / 1024)) })}</dd>
                </div>
              </dl>
              {check.signatures.length === 0 ? (
                <p className="muted" data-unsigned="true">
                  {t('doc.signed.result.none')}
                </p>
              ) : (
                <table className="table" aria-label={t('doc.signed.result.title')}>
                  <thead>
                    <tr>
                      <th scope="col">{t('doc.signed.sig.role')}</th>
                      <th scope="col">{t('doc.signed.sig.status')}</th>
                      <th scope="col">{t('doc.signed.sig.chain')}</th>
                      <th scope="col">{t('doc.signed.sig.signedAt')}</th>
                      <th scope="col">{t('doc.signed.sig.time')}</th>
                      <th scope="col">{t('doc.signed.sig.findings')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {check.signatures.map((signature, index) => (
                      <tr key={`${signature.role}:${index}`} data-role={signature.role} data-status={signature.status}>
                        <td>{roleLabel(t, signature.role)}</td>
                        <td>
                          <span aria-hidden="true">{overallMark(signature.status)} </span>
                          {overallLabel(t, signature.status)}
                        </td>
                        <td>{chainLabel(t, signature.chainStatus)}</td>
                        <td>{signature.signedAt === null ? '—' : signature.signedAt.slice(0, 16).replace('T', ' ')}</td>
                        <td>{signature.timestampProven ? t('doc.signed.time.proven') : t('doc.signed.time.unproven')}</td>
                        <td>
                          {signature.findings.length === 0 ? (
                            '—'
                          ) : (
                            <ul>
                              {signature.findings.map((finding) => (
                                <li key={finding}>{findingLabel(t, finding)}</li>
                              ))}
                            </ul>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {attachable(check) ? null : (
                <p className="callout warning" role="status" data-blocked="true">
                  {t('doc.signed.result.blocked')}
                </p>
              )}
            </div>
          )}
        </div>
        {mode === 'LEADER' ? (
          <div className="card" data-mode="LEADER">
            <h2>{t('doc.signed.leader.title')}</h2>
            <fieldset disabled={!canAttach || busy || check === undefined} className="plain">
              <div className="field">
                <label htmlFor="signed-document">{t('doc.signed.leader.document.label')}</label>
                <select id="signed-document" value={documentId} onChange={(event) => setDocumentId(event.target.value)}>
                  <option value="">{t('doc.signed.select.placeholder')}</option>
                  {queue.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.title} · {row.docTypeCode} · {statusLabel(t, row.status)} · {shortId(row.signerUserId)}
                    </option>
                  ))}
                </select>
                {waiting.isError ? (
                  <small role="alert" className="field-error" data-problem="queue">
                    {problemMessage(t, describeProblem(waiting.error))}
                  </small>
                ) : waiting.isLoading ? (
                  <small className="muted" role="status">
                    {t('doc.signed.leader.loading.text')}
                  </small>
                ) : queue.length === 0 ? (
                  <small className="muted">{t('doc.signed.leader.none.text')}</small>
                ) : null}
              </div>
              <button type="button" className="primary" onClick={attachLeader} disabled={chosen === undefined || !attachable(check)}>
                {t('doc.signed.leader.attach.action')}
              </button>
            </fieldset>
          </div>
        ) : (
          <form className="card editor-form" data-mode="EXTERNAL" onSubmit={registerExternal} noValidate aria-label={t('doc.signed.external.title')}>
            <h2>{t('doc.signed.external.title')}</h2>
            <fieldset disabled={!canAttach || busy || check === undefined}>
              <div className="formgrid">
                <div className="field">
                  <label htmlFor="signed-type">{t('doc.signed.external.type.label')}</label>
                  <select id="signed-type" value={form.docTypeCode} {...mark('docTypeCode')} onChange={(event) => change({ docTypeCode: event.target.value, registerId: '' })}>
                    <option value="">{t('doc.signed.select.placeholder')}</option>
                    {docTypes.map((code) => (
                      <option key={code} value={code}>
                        {code}
                      </option>
                    ))}
                  </select>
                  {fieldError('docTypeCode')}
                </div>
                <div className="field wide">
                  <label htmlFor="signed-title">{t('doc.signed.external.title.label')}</label>
                  <input id="signed-title" value={form.title} {...mark('title')} onChange={(event) => change({ title: event.target.value })} />
                  {fieldError('title')}
                </div>
                <div className="field">
                  <label htmlFor="signed-unit">{t('doc.signed.external.unit.label')}</label>
                  <select id="signed-unit" value={form.unitId} {...mark('unitId')} onChange={(event) => change({ unitId: event.target.value })}>
                    <option value="">{t('doc.signed.select.placeholder')}</option>
                    {(units.data ?? []).map((unit) => (
                      <option key={unit.id} value={unit.id}>
                        {unit.code} · {unit.name}
                      </option>
                    ))}
                  </select>
                  {fieldError('unitId')}
                </div>
                <div className="field">
                  <label htmlFor="signed-issued">{t('doc.signed.external.issuedOn.label')}</label>
                  <input id="signed-issued" type="date" value={form.issuedOn} {...mark('issuedOn')} onChange={(event) => change({ issuedOn: event.target.value, registerId: '' })} />
                  {fieldError('issuedOn')}
                </div>
                <div className="field">
                  <label htmlFor="signed-register">{t('doc.signed.external.register.label')}</label>
                  <select id="signed-register" value={form.registerId} {...mark('registerId')} onChange={(event) => change({ registerId: event.target.value })}>
                    <option value="">{t('doc.signed.select.placeholder')}</option>
                    {openRegisters.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.registerCode} · {entry.year} · {entry.mode === 'MANAGED' ? t('doc.signed.external.register.managed', { next: entry.nextNumber }) : t('doc.signed.external.register.mirrored')}
                      </option>
                    ))}
                  </select>
                  {fieldError('registerId')}
                  {openRegisters.length === 0 ? <small className="muted">{t('doc.signed.external.register.none')}</small> : null}
                </div>
                <div className="field">
                  <label htmlFor="signed-number">{t('doc.signed.external.number.label')}</label>
                  <input id="signed-number" inputMode="numeric" value={form.number} {...mark('number')} onChange={(event) => change({ number: event.target.value })} />
                  {fieldError('number')}
                </div>
                <div className="field">
                  <label htmlFor="signed-symbol">{t('doc.signed.external.symbol.label')}</label>
                  <input id="signed-symbol" value={form.symbol} spellCheck={false} {...mark('symbol')} onChange={(event) => change({ symbol: event.target.value })} />
                  {fieldError('symbol')}
                </div>
                <div className="field wide">
                  <label htmlFor="signed-recipients">{t('doc.signed.external.recipients.label')}</label>
                  <textarea id="signed-recipients" value={form.recipients} {...mark('recipients')} onChange={(event) => change({ recipients: event.target.value })} />
                  {fieldError('recipients')}
                  <small className="muted">{t('doc.signed.external.recipients.hint')}</small>
                </div>
              </div>
              <button type="submit" className="primary" disabled={!attachable(check)}>
                {t('doc.signed.external.register.action')}
              </button>
            </fieldset>
          </form>
        )}
        {problem === undefined ? null : (
          <div className="callout warning" role="alert" data-problem={problem.reason}>
            <p>{problemMessage(t, problem)}</p>
            {problem.findings.length === 0 ? null : (
              <ul>
                {problem.findings.map((finding) => (
                  <li key={finding}>{findingLabel(t, finding)}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        {done === undefined ? null : (
          <p className="callout" role="status" data-done={done.mode}>
            {done.mode === 'LEADER' ? t('doc.signed.done.leader') : t('doc.signed.done.external', { symbol: done.symbol ?? '' })}{' '}
            {done.mode === 'LEADER' ? <Link to={`${NUMBERING_PATH}?doc=${done.id}`}>{t('doc.signed.done.leader.next')}</Link> : <Link to={LIST_PATH}>{t('doc.signed.done.external.next')}</Link>}
          </p>
        )}
      </>
      <p className="prototype-note">{t('doc.signed.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
