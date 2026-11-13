import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import { Field } from '../components';
import { useEngagements } from '../hooks';
import { engagementStatusLabel } from '../labels';
import type { EngagementStatus } from '../model';
import { concludable } from './model';

const NO_FILTER = { status: '', type: '' } as const;

/**
 * The engagement the screen is about, chosen among the ones that can take a conclusion or have one; the choice is the `engagement` of the address, so a file can be linked to.
 * A screen that names `preferred` opens, without a choice, the first engagement whose status it works on (the work to do), else the first listed; choosing "none" keeps none (`engagement=`).
 * Without `preferred` the screen waits for a choice.
 */
export function EngagementPicker({ selected, preferred }: { selected: string | undefined; preferred?: (status: EngagementStatus) => boolean }) {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const list = useEngagements(NO_FILTER);
  const options = (list.data ?? []).filter((engagement) => concludable(engagement.status) || engagement.id === selected);
  const first = preferred === undefined ? undefined : (options.find((engagement) => preferred(engagement.status)) ?? options[0])?.id;
  const unchosen = !params.has('engagement');
  useEffect(() => {
    if (unchosen && first !== undefined) setParams({ engagement: first }, { replace: true });
  }, [unchosen, first, setParams]);
  return (
    <div className="card">
      <Field id="conclusion-engagement" label={t('aud.conclusion.picker.label')} error={undefined} hint={t('aud.conclusion.picker.help')}>
        <select
          id="conclusion-engagement"
          value={selected ?? ''}
          onChange={(event) => setParams(event.target.value === '' && preferred === undefined ? {} : { engagement: event.target.value })}
        >
          <option value="">{t('aud.conclusion.picker.choose')}</option>
          {options.map((engagement) => (
            <option key={engagement.id} value={engagement.id}>
              {t('aud.conclusion.picker.option', { code: engagement.code, status: engagementStatusLabel(t, engagement.status) })}
            </option>
          ))}
        </select>
      </Field>
    </div>
  );
}
