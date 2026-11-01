import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { Field } from '../../ctr/components';
import { readBytes, sha256Hex } from '../../ctr/boq-model';
import type { ContractLine } from '../../ctr/model';
import { placeProblemMessage } from '../offline/labels';
import { useContractOptions } from '../offline/hooks';
import { useLocate } from '../offline/locate';
import '../qms.css';
import { DiaryChoice, Preflight, Registered } from './Parts';
import { useRegisterPhoto } from './hooks';
import { formProblemMessage, problemMessage } from './labels';
import {
  CONTRACT_PERMISSION,
  DIARY_PERMISSION,
  EMPTY_FORM,
  NO_PLACE,
  READ_PERMISSION,
  UPLOAD_PERMISSION,
  captureBody,
  describeProblem,
  hasProblems,
  holds,
  validateCapture,
  withConsent,
} from './model';
import type { CaptureField, CaptureForm, ChosenFile, Place } from './model';

/**
 * QMS-10: a site photo registered with its contract, its caption and, only if the person consents, the place it was taken (ST-QMS-003, QMS 3.4, BR-QMS-06). The flags that can be known before the send are shown first; the
 * flags of time, zone, repetition and EXIF are given by the server when the photo is registered and shown right after, as aids for a reviewer and never as a verdict. The screen keeps nothing of the place: it is sent with the
 * photo or dropped, and withdrawing the consent drops it at once (UAT-AC367). The file itself is uploaded by the phone or by the upload pipeline of the tenant, which gives the reference registered here.
 */
export default function PhotoCaptureScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The form and the place belong to one membership: a switch of tenant or of membership starts the screen over.
  return <CaptureContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function CaptureContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const frozen = mode === 'READ_ONLY';
  const mayUpload = holds(permissions, UPLOAD_PERMISSION);
  const mayChoose = holds(permissions, CONTRACT_PERMISSION);
  const contracts = useContractOptions(mayUpload && mayChoose && !frozen);
  const register = useRegisterPhoto();
  const [form, setDraft] = useState<CaptureForm>(EMPTY_FORM);
  const [file, setFile] = useState<ChosenFile | undefined>(undefined);
  const [place, setPlaceDraft] = useState<Place>(NO_PLACE);
  const [submitted, setSubmitted] = useState(false);
  const [reading, setReading] = useState(false);
  // The latest choice of a file: a read that finishes after a newer choice, or after the screen is left, is dropped.
  const choice = useRef(0);
  useEffect(
    () => () => {
      choice.current += 1;
    },
    [],
  );
  const [registeredId, setRegisteredId] = useState<string | undefined>(undefined);
  // One photo, one identifier: a retry of this photo is this photo, and a photo changed after a send whose answer was lost is another operation.
  const [operation, setOperation] = useState(() => globalThis.crypto.randomUUID());
  const current = useRef(operation);
  const renew = (): void => {
    current.current = globalThis.crypto.randomUUID();
    setOperation(current.current);
  };
  const options: readonly ContractLine[] = contracts.data ?? [];
  const contract = options.find((candidate) => candidate.id === form.contractId);
  const problems = validateCapture(form, file, place);
  const state = useScreenState({
    isLoading: mayUpload && mayChoose && !frozen && contracts.isLoading,
    error: mayUpload && mayChoose ? contracts.error : undefined,
    data: mayUpload && mayChoose && !frozen ? contracts.data : undefined,
    isEmpty: (data) => (data as ContractLine[]).length === 0,
  });
  const canRead = holds(permissions, READ_PERMISSION);

  const changed = (): void => {
    renew();
    if (register.isError) register.reset();
  };
  const setForm = (next: Partial<CaptureForm>): void => {
    setDraft((current) => ({ ...current, ...next }));
    changed();
  };
  const setPlace = (next: Place): void => {
    setPlaceDraft(next);
    changed();
  };
  const { locating, locate } = useLocate(place.consent, (fix) => {
    setPlaceDraft((current) => (current.consent ? { ...current, ...fix } : current));
    changed();
  });
  const shown = (field: CaptureField): string | undefined => {
    const problem = problems.form[field];
    return submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined;
  };
  const placeShown = (field: 'lat' | 'lng' | 'accuracy'): string | undefined => {
    const problem = problems.place[field];
    return submitted && problem !== undefined ? placeProblemMessage(t, problem) : undefined;
  };

  const choose = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const picked = event.target.files?.[0];
    changed();
    choice.current += 1;
    const mine = choice.current;
    if (picked === undefined) {
      setFile(undefined);
      setReading(false);
      return;
    }
    setReading(true);
    try {
      const sha256 = await sha256Hex(await readBytes(picked));
      if (mine === choice.current) setFile({ name: picked.name, type: picked.type, size: picked.size, sha256 });
    } catch {
      if (mine === choice.current) setFile(undefined);
    } finally {
      if (mine === choice.current) setReading(false);
    }
  };

  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (register.isPending || reading || file === undefined || contract === undefined || hasProblems(problems)) return;
    register.mutate(captureBody(form, contract, file, place, operation), {
      onSuccess: (id) => {
        setRegisteredId(id ?? '');
        // The form is cleared only if it still holds the photo that was sent: what the person changed while the request was in flight is another photo, and it is kept.
        if (current.current !== operation) return;
        setDraft(EMPTY_FORM);
        setFile(undefined);
        setPlaceDraft(NO_PLACE);
        setSubmitted(false);
        renew();
      },
    });
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('qms.capture.page.title')}</h1>
          <p>{t('qms.capture.page.subtitle')}</p>
        </div>
      </div>
      {frozen ? (
        <p className="callout warning" role="status" data-testid="frozen">
          {t('qms.capture.frozen.notice')}
        </p>
      ) : (
        <StateBoundary state={mayUpload && mayChoose ? state : 'denied'} onRetry={() => void contracts.refetch()}>
          <form className="card" onSubmit={send} noValidate aria-label={t('qms.capture.form.title')} data-testid="capture">
            <h2>{t('qms.capture.form.title')}</h2>
            {register.isError ? (
              <p className="callout warning" role="alert" data-testid="refusal">
                {problemMessage(t, describeProblem(register.error))}
              </p>
            ) : null}
            <Field id="capture-file" label={t('qms.capture.field.file')} error={shown('file')} hint={t('qms.capture.field.file.hint')}>
              <input id="capture-file" type="file" accept="image/jpeg,image/png" capture="environment" onChange={(event) => void choose(event)} />
            </Field>
            {file === undefined ? null : (
              <p className="sub" data-testid="file-facts">
                {t('qms.capture.file.facts', { name: file.name, size: file.size, hash: file.sha256.slice(0, 12) })}
              </p>
            )}
            <Field id="capture-contract" label={t('qms.capture.field.contract')} error={shown('contractId')}>
              <select id="capture-contract" value={form.contractId} onChange={(event) => setForm({ contractId: event.target.value, siteDiaryId: '' })}>
                <option value="">{t('qms.capture.field.contract.choose')}</option>
                {options.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.title === null ? candidate.code : `${candidate.code} · ${candidate.title}`}
                  </option>
                ))}
              </select>
            </Field>
            {form.contractId !== '' && holds(permissions, DIARY_PERMISSION) ? (
              <DiaryChoice contractId={form.contractId} value={form.siteDiaryId} error={shown('siteDiaryId')} onChange={(id) => setForm({ siteDiaryId: id })} />
            ) : null}
            <Field id="capture-caption" label={t('qms.capture.field.caption')} error={shown('caption')}>
              <textarea id="capture-caption" rows={2} value={form.caption} onChange={(event) => setForm({ caption: event.target.value })} />
            </Field>
            <Field id="capture-key" label={t('qms.capture.field.key')} error={shown('objectKey')} hint={t('qms.capture.field.key.hint')}>
              <input id="capture-key" autoComplete="off" value={form.objectKey} onChange={(event) => setForm({ objectKey: event.target.value })} />
            </Field>
            <fieldset className="qms-plain" aria-label={t('qms.capture.place.title')}>
              <legend>{t('qms.capture.place.title')}</legend>
              <label className="check">
                <input type="checkbox" checked={place.consent} onChange={(event) => setPlace(withConsent(place, event.target.checked))} />
                {t('qms.capture.place.consent')}
              </label>
              <small className="sub">{t('qms.capture.place.hint')}</small>
              <p>
                <button type="button" disabled={!place.consent || locating === 'busy'} onClick={locate}>
                  {locating === 'busy' ? t('qms.capture.place.locating') : t('qms.capture.place.locate')}
                </button>
              </p>
              {locating === 'failed' ? (
                <p className="callout warning" role="status" data-testid="locate-failed">
                  {t('qms.capture.place.unavailable')}
                </p>
              ) : null}
              <Field id="capture-lat" label={t('qms.capture.place.lat')} error={placeShown('lat')}>
                <input id="capture-lat" inputMode="decimal" value={place.lat} disabled={!place.consent} onChange={(event) => setPlace({ ...place, lat: event.target.value })} />
              </Field>
              <Field id="capture-lng" label={t('qms.capture.place.lng')} error={placeShown('lng')}>
                <input id="capture-lng" inputMode="decimal" value={place.lng} disabled={!place.consent} onChange={(event) => setPlace({ ...place, lng: event.target.value })} />
              </Field>
              <Field id="capture-accuracy" label={t('qms.capture.place.accuracy')} error={placeShown('accuracy')}>
                <input id="capture-accuracy" inputMode="decimal" value={place.accuracy} disabled={!place.consent} onChange={(event) => setPlace({ ...place, accuracy: event.target.value })} />
              </Field>
            </fieldset>
            <Preflight contractId={form.contractId} sha256={file?.sha256} place={place} canRead={canRead} />
            <div className="formfooter">
              <button type="submit" className="primary" disabled={register.isPending || reading}>
                {register.isPending ? t('qms.capture.submit.pending') : t('qms.capture.submit.action')}
              </button>
            </div>
          </form>
        </StateBoundary>
      )}
      {registeredId === undefined ? null : <Registered id={registeredId} canRead={canRead && registeredId !== ''} />}
      <p className="prototype-note">{t('qms.capture.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
