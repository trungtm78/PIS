import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import { useSession } from '../../../session/SessionContext';
import { StatusPill } from '../../../ui';
import { MAX_REMINDERS } from '../bands/band-model';
import type { Thresholds } from '../bands/band-model';
import { sentenceText } from '../bands/sentence';
import { BandBadge, FigureInfo } from '../components';
import { useReloadPwf } from '../hooks';
import { remainingText } from '../labels';
import { levelLabel, levelWord, officialText, problemText, refusalText } from './labels';
import { usePersonalConfirmation, usePreferenceDraft, useSavePreference } from './hooks';
import { BLANK_FORM, LEVELS, PREFERENCE_UNIT, bodyOf, describeRefusal, disagreements, followsOfficial, previewRows, rowBand, setsLevel, textOfLevel } from './model';
import type { Level, PreferenceProblem, PreferenceView } from './model';
import './preference.css';

type Notice = 'saved' | 'cleared';

export interface PreferencePanelProps {
  view: PreferenceView;
  /** The card of the settings (no preview table); the screen PWF-15 is the full one. */
  compact: boolean;
  /** Where the full screen is, for the card (nothing when the card is on the full screen's own side). */
  fullLink?: string;
}

/**
 * The personal reminders: the three levels and the reminder days the person sets for themselves, each beside the official one, with what the numbers mean in the owner's words and, on the full screen, the colour at each number of days left.
 * The save lives here, not in the form: a saved setting has a new version, the form is then built again, and the notice must outlive it.
 */
export function PreferencePanel({ view, compact, fullLink }: PreferencePanelProps) {
  const save = useSavePreference();
  const [notice, setNotice] = useState<Notice | undefined>(undefined);
  const reload = useReloadPwf();
  const { mode } = useSession();
  return (
    <PreferenceEditor
      key={view.version}
      view={view}
      compact={compact}
      readOnly={mode === 'READ_ONLY'}
      save={save}
      notice={notice}
      setNotice={setNotice}
      onReload={() => {
        save.reset();
        setNotice(undefined);
        void reload();
      }}
      {...(fullLink === undefined ? {} : { fullLink })}
    />
  );
}

interface EditorProps {
  view: PreferenceView;
  compact: boolean;
  readOnly: boolean;
  save: ReturnType<typeof useSavePreference>;
  notice: Notice | undefined;
  setNotice: (notice: Notice | undefined) => void;
  onReload: () => void;
  fullLink?: string;
}

function PreferenceEditor({ view, compact, readOnly, save, notice, setNotice, onReload, fullLink }: EditorProps) {
  const { t } = useTranslation();
  const draft = usePreferenceDraft(view);
  const confirm = usePersonalConfirmation(draft.form, draft.ladder, !compact);
  const [attempted, setAttempted] = useState(false);
  const refusal = save.isError ? describeRefusal(save.error) : undefined;
  const show = attempted || draft.dirty;
  const problemOf = (path: Level | 'reminder_days'): string | undefined => {
    const found: PreferenceProblem | undefined = show ? draft.problems.find((one) => one.path === path) : undefined;
    if (found !== undefined) return problemText(t, found);
    return refusal !== undefined && refusal.field === path && refusal.kind !== 'conflict' ? refusalText(t, refusal) : undefined;
  };
  const pending = save.isPending;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setAttempted(true);
    if (draft.problems.length > 0 || !draft.dirty || readOnly) return;
    setNotice(undefined);
    save.mutate({ version: view.version, body: draft.body() }, { onSuccess: () => setNotice('saved') });
  };
  const clear = (): void => {
    setNotice(undefined);
    save.mutate({ version: view.version, body: bodyOf(BLANK_FORM) }, { onSuccess: () => setNotice('cleared') });
  };

  return (
    <form className={compact ? 'pwfp-form pwfp-form--compact' : 'pwfp-form'} onSubmit={submit} noValidate aria-label={t('pwf.pref.form.label')} data-testid="deadline-form">
      {readOnly ? (
        <p className="callout warning" role="status" data-testid="read-only">
          {t('pwf.pref.readOnly.text')}
        </p>
      ) : null}
      {view.clamped.length === 0 ? null : (
        <p className="callout warning" role="status" data-testid="clamped">
          <span aria-hidden="true">⚠ </span>
          {t('pwf.pref.clamped.text', { levels: view.clamped.map((level) => levelWord(t, level)).join(', ') })}
        </p>
      )}
      {refusal === undefined ? null : (
        <div className="callout danger" role="alert" data-testid="refusal" data-kind={refusal.kind}>
          <p>{refusalText(t, refusal)}</p>
          {refusal.kind === 'conflict' ? (
            <button type="button" className="ui-button ui-button--outline ui-button--small pwa-touch" data-action="reload" onClick={onReload}>
              {t('pwf.pref.reload.action')}
            </button>
          ) : null}
        </div>
      )}
      {notice === undefined ? null : (
        <p className="callout" role="status" data-testid="notice" data-notice={notice}>
          {notice === 'saved' ? t('pwf.pref.saved.text') : t('pwf.pref.cleared.text')}
        </p>
      )}
      {followsOfficial(view) && !draft.dirty && notice === undefined ? (
        <p className="callout" role="status" data-testid="no-setting">
          {t('pwf.pref.noSetting.text')}
        </p>
      ) : null}
      <p className="pwfp-rule">{t('pwf.pref.rule.text')}</p>
      <div className="pwfp-levels">
        {LEVELS.map((level) => (
          <NumberField
            key={level}
            path={level}
            label={levelLabel(t, level)}
            hint={officialText(t, level, view.official)}
            value={textOfLevel(draft.form, level)}
            disabled={readOnly}
            problem={problemOf(level)}
            onChange={(text) => draft.setLevel(level, text)}
          />
        ))}
      </div>
      <NumberField
        path="reminder_days"
        label={t('pwf.pref.reminders.label')}
        hint={t('pwf.pref.reminders.hint', { official: view.official.red_days, max: MAX_REMINDERS })}
        value={draft.form.reminders}
        disabled={readOnly}
        problem={problemOf('reminder_days')}
        onChange={draft.setReminders}
      />
      <Sentences official={view.official} ladder={draft.ladder} personal={setsLevel(draft.form)} />
      {compact ? null : <Preview official={view.official} ladder={draft.ladder} personal={setsLevel(draft.form)} confirm={confirm} />}
      <div className="pwf-actions">
        <button type="submit" className="ui-button ui-button--primary pwa-touch" data-action="save" disabled={readOnly || pending || !draft.dirty}>
          {pending ? t('pwf.pref.saving.text') : t('pwf.pref.save.action')}
        </button>
        <button type="button" className="ui-button ui-button--outline pwa-touch" data-action="clear" disabled={readOnly || pending || followsOfficial(view)} onClick={clear}>
          {t('pwf.pref.clear.action')}
        </button>
        {fullLink === undefined ? null : (
          <Link to={fullLink} className="ui-button ui-button--outline pwa-touch" data-testid="link-full">
            {t('pwf.pref.full.link')}
          </Link>
        )}
      </div>
    </form>
  );
}

// ---- fields ------------------------------------------------------------------------------------------------------------------------------------------------------------------

interface NumberFieldProps {
  path: Level | 'reminder_days';
  label: string;
  hint: string;
  value: string;
  disabled: boolean;
  problem: string | undefined;
  onChange: (text: string) => void;
}

/** A number (or a list of numbers) the person types, with the official one written under it. */
function NumberField({ path, label, hint, value, disabled, problem, onChange }: NumberFieldProps) {
  const id = useId();
  const invalid = problem !== undefined;
  return (
    <div className="pwf-field pwfp-field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        value={value}
        disabled={disabled}
        aria-invalid={invalid}
        aria-describedby={`${id}-hint${invalid ? ` ${id}-error` : ''}`}
        data-testid={`field-${path}`}
        onChange={(event) => onChange(event.target.value)}
      />
      <span className="gova1-hint pwfp-official" id={`${id}-hint`} data-testid={`hint-${path}`}>
        {hint}
      </span>
      {problem === undefined ? null : (
        <span className="pwf-field__error" id={`${id}-error`} data-testid={`error-${path}`}>
          <span aria-hidden="true">⚠ </span>
          {problem}
        </span>
      )}
    </div>
  );
}

// ---- what the numbers say --------------------------------------------------------------------------------------------------------------------------------------------

/** The official ladder and the person's own, each in the owner's words ("5 working days left: green, 2: yellow, under 1: red"). */
function Sentences({ official, ladder, personal }: { official: Thresholds; ladder: Thresholds | undefined; personal: boolean }) {
  const { t } = useTranslation();
  return (
    <dl className="pwfp-sentences" data-testid="sentences">
      <dt>{t('pwf.pref.sentence.official.label')}</dt>
      <dd data-testid="sentence-official">{sentenceText(t, official, PREFERENCE_UNIT)}</dd>
      <dt>{t('pwf.pref.personal.label')}</dt>
      <dd data-testid="sentence-personal">{ladder === undefined ? t('pwf.pref.sentence.blocked.text') : personal ? sentenceText(t, ladder, PREFERENCE_UNIT) : t('pwf.pref.sentence.same.text')}</dd>
    </dl>
  );
}

/**
 * The colour at some numbers of days left, with the official ladder and the personal one side by side, computed here as the numbers are typed and confirmed by the server (`previewDeadlineBand`).
 * The colour is always the word and the glyph, never the colour alone.
 */
function Preview({ official, ladder, personal, confirm }: { official: Thresholds; ladder: Thresholds | undefined; personal: boolean; confirm: ReturnType<typeof usePersonalConfirmation> }) {
  const { t } = useTranslation();
  return (
    <div className="pwfp-preview" data-testid="preview">
      <h3>{t('pwf.pref.preview.title')}</h3>
      {ladder === undefined ? (
        <p className="callout warning" role="status" data-testid="preview-blocked">
          <span aria-hidden="true">⚠ </span>
          {t('pwf.pref.preview.blocked.text')}
        </p>
      ) : (
        <>
          <div className="tablewrap">
            <table className="pwfp-table" data-testid="preview-table" aria-label={t('pwf.pref.preview.examples.label')}>
              <thead>
                <tr>
                  <th scope="col">{t('pwf.pref.preview.days.label')}</th>
                  <th scope="col">{t('pwf.pref.preview.official.label')}</th>
                  <th scope="col">{t('pwf.pref.personal.label')}</th>
                </tr>
              </thead>
              <tbody>
                {previewRows(official, ladder).map((row) => (
                  <tr key={row.days} data-days={row.days} data-official={row.official} data-personal={row.personal}>
                    <th scope="row">{remainingText(t, rowBand(row.official, row.days))}</th>
                    <td>
                      <BandBadge band={rowBand(row.official, row.days)} showDays={false} />
                    </td>
                    <td>
                      <BandBadge band={rowBand(row.personal, row.days)} showDays={false} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {personal ? <ServerCheck ladder={ladder} confirm={confirm} /> : null}
        </>
      )}
    </div>
  );
}

/** What the server says about the personal ladder: it agrees with the table above, it differs at some numbers of days, or it cannot be asked (the table is then the reading of this device). */
function ServerCheck({ ladder, confirm }: { ladder: Thresholds; confirm: ReturnType<typeof usePersonalConfirmation> }) {
  const { t } = useTranslation();
  if (confirm.isError) {
    return (
      <p className="adm-kit-sub" role="status" data-testid="server-check" data-state="unavailable">
        {t('pwf.pref.check.unavailable.text')}
      </p>
    );
  }
  if (confirm.data === undefined) {
    return (
      <p className="adm-kit-sub" role="status" data-testid="server-check" data-state="pending">
        {t('pwf.pref.check.pending.text')}
      </p>
    );
  }
  const differing = disagreements(ladder, confirm.data.examples);
  if (differing.length > 0) {
    return (
      <p className="callout warning" role="status" data-testid="server-check" data-state="differs">
        <span aria-hidden="true">⚠ </span>
        {t('pwf.pref.check.differs.text', { days: differing.join(', ') })}
      </p>
    );
  }
  return (
    <p className="adm-kit-sub" role="status" data-testid="server-check" data-state="agrees">
      <StatusPill tone="success" icon="✓">
        {t('pwf.pref.check.agrees.text')}
      </StatusPill>{' '}
      <FigureInfo name={t('pwf.pref.preview.title')} formula={t('pwf.pref.check.formula')} source={t('pwf.pref.check.source')} asOf={confirm.data.as_of} version={t('pwf.pref.check.version')} />
    </p>
  );
}
