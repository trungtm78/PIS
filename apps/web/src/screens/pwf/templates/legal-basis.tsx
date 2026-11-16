import { useQueries } from '@tanstack/react-query';
import { useId } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { useTranslation } from '../../../i18n';
import { useSession } from '../../../session/SessionContext';
import { personText } from '../../adm/governance/components';
import { useCatalogue, useScopeKey } from '../../adm/governance/hooks';
import { toResolved } from '../../adm/governance/model';
import { dayText } from '../model';
import { docKindWord } from '../process/labels';
import { basisState, editBasis, markBasis } from './table-model';
import { MAX_LEGAL_BASIS, MAX_ARTICLE, MAX_NOTE } from './template-model';
import type { LegalBasisInput } from './template-model';

const LEGAL_DOCUMENT = 'LEGAL_DOCUMENT';

/**
 * What people call each document of the catalogue (its kind and number, "Nghị định 85/2025/NĐ-CP"), read from the rule in force of each code: the picker of a legal ground shows the name and keeps the code as a note. A
 * document whose rule cannot be read has no name here and is shown by its code; nothing waits for the names.
 */
export function useLegalDocumentNames(codes: readonly string[]): ReadonlyMap<string, string> {
  const { t } = useTranslation();
  const client = useApiClient();
  const key = useScopeKey();
  const found = useQueries({
    queries: codes.map((code) => ({
      queryKey: [...key, 'pwf-legal-document', code],
      enabled: key[1] !== undefined,
      retry: false,
      staleTime: 300_000,
      queryFn: async (): Promise<string | null> => {
        const rule = toResolved(await client.read('getEffectiveGovernanceRule' as never, { query: { rule_type: LEGAL_DOCUMENT, code } } as never).catch(() => null));
        const params = rule?.params as { doc_kind?: unknown; number?: unknown } | undefined;
        return typeof params?.number === 'string' && params.number !== '' ? `${typeof params.doc_kind === 'string' ? `${docKindWord(t, params.doc_kind as never)} ` : ''}${params.number}` : null;
      },
    })),
  });
  const names = new Map<string, string>();
  codes.forEach((code, index) => {
    const name = found[index]?.data;
    if (typeof name === 'string') names.set(code, name);
  });
  return names;
}

/** The codes of the shared catalogue of legal documents (R45), as the rule store lists them; empty while it is read or when it cannot be read (the code is then typed). */
export function useLegalDocumentCodes(): string[] {
  const catalogue = useCatalogue(true);
  return catalogue.data?.find((one) => one.ruleType === LEGAL_DOCUMENT)?.codes.map((code) => code.code) ?? [];
}

/** How one citation is said on a row: who checked it and when (the stamp is the server's), "waiting for the stamp" for a line the person marked and nobody stamped yet, or not checked. */
export function BasisStamp({ basis }: { basis: LegalBasisInput }) {
  const { t } = useTranslation();
  const { tenant } = useSession();
  const state = basisState(basis);
  if (state === 'stamped') {
    return (
      <span className="pwfx-stamp" data-state="stamped">
        <span aria-hidden="true">✔ </span>
        {t('pwfx.basis.stamped', { who: personText(t, basis.verified_by ?? '', tenant?.membershipId), day: dayText((basis.verified_at ?? '').slice(0, 10)) })}
      </span>
    );
  }
  if (state === 'claimed') {
    return (
      <span className="pwfx-stamp" data-state="claimed">
        <span aria-hidden="true">⏳ </span>
        {t('pwfx.basis.claimed')}
      </span>
    );
  }
  return (
    <span className="pwfx-stamp" data-state="unverified">
      <span aria-hidden="true">⚠ </span>
      {t('pwfx.basis.unverified')}
    </span>
  );
}

export interface LegalBasisEditorProps {
  /** What the list is about, in words for the labels ("Bước 3"). */
  subject: string;
  value: readonly LegalBasisInput[];
  onChange: (value: LegalBasisInput[]) => void;
  disabled: boolean;
  /** The id the cell of the first problem of the list can be reached by (the summary above the table jumps to it). */
  cell?: string;
}

/**
 * The legal grounds of a step or a task (R45, R75): each cites a document of the shared catalogue by its code, the article when it is known (left empty rather than guessed) and whether the citation was checked against
 * the source text. The person says so with "Đã đối chiếu văn bản gốc"; the stamp (who, when) is written by the server when the draft is saved and is gone as soon as the citation is changed.
 */
export function LegalBasisEditor({ subject, value, onChange, disabled, cell }: LegalBasisEditorProps) {
  const { t } = useTranslation();
  const documents = useLegalDocumentCodes();
  const names = useLegalDocumentNames(documents);
  const id = useId();
  return (
    <div className="pwfx-basis" data-cell={cell}>
      {value.length === 0 ? <p className="pwf-hint">{t('pwfx.basis.none')}</p> : null}
      <ul className="pwfx-basis__list" aria-label={t('pwfx.basis.list', { subject })}>
        {value.map((one, index) => {
          const unknown = documents.length > 0 && one.document !== '' && !documents.includes(one.document);
          const label = (what: string): string => t('pwfx.basis.field', { what, n: index + 1, subject });
          return (
            <li key={index} className="pwfx-basis__item">
              <div className="pwfx-basis__fields">
                <select aria-label={label(t('pwfx.basis.document'))} value={documents.includes(one.document) ? one.document : one.document === '' ? '' : '~typed'} disabled={disabled} onChange={(event) => onChange(editBasis(value, index, { document: event.target.value === '~typed' ? one.document : event.target.value }))}>
                  <option value="">{t('pwfx.basis.pick')}</option>
                  {documents.map((code) => (
                    <option key={code} value={code}>
                      {names.get(code) === undefined ? code : t('fix8.legal.pick.option', { name: names.get(code) ?? '', code })}
                    </option>
                  ))}
                  {one.document !== '' && !documents.includes(one.document) ? <option value="~typed">{one.document}</option> : null}
                </select>
                <input type="text" autoComplete="off" maxLength={MAX_ARTICLE} placeholder={t('pwfx.basis.article')} aria-label={label(t('pwfx.basis.article'))} value={one.article ?? ''} disabled={disabled} onChange={(event) => onChange(editBasis(value, index, { article: event.target.value }))} />
                <input type="text" autoComplete="off" maxLength={MAX_NOTE} placeholder={t('pwfx.basis.note')} aria-label={label(t('pwfx.basis.note'))} value={one.note ?? ''} disabled={disabled} onChange={(event) => onChange(editBasis(value, index, { note: event.target.value }))} />
              </div>
              <div className="pwfx-basis__state">
                <BasisStamp basis={one} />
                {unknown ? <span className="pwfx-cell-error">{t('pwf.templates.legal.unknown.text')}</span> : null}
                {one.verification === 'VERIFIED' ? (
                  <button type="button" className="ui-button ui-button--outline ui-button--small" disabled={disabled} onClick={() => onChange(markBasis(value, index, false))}>
                    {t('pwfx.basis.unmark')}
                  </button>
                ) : (
                  <button type="button" className="ui-button ui-button--outline ui-button--small" disabled={disabled || one.document === ''} onClick={() => onChange(markBasis(value, index, true))}>
                    {t('pwfx.basis.mark')}
                  </button>
                )}
                <button type="button" className="ui-button ui-button--outline ui-button--small" disabled={disabled} aria-label={label(t('pwfx.basis.remove'))} onClick={() => onChange(value.filter((_, at) => at !== index))}>
                  {t('pwfx.basis.remove')}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      <button type="button" id={`${id}-add`} className="ui-button ui-button--outline ui-button--small" disabled={disabled || value.length >= MAX_LEGAL_BASIS} onClick={() => onChange([...value, { document: '', verification: 'UNVERIFIED' }])}>
        {t('pwfx.basis.add')}
      </button>
    </div>
  );
}
