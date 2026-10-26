import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import { Field } from '../components';
import { useEngagements } from '../hooks';
import { engagementStatusLabel } from '../labels';
import { concludable } from './model';

const NO_FILTER = { status: '', type: '' } as const;

/** The engagement the screen is about, chosen among the ones that can take a conclusion or have one; the choice is the `engagement` of the address, so a file can be linked to. */
export function EngagementPicker({ selected }: { selected: string | undefined }) {
  const { t } = useTranslation();
  const [, setParams] = useSearchParams();
  const list = useEngagements(NO_FILTER);
  const options = (list.data ?? []).filter((engagement) => concludable(engagement.status) || engagement.id === selected);
  return (
    <div className="card aud-picker">
      <Field id="conclusion-engagement" label={t('aud.conclusion.picker.label')} error={undefined} hint={t('aud.conclusion.picker.help')}>
        <select
          id="conclusion-engagement"
          value={selected ?? ''}
          onChange={(event) => setParams(event.target.value === '' ? {} : { engagement: event.target.value })}
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
