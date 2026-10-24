import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { usePreferences, useSavePreferences } from './preferences/hooks';
import { categoryName, channelName, digestName, problemMessage } from './preferences/labels';
import { ALL_CATEGORIES, DIGEST_MODES, PREFERENCE_CHANNELS, TIME_ZONES, bodyOf, categoryIsValid, cellKey, draftOf, isLocked, problemReasonOf, quietProblem, tooManyItems } from './preferences/model';
import type { DigestMode, PreferenceDraft, PreferenceView } from './preferences/model';
import './preferences/preferences.css';

/**
 * NOT-03: how the member is reached. A matrix of the kinds of events against the channels (the inbox of a category that holds an urgent event is locked and
 * says why), a digest mode for each kind, the hours in which they are not to be disturbed and the time zone those hours are in (BR-NOT-08). The whole set is
 * saved under the version the member saw. Whether a personal channel may be used at all is not decided here: that is the consent of NOT-17.
 */
export default function PreferencesScreen({ route }: ScreenProps) {
  const { t } = useTranslation();
  const preferences = usePreferences();
  // The save lives here, not in the form: a saved set has a new version, the form is then built again, and the notice must outlive it.
  const save = useSavePreferences();
  const state = useScreenState({ isLoading: preferences.isLoading, error: preferences.error, data: preferences.data, isEmpty: () => false });
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title" className="not-preferences">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('not.pref.page.title')}</h1>
          <p>{t('not.pref.page.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={state} onRetry={() => void preferences.refetch()}>
        {preferences.data === undefined ? null : <PreferencesForm key={preferences.data.version} view={preferences.data} save={save} />}
      </StateBoundary>
    </section>
  );
}

function PreferencesForm({ view, save }: { view: PreferenceView; save: ReturnType<typeof useSavePreferences> }) {
  const { t } = useTranslation();
  const { mode } = useSession();
  const readOnly = mode === 'READ_ONLY';
  const [draft, setDraft] = useState<PreferenceDraft>(() => draftOf(view));
  const [newCategory, setNewCategory] = useState('');
  const [categoryError, setCategoryError] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const quiet = quietProblem(draft);
  const rows = [ALL_CATEGORIES, ...draft.categories];
  const zones = [...new Set([draft.timeZone, ...TIME_ZONES])];

  const toggle = (category: string, channel: string): void => {
    const key = cellKey(category, channel);
    const off = new Set(draft.off);
    if (off.has(key)) off.delete(key);
    else off.add(key);
    setDraft({ ...draft, off });
  };

  const setDigest = (category: string, mode: DigestMode): void => {
    const digest = new Map(draft.digest);
    digest.set(category, mode);
    setDraft({ ...draft, digest });
  };

  const addCategory = (): void => {
    const name = newCategory.trim();
    if (!categoryIsValid(name) || rows.includes(name)) {
      setCategoryError(true);
      return;
    }
    setCategoryError(false);
    setNewCategory('');
    setDraft({ ...draft, categories: [...draft.categories, name].sort() });
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (quiet !== undefined || tooManyItems(draft)) return;
    save.mutate({ version: view.version, body: bodyOf(draft) });
  };

  return (
    <form className="card" onSubmit={submit} aria-label={t('not.pref.page.title')} data-testid="preferences-form">
      {readOnly ? (
        <p className="callout warning" role="status">
          {t('not.pref.readOnly.message')}
        </p>
      ) : null}
      {view.isDefault ? <p className="sub">{t('not.pref.default.message')}</p> : null}
      {save.isError ? (
        <p className="callout warning" role="alert" data-testid="save-problem">
          {problemMessage(t, problemReasonOf(save.error))}
        </p>
      ) : null}
      {save.isSuccess ? (
        <p className="callout" role="status" data-testid="save-done">
          {t('not.pref.save.done')}
        </p>
      ) : null}

      <h2>{t('not.pref.matrix.title')}</h2>
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>{t('not.pref.col.category')}</th>
              {PREFERENCE_CHANNELS.map((channel) => (
                <th key={channel}>{channelName(t, channel)}</th>
              ))}
              <th>{t('not.pref.col.digest')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((category) => (
              <tr key={category} data-category={category}>
                <th scope="row">{categoryName(t, category)}</th>
                {PREFERENCE_CHANNELS.map((channel) => {
                  const locked = isLocked(view, category, channel);
                  return (
                    <td key={channel}>
                      <input
                        type="checkbox"
                        checked={locked || !draft.off.has(cellKey(category, channel))}
                        disabled={locked || readOnly}
                        title={locked ? t('not.pref.locked.hint') : undefined}
                        aria-label={`${categoryName(t, category)} - ${channelName(t, channel)}`}
                        onChange={() => toggle(category, channel)}
                      />
                      {locked ? (
                        <span className="lock" aria-hidden="true">
                          {'🔒'}
                        </span>
                      ) : null}
                    </td>
                  );
                })}
                <td>
                  <select
                    value={draft.digest.get(category) ?? 'IMMEDIATE'}
                    disabled={readOnly}
                    aria-label={`${categoryName(t, category)} - ${t('not.pref.col.digest')}`}
                    onChange={(event) => setDigest(category, event.target.value as DigestMode)}
                  >
                    {DIGEST_MODES.map((name) => (
                      <option key={name} value={name}>
                        {digestName(t, name)}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="sub">{t('not.pref.digest.hint')}</p>
      <div className="field inline">
        <label htmlFor="pref-new-category">{t('not.pref.category.add.label')}</label>
        <input id="pref-new-category" value={newCategory} disabled={readOnly} aria-invalid={categoryError ? true : undefined} onChange={(event) => setNewCategory(event.target.value)} />
        <button type="button" disabled={readOnly} onClick={addCategory}>
          {t('not.pref.category.add.action')}
        </button>
        {categoryError ? (
          <small role="alert" className="field-error">
            {t('not.pref.category.add.error')}
          </small>
        ) : null}
      </div>

      <h2>{t('not.pref.quiet.title')}</h2>
      <p className="sub">{t('not.pref.quiet.hint')}</p>
      <label className="agree" htmlFor="pref-quiet-on">
        <input id="pref-quiet-on" type="checkbox" checked={draft.quietOn} disabled={readOnly} onChange={(event) => setDraft({ ...draft, quietOn: event.target.checked })} />
        {t('not.pref.quiet.on.label')}
      </label>
      <div className="field inline">
        <label htmlFor="pref-quiet-start">{t('not.pref.quiet.start.label')}</label>
        <input id="pref-quiet-start" type="time" value={draft.quietStart} disabled={readOnly || !draft.quietOn} onChange={(event) => setDraft({ ...draft, quietStart: event.target.value })} />
        <label htmlFor="pref-quiet-end">{t('not.pref.quiet.end.label')}</label>
        <input id="pref-quiet-end" type="time" value={draft.quietEnd} disabled={readOnly || !draft.quietOn} onChange={(event) => setDraft({ ...draft, quietEnd: event.target.value })} />
      </div>
      {submitted && quiet !== undefined ? (
        <small role="alert" className="field-error">
          {quiet === 'empty' ? t('not.pref.quiet.empty.error') : t('not.pref.quiet.clock.error')}
        </small>
      ) : null}
      <div className="field">
        <label htmlFor="pref-zone">{t('not.pref.zone.label')}</label>
        <select id="pref-zone" value={draft.timeZone} disabled={readOnly} onChange={(event) => setDraft({ ...draft, timeZone: event.target.value })}>
          {zones.map((zone) => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </select>
      </div>
      <div className="formfooter">
        <button type="submit" className="primary" disabled={readOnly || save.isPending}>
          {t('not.pref.save.action')}
        </button>
      </div>
    </form>
  );
}
