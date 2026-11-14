import { useState } from 'react';
import { useTranslation } from '../../../i18n';
import { useTemplates } from '../../doc/templates/hooks';
import { CODE_PATTERN } from './template-model';

export interface FormPickerProps {
  /** The form codes the task holds now. */
  value: readonly string[];
  onChange: (codes: string[]) => void;
  disabled: boolean;
  /** The code of the task, so that the checkboxes of two tasks never share a test id. */
  taskCode: string;
}

/**
 * The forms of a task are picked from the published templates of the document store, by title, with a search: nobody has to remember a code. A form whose code the workflow template cannot hold (the code of a workflow form is
 * capital letters, digits and underscores) is listed and said to be unusable, never offered as if it worked. When the store cannot be read the list of codes above stays the way to write them and this stays out of the way.
 */
export function FormPicker({ value, onChange, disabled, taskCode }: FormPickerProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const store = useTemplates({ group: '', status: 'PUBLISHED', asOf: '' });
  const all = (store.data?.pages ?? []).flatMap((page) => page.items);
  if (store.isError || (store.data !== undefined && all.length === 0)) return null;
  // One line for each form: the newest published revision of a code.
  const byCode = new Map<string, { code: string; title: string; revision: number }>();
  for (const item of all) {
    const known = byCode.get(item.templateCode);
    if (known === undefined || item.revision > known.revision) byCode.set(item.templateCode, { code: item.templateCode, title: item.title, revision: item.revision });
  }
  const needle = query.trim().toLowerCase();
  const forms = [...byCode.values()].sort((a, b) => a.title.localeCompare(b.title, 'vi'));
  const shown = forms.filter((form) => value.includes(form.code) || needle === '' || form.title.toLowerCase().includes(needle) || form.code.toLowerCase().includes(needle));
  const searchId = `form-search-${taskCode}`;
  return (
    <fieldset className="pwf-tpl-sub pwf-picker" data-testid={`form-picker-${taskCode}`}>
      <legend>{t('pwf6.editor.forms.legend')}</legend>
      <p className="adm-kit-sub">{t('pwf6.editor.forms.hint')}</p>
      <div className="pwf-field pwf-picker__search">
        <label htmlFor={searchId}>{t('pwf6.editor.forms.search')}</label>
        <input id={searchId} type="search" autoComplete="off" value={query} data-testid={`form-search-${taskCode}`} onChange={(event) => setQuery(event.target.value)} />
      </div>
      {store.isLoading ? <p className="pwf-hint">{t('pwf6.editor.picker.loading')}</p> : null}
      <ul className="pwf-picker__list">
        {shown.map((form) => {
          const usable = CODE_PATTERN.test(form.code);
          return (
            <li key={form.code}>
              <label>
                <input
                  type="checkbox"
                  checked={value.includes(form.code)}
                  disabled={disabled || (!usable && !value.includes(form.code))}
                  data-testid={`form-pick-${taskCode}-${form.code}`}
                  onChange={(event) => onChange(event.target.checked ? [...value, form.code] : value.filter((one) => one !== form.code))}
                />{' '}
                <span>{form.title}</span> <span className="pwf-code">{t('pwf6.editor.forms.item', { code: form.code, revision: form.revision })}</span>
                {usable ? null : <span className="pwf-hint"> · {t('pwf6.editor.forms.unusable')}</span>}
              </label>
            </li>
          );
        })}
      </ul>
      {shown.length === 0 && !store.isLoading ? <p className="pwf-hint">{t('pwf6.editor.picker.none')}</p> : null}
      {store.hasNextPage ? (
        <button type="button" className="ui-button ui-button--outline ui-button--small" disabled={store.isFetchingNextPage} data-action="more-forms" onClick={() => void store.fetchNextPage()}>
          {t('pwf6.editor.picker.more')}
        </button>
      ) : null}
    </fieldset>
  );
}
