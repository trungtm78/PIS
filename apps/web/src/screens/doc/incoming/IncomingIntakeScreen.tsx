import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { Field } from '../../ctr/components';
import { useRegisters } from '../registers/hooks';
import { useReceiveLetter, useUploadLetter } from './hooks';
import type { UploadedFile } from './hooks';
import { channelLabel, formProblemMessage, problemMessage, urgencyLabel } from './labels';
import { CHANNELS, RECEIVE_PERMISSION, UPLOAD_PERMISSION, URGENCIES, canAct, describeProblem, duplicateOf, emptyReceive, handlingLink, holds, ledgerLink, receiveBody, validateReceive, vietnamToday } from './model';
import type { Problem, ReceiveForm } from './model';
import './incoming.css';

/**
 * DOC-11: a letter comes in (ST-DOC-011, DOC.md F10). The clerk chooses the PDF, says what it is (type, channel, sender, the symbol and the day written on it) and takes it in. A letter that looks like one already there is
 * refused with a link to the one it looks like, and is taken in only with the reason why; one that declares a level of state secret is not taken in at all. The server judges the file and every field again.
 */
export default function IncomingIntakeScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The file and the form belong to one membership: a switch of tenant or of membership starts the screen over.
  return <IntakeContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

interface Taken {
  id: string;
}

function IntakeContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const [form, setForm] = useState<ReceiveForm>(emptyReceive);
  const [file, setFile] = useState<File | undefined>(undefined);
  const [submitted, setSubmitted] = useState(false);
  // A new key remounts the file input, which is the only way to empty it.
  const [fileInput, setFileInput] = useState(0);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const [copyOf, setCopyOf] = useState<string | undefined>(undefined);
  const [taken, setTaken] = useState<Taken | undefined>(undefined);
  // The stored file of this intake: a retry after a lost answer sends the same key and hash, so that the server replays the letter instead of making a second one.
  const [stored, setStored] = useState<{ file: File; uploaded: UploadedFile } | undefined>(undefined);
  const upload = useUploadLetter();
  const receive = useReceiveLetter();
  const registers = useRegisters({ year: '', direction: 'INCOMING' });
  const docTypes = useMemo(() => [...new Set((registers.data?.pages[0]?.docTypes ?? []).map((type) => type.code))], [registers.data]);
  const typedType = !registers.isLoading && docTypes.length === 0;
  const today = vietnamToday();
  const problems = validateReceive(form, file === undefined ? undefined : { name: file.name, type: file.type, size: file.size }, today);
  const writable = canAct(mode) && holds(permissions, RECEIVE_PERMISSION) && holds(permissions, UPLOAD_PERMISSION);
  const busy = upload.isPending || receive.isPending;
  const shown = (field: keyof typeof problems): string | undefined => {
    const found = problems[field];
    return submitted && found !== undefined ? formProblemMessage(t, found) : undefined;
  };
  const change = (patch: Partial<ReceiveForm>): void => {
    setForm({ ...form, ...patch });
    setProblem(undefined);
  };

  const send = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setSubmitted(true);
    if (busy || Object.keys(problems).length > 0 || file === undefined) return;
    setProblem(undefined);
    setCopyOf(undefined);
    try {
      // The file goes through the pipeline of uploads first (judged by its bytes, scanned); the letter is taken in with the key and the hash that come back.
      const uploaded = stored?.file === file ? stored.uploaded : await upload.mutateAsync(file);
      if (uploaded === undefined) {
        setProblem('general');
        return;
      }
      setStored({ file, uploaded });
      const answer = await receive.mutateAsync(receiveBody(form, uploaded));
      setTaken({ id: String(answer.resource_id ?? '') });
      // The letter is in: the form starts over, so that a second click cannot take the same letter in again under a new key.
      setForm(emptyReceive());
      setFile(undefined);
      setStored(undefined);
      setSubmitted(false);
      setFileInput(fileInput + 1);
    } catch (error) {
      setProblem(describeProblem(error));
      setCopyOf(duplicateOf(error));
    }
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('doc.incoming.intake.title')}</h1>
          <p>{t('doc.incoming.intake.subtitle')}</p>
        </div>
        <div className="actions">
          <Link className="button" to={ledgerLink()}>
            {t('doc.incoming.ledger.link')}
          </Link>
        </div>
      </div>
      {taken === undefined ? null : (
        <p className="callout" role="status" data-testid="taken">
          {t('doc.incoming.intake.taken')}{' '}
          {taken.id === '' ? null : (
            <Link to={handlingLink(taken.id)} data-testid="taken-link">
              {t('doc.incoming.intake.open')}
            </Link>
          )}
        </p>
      )}
      {writable ? null : (
        <p className="callout warning" role="status" data-testid="read-only">
          {t('doc.incoming.intake.readOnly')}
        </p>
      )}
      <form className="card" onSubmit={(event) => void send(event)} noValidate aria-label={t('doc.incoming.intake.form')}>
        {problem === undefined ? null : (
          <p className="callout warning" role="alert" data-testid="refusal">
            {problemMessage(t, problem)}
            {copyOf === undefined ? null : (
              <>
                {' '}
                <Link to={handlingLink(copyOf)} data-testid="duplicate-link">
                  {t('doc.incoming.intake.duplicateOf')}
                </Link>
              </>
            )}
          </p>
        )}
        <fieldset className="incoming-fields" disabled={!writable || busy}>
          <Field id="incoming-file" label={t('doc.incoming.field.file')} error={shown('file')} hint={t('doc.incoming.field.file.hint')}>
            <input key={fileInput} id="incoming-file" type="file" accept="application/pdf,.pdf" onChange={(event) => setFile(event.target.files?.[0])} />
          </Field>
          <Field id="incoming-title" label={t('doc.incoming.field.title')} error={shown('title')}>
            <input id="incoming-title" autoComplete="off" value={form.title} onChange={(event) => change({ title: event.target.value })} />
          </Field>
          <Field id="incoming-type" label={t('doc.incoming.field.docType')} error={shown('docTypeCode')} hint={typedType ? t('doc.incoming.field.docType.typed') : undefined}>
            {typedType ? (
              <input id="incoming-type" autoComplete="off" value={form.docTypeCode} onChange={(event) => change({ docTypeCode: event.target.value.trim().toUpperCase() })} />
            ) : (
              <select id="incoming-type" value={form.docTypeCode} onChange={(event) => change({ docTypeCode: event.target.value })}>
                <option value="">{t('doc.incoming.field.docType.choose')}</option>
                {docTypes.map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field id="incoming-channel" label={t('doc.incoming.field.channel')} error={shown('channel')}>
            <select id="incoming-channel" value={form.channel} onChange={(event) => change({ channel: CHANNELS.find((channel) => channel === event.target.value) ?? '' })}>
              {CHANNELS.map((channel) => (
                <option key={channel} value={channel}>
                  {channelLabel(t, channel)}
                </option>
              ))}
            </select>
          </Field>
          <Field id="incoming-sender" label={t('doc.incoming.field.sender')} error={shown('senderName')}>
            <input id="incoming-sender" autoComplete="off" value={form.senderName} onChange={(event) => change({ senderName: event.target.value })} />
          </Field>
          <Field id="incoming-symbol" label={t('doc.incoming.field.symbol')} error={shown('originalSymbol')}>
            <input id="incoming-symbol" autoComplete="off" value={form.originalSymbol} onChange={(event) => change({ originalSymbol: event.target.value })} />
          </Field>
          <Field id="incoming-issued" label={t('doc.incoming.field.issuedOn')} error={shown('originalIssuedOn')}>
            <input id="incoming-issued" type="date" max={today} value={form.originalIssuedOn} onChange={(event) => change({ originalIssuedOn: event.target.value })} />
          </Field>
          <Field id="incoming-urgency" label={t('doc.incoming.field.urgency')} error={undefined}>
            <select id="incoming-urgency" value={form.urgency} onChange={(event) => change({ urgency: URGENCIES.find((urgency) => urgency === event.target.value) ?? 'NORMAL' })}>
              {URGENCIES.map((urgency) => (
                <option key={urgency} value={urgency}>
                  {urgencyLabel(t, urgency)}
                </option>
              ))}
            </select>
          </Field>
          {problem === 'duplicate' || form.duplicateReason !== '' ? (
            <Field id="incoming-reason" label={t('doc.incoming.field.duplicateReason')} error={shown('duplicateReason')} hint={t('doc.incoming.field.duplicateReason.hint')}>
              <textarea id="incoming-reason" rows={2} value={form.duplicateReason} onChange={(event) => change({ duplicateReason: event.target.value })} />
            </Field>
          ) : null}
        </fieldset>
        <div className="formfooter">
          <button type="submit" className="primary" disabled={!writable || busy}>
            {busy ? t('doc.incoming.intake.pending') : t('doc.incoming.intake.submit')}
          </button>
        </div>
      </form>
      <p className="prototype-note">{t('doc.incoming.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
