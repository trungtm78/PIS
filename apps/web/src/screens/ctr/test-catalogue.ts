import vi from '../../i18n/vi.json';

/** The Vietnamese catalogue as the screens read it: the folded file with the parts not folded yet, so a test names a key whether or not it was folded. */
const parts = import.meta.glob<Record<string, string>>('../../i18n/parts/*.vi.json', { eager: true, import: 'default' });
export const catalogue: Readonly<Record<string, string>> = Object.assign({}, ...Object.values(parts), vi) as Record<string, string>;

export const message = (key: string, params: Record<string, string | number> = {}): string =>
  Object.entries(params).reduce((text, [name, value]) => text.replace(`{${name}}`, String(value)), catalogue[key] ?? key);
