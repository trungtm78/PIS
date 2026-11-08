import { useTranslation } from '../../../i18n';
import { CommandDialog, reasonField, stringsOf } from '../shared/vnd-form';
import type { FieldSpec, Values } from '../shared/vnd-form';
import { groupLabel } from '../shared/vnd-labels';
import { VIOLATION_GROUPS } from '../shared/vnd-model';
import { useVendorCommand } from './investigation-hooks';
import { entryProblemLabel, hitBasisLabel, sourceLabel } from './investigation-labels';
import { LIST_SOURCES, parseEntries } from './investigation-model';
import type { HitLine, ListSource } from './investigation-model';

interface DialogProps {
  onClose: () => void;
  onDone: () => void;
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const sourceOf = (value: unknown): ListSource => LIST_SOURCES.find((source) => source === value) ?? 'OTHER_LIST';
const PREVIEW_ROWS = 5;

const hitContext = (t: ReturnType<typeof useTranslation>['t'], hit: HitLine): { label: string; value: string }[] => [
  { label: t('vnd3.screening.column.contractor'), value: `${hit.contractor_name} (${hit.contractor_tax_identifier})` },
  { label: t('vnd3.screening.column.source'), value: sourceLabel(t, hit.source) },
  { label: t('vnd3.screening.column.entry'), value: hit.entry_name ?? hit.entry_tax_code ?? hit.entry_ref },
  { label: t('vnd3.screening.column.score'), value: `${hit.score} (${hit.basis.map((basis) => hitBasisLabel(t, basis)).join(', ')})` },
];

/**
 * Confirms a hit: the person says the contractor IS the party on the list. For the list of the national network a case of the register is opened (the decision of a ban stays with the authority, on a decision paper), so the
 * violation groups are asked; for another list the confirmation is recorded and the hold stays until the person who owns the matter ends it. The hold of a confirmed hit is not lifted by the confirmation.
 */
export function ConfirmHitDialog({ hit, onClose, onDone }: DialogProps & { hit: HitLine }) {
  const { t } = useTranslation();
  const command = useVendorCommand('confirmVendorScreeningHit');
  const national = hit.source === 'NATIONAL_DEBARMENT';
  const fields: FieldSpec[] = [
    { name: 'violation_groups', label: t('vnd3.screening.confirm.groups.label'), kind: 'checks', required: true, min: 1, options: VIOLATION_GROUPS.map((code) => ({ value: code, label: groupLabel(t, code) })), visible: () => national },
    { name: 'violation_summary', label: t('vnd3.screening.confirm.summary.label'), kind: 'textarea', min: 20, max: 2000, hint: t('vnd.field.reason.hint', { count: 20 }), visible: () => national },
    { name: 'note', label: t('vnd3.screening.confirm.note.label'), kind: 'text', max: 500 },
  ];
  const run = (values: Values): Promise<unknown> =>
    command.mutateAsync({
      path: { id: hit.id },
      ifMatchVersion: hit.version,
      body: {
        ...(national ? { violation_groups: stringsOf(values.violation_groups) } : {}),
        ...(national && text(values.violation_summary) !== '' ? { violation_summary: text(values.violation_summary) } : {}),
        ...(text(values.note) === '' ? {} : { note: text(values.note) }),
      },
    });
  return (
    <CommandDialog
      title={t('vnd3.screening.confirm.title')}
      context={hitContext(t, hit)}
      note={<p className="vnd-note">{national ? t('vnd3.screening.confirm.noteNational') : t('vnd3.screening.confirm.noteOther')}</p>}
      confirmLabel={t('vnd3.screening.confirm.confirm')}
      danger
      fields={fields}
      run={run}
      onClose={onClose}
      onDone={onDone}
    />
  );
}

/** Dismisses a hit with a reason of 20 characters at least (a hit on a tax code is not waved away with a word). The hit is asked again when the entry changes or the dismissal runs out. */
export function DismissHitDialog({ hit, onClose, onDone }: DialogProps & { hit: HitLine }) {
  const { t } = useTranslation();
  const command = useVendorCommand('dismissVendorScreeningHit');
  return (
    <CommandDialog
      title={t('vnd3.screening.dismiss.title')}
      context={hitContext(t, hit)}
      note={<p className="vnd-note">{t('vnd3.screening.dismiss.note')}</p>}
      confirmLabel={t('vnd3.screening.dismiss.confirm')}
      fields={[reasonField(t, 20)]}
      run={(values) => command.mutateAsync({ path: { id: hit.id }, ifMatchVersion: hit.version, body: { reason: text(values.reason) } })}
      onClose={onClose}
      onDone={onDone}
    />
  );
}

/**
 * Imports a list of parties that may not be dealt with (a multilateral bank, politically exposed persons, a list of the tenant): the text is a JSON array or lines of ref, name, tax code, valid from, valid until. The preview
 * says how many entries were read and shows the first ones; a bad line is named and keeps the button off, so nothing is sent that would be refused and nothing is dropped without being said. The national list is not imported
 * here: the file import keeps it. A screening runs after the import.
 */
export function ImportListDialog({ onClose, onDone }: DialogProps) {
  const { t } = useTranslation();
  const command = useVendorCommand('importVendorScreeningList');
  const fields: FieldSpec[] = [
    { name: 'source', label: t('vnd3.import.field.source.label'), kind: 'select', required: true, options: LIST_SOURCES.map((code) => ({ value: code, label: sourceLabel(t, code) })) },
    { name: 'as_of', label: t('vnd3.import.field.asOf.label'), kind: 'date', required: true },
    { name: 'reference', label: t('vnd3.import.field.reference.label'), kind: 'text', required: true, min: 3, max: 300 },
    { name: 'entries', label: t('vnd3.import.field.entries.label'), kind: 'textarea', required: true, hint: t('vnd3.import.field.entries.hint') },
  ];
  return (
    <CommandDialog
      wide
      title={t('vnd3.import.title')}
      context={[]}
      note={<p className="vnd-note">{t('vnd3.import.note')}</p>}
      confirmLabel={t('vnd3.import.confirm')}
      fields={fields}
      blocked={(values) => {
        const parsed = parseEntries(text(values.entries));
        return parsed.errors.length > 0 || parsed.entries.length === 0;
      }}
      extra={(values) => <ImportPreview source={text(values.entries)} />}
      run={(values) => {
        const parsed = parseEntries(text(values.entries));
        return command.mutateAsync({ body: { source: sourceOf(values.source), as_of: text(values.as_of), reference: text(values.reference), entries: parsed.entries } });
      }}
      onClose={onClose}
      onDone={onDone}
    />
  );
}

function ImportPreview({ source }: { source: string }) {
  const { t } = useTranslation();
  if (source.trim() === '') return null;
  const parsed = parseEntries(source);
  return (
    <div data-testid="import-preview" role="status">
      <p className="vnd-note" data-testid="import-count">
        {t('vnd3.import.preview.count', { count: parsed.entries.length })}
      </p>
      {parsed.entries.length > 0 && (
        <ol className="inv-preview">
          {parsed.entries.slice(0, PREVIEW_ROWS).map((entry) => (
            <li key={entry.ref}>{t('vnd3.import.preview.row', { ref: entry.ref, name: entry.name ?? '–', tax: entry.tax_code ?? '–' })}</li>
          ))}
        </ol>
      )}
      {parsed.errors.length > 0 && (
        <ul className="vnd-list" role="alert" data-testid="import-errors">
          {parsed.errors.slice(0, PREVIEW_ROWS).map((error) => (
            <li key={`${error.line}:${error.problem}`}>{t('vnd3.import.preview.error', { line: error.line, problem: entryProblemLabel(t, error.problem) })}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
