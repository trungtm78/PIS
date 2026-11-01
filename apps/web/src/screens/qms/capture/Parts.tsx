import { useMemo } from 'react';
import { useTranslation } from '../../../i18n';
import { Field } from '../../ctr/components';
import { NO_FILTER } from '../diary/model';
import { useDiaries } from '../diary/hooks';
import { flagMessage, summaryLabel } from '../photo/labels';
import { usePhotoChecks, usePhotos } from '../photo/hooks';
import { NO_FILTER as NO_PHOTO_FILTER } from '../photo/model';
import '../qms.css';
import { preflightMessage } from './labels';
import { preflightFlags } from './model';
import type { Place } from './model';

/** The diaries of a contract a photo may be linked to; rendered only for a caller who may read diaries, so nothing is read otherwise. */
export function DiaryChoice({ contractId, value, error, onChange }: { contractId: string; value: string; error: string | undefined; onChange(id: string): void }) {
  const { t } = useTranslation();
  const diaries = useDiaries({ ...NO_FILTER, contractId });
  const lines = useMemo(() => (diaries.data?.pages ?? []).flatMap((page) => page.lines), [diaries.data]);
  return (
    <Field id="capture-diary" label={t('qms.capture.field.diary')} error={error}>
      <select id="capture-diary" value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{t('qms.capture.field.diary.none')}</option>
        {lines.map((line) => (
          <option key={line.id} value={line.id}>
            {line.diaryNo} · {line.recordDate}
          </option>
        ))}
      </select>
    </Field>
  );
}

/**
 * The flags that can be shown before the send: the same file already in the register of the contract, and whether a place will be kept. The register is read only for a caller who may read photos; the flags of time, zone and
 * EXIF come from the file itself and are given by the server once the photo is registered. They are aids to review, never a verdict.
 */
export function Preflight({ contractId, sha256, place, canRead }: { contractId: string; sha256: string | undefined; place: Place; canRead: boolean }) {
  const { t } = useTranslation();
  return (
    <section aria-label={t('qms.capture.preflight.title')} data-testid="preflight">
      <h2>{t('qms.capture.preflight.title')}</h2>
      {canRead && contractId !== '' ? <KnownFlags contractId={contractId} sha256={sha256} place={place} /> : <FlagList flags={preflightFlags(undefined, [], place)} />}
      <p className="sub">{t('qms.capture.preflight.note')}</p>
    </section>
  );
}

function KnownFlags({ contractId, sha256, place }: { contractId: string; sha256: string | undefined; place: Place }) {
  const photos = usePhotos({ ...NO_PHOTO_FILTER, contractId });
  const known = useMemo(() => (photos.data?.pages ?? []).flatMap((page) => page.lines), [photos.data]);
  return <FlagList flags={preflightFlags(sha256, known, place)} />;
}

function FlagList({ flags }: { flags: ReturnType<typeof preflightFlags> }) {
  const { t } = useTranslation();
  return (
    <ul className="qms-actions" data-testid="preflight-flags">
      {flags.map((flag) => (
        <li key={flag} data-flag={flag}>
          {preflightMessage(t, flag)}
        </li>
      ))}
    </ul>
  );
}

/** What the server found when the photo was registered: the flags it raised for a reviewer, in words that do not say the photo is true or false. */
export function Registered({ id, canRead }: { id: string; canRead: boolean }) {
  const { t } = useTranslation();
  return (
    <section className="card" aria-label={t('qms.capture.done.title')} data-testid="registered" data-photo={id}>
      <h2>{t('qms.capture.done.title')}</h2>
      <p role="status">{t('qms.capture.done.text')}</p>
      {canRead ? <ServerChecks id={id} /> : null}
    </section>
  );
}

function ServerChecks({ id }: { id: string }) {
  const { t } = useTranslation();
  const checks = usePhotoChecks(id);
  const view = checks.data ?? undefined;
  if (view === undefined) return checks.isError ? <p className="callout warning">{t('qms.capture.done.checksFailed')}</p> : null;
  return (
    <div data-testid="server-checks">
      <p className="qms-badge warning">{summaryLabel(t, view.checks.summary)}</p>
      {view.flags.length === 0 ? (
        <p className="qms-badge ok" role="status" data-testid="no-flags">
          {t('qms.photo.flags.none')}
        </p>
      ) : (
        <ul className="qms-actions" data-testid="flags">
          {view.flags.map((flag) => (
            <li key={flag} data-flag={flag}>
              {flagMessage(t, flag)}
            </li>
          ))}
        </ul>
      )}
      <p className="sub">{t('qms.photo.note')}</p>
    </div>
  );
}
