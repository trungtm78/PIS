import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import { Field } from '../../ctr/components';
import { unchanged } from '../../unsent';
import { ContentFields } from '../diary/DiaryDialogs';
import { formProblemMessage } from '../diary/labels';
import { validateDiary } from '../diary/model';
import type { DiaryForm } from '../diary/model';
import '../qms.css';
import { placeProblemMessage } from './labels';
import { useLocate } from './locate';
import { newDraft, validatePlace, withConsent } from './model';
import type { Draft, Place } from './model';
import type { ContractOption, Persisted } from './store';

export interface ComposePanelProps {
  contracts: readonly ContractOption[];
  today: string;
  /** What the form starts from; a diary on the server is written over under the version that was read. */
  start: Draft;
  /** Keeps the diary on the device; 'failed' when the device could not, and then the diary is still in the form. */
  onQueue(draft: Draft, unchanged: () => boolean): Promise<Persisted>;
  onCancelEdit(): void;
}

/** The diary of a day written on this device: nothing leaves it until the send, and the place goes with it only if the person consents. */
export function ComposePanel({ contracts, today, start, onQueue, onCancelEdit }: ComposePanelProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<Draft>(start);
  const [submitted, setSubmitted] = useState(false);
  const [notKept, setNotKept] = useState(false);
  const [keeping, setKeeping] = useState(false);
  const latest = useRef(draft);
  useEffect(() => {
    latest.current = draft;
  });
  const editing = start.baseServerVersion !== null;
  const formProblems = validateDiary(draft.form, today, true);
  const placeProblems = validatePlace(draft.place);
  const setForm = (form: DiaryForm): void => setDraft({ ...draft, form });
  const { locating, locate } = useLocate(draft.place.consent, (fix) => setDraft((current) => (current.place.consent ? { ...current, place: { ...current.place, ...fix } } : current)));
  const setPlace = (place: Place): void => setDraft({ ...draft, place });
  const shown = (field: keyof DiaryForm): string | undefined => {
    const problem = formProblems[field];
    return submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined;
  };
  const placeShown = (field: 'consent' | 'lat' | 'lng' | 'accuracy'): string | undefined => {
    const problem = placeProblems[field];
    return submitted && problem !== undefined ? placeProblemMessage(t, problem) : undefined;
  };
  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setSubmitted(true);
    if (keeping || Object.keys(formProblems).length > 0 || Object.keys(placeProblems).length > 0) return;
    setKeeping(true);
    const stillSent = (): boolean => unchanged(latest.current, draft);
    const kept = (await onQueue(draft, stillSent)) === 'ok';
    setKeeping(false);
    setNotKept(!kept);
    if (!kept || !stillSent()) return;
    setDraft(newDraft(today));
    setSubmitted(false);
  };
  return (
    <form className="card" onSubmit={(event) => void save(event)} noValidate aria-label={t('qms.offline.compose.title')} data-testid="compose">
      <h2>{editing ? t('qms.offline.compose.editTitle') : t('qms.offline.compose.title')}</h2>
      <p className="sub">{t('qms.offline.compose.hint')}</p>
      {notKept ? (
        <p className="callout warning" role="alert" data-testid="not-kept">
          {t('qms.offline.compose.notKept')}
        </p>
      ) : null}
      <Field id="offline-contract" label={t('qms.diary.field.contract')} error={shown('contractId')}>
        <select id="offline-contract" value={draft.form.contractId} disabled={editing} onChange={(event) => setForm({ ...draft.form, contractId: event.target.value })}>
          <option value="">{t('qms.diary.field.contract.choose')}</option>
          {contracts.map((contract) => (
            <option key={contract.id} value={contract.id}>
              {contract.title === null ? contract.code : `${contract.code} · ${contract.title}`}
            </option>
          ))}
        </select>
      </Field>
      <Field id="offline-date" label={t('qms.diary.field.date')} error={shown('recordDate')}>
        <input id="offline-date" type="date" max={today} value={draft.form.recordDate} disabled={editing} onChange={(event) => setForm({ ...draft.form, recordDate: event.target.value })} />
      </Field>
      <ContentFields form={draft.form} set={(change) => setForm({ ...draft.form, ...change })} shown={shown} prefix="offline" />
      <fieldset className="qms-plain" aria-label={t('qms.offline.place.title')}>
        <legend>{t('qms.offline.place.title')}</legend>
        <label className="check">
          <input type="checkbox" checked={draft.place.consent} aria-invalid={placeShown('consent') !== undefined} onChange={(event) => setPlace(withConsent(draft.place, event.target.checked))} />
          {t('qms.offline.place.consent')}
        </label>
        <small className="sub">{t('qms.offline.place.hint')}</small>
        {placeShown('consent') === undefined ? null : (
          <small role="alert" className="field-error">
            {placeShown('consent')}
          </small>
        )}
        <p>
          <button type="button" disabled={!draft.place.consent || locating === 'busy'} onClick={locate}>
            {locating === 'busy' ? t('qms.offline.place.locating') : t('qms.offline.place.locate')}
          </button>
        </p>
        {locating === 'failed' ? (
          <p className="callout warning" role="status" data-testid="locate-failed">
            {t('qms.offline.place.unavailable')}
          </p>
        ) : null}
        <Field id="offline-lat" label={t('qms.offline.place.lat')} error={placeShown('lat')}>
          <input id="offline-lat" inputMode="decimal" value={draft.place.lat} disabled={!draft.place.consent} onChange={(event) => setPlace({ ...draft.place, lat: event.target.value })} />
        </Field>
        <Field id="offline-lng" label={t('qms.offline.place.lng')} error={placeShown('lng')}>
          <input id="offline-lng" inputMode="decimal" value={draft.place.lng} disabled={!draft.place.consent} onChange={(event) => setPlace({ ...draft.place, lng: event.target.value })} />
        </Field>
        <Field id="offline-accuracy" label={t('qms.offline.place.accuracy')} error={placeShown('accuracy')}>
          <input
            id="offline-accuracy"
            inputMode="decimal"
            value={draft.place.accuracy}
            disabled={!draft.place.consent}
            onChange={(event) => setPlace({ ...draft.place, accuracy: event.target.value })}
          />
        </Field>
      </fieldset>
      <div className="formfooter">
        {editing ? (
          <button type="button" onClick={onCancelEdit}>
            {t('qms.offline.compose.cancelEdit')}
          </button>
        ) : null}
        <button type="submit" className="primary" disabled={keeping}>
          {t('qms.offline.compose.submit')}
        </button>
      </div>
    </form>
  );
}
