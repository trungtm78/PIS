import { useCallback } from 'react';
import { useTranslation } from '../i18n';
import { useEdition } from './EditionContext';

/**
 * The key of the words an edition may say a fund source by, per code of the catalogue of the sources. The base catalogue holds the key with the public wording (which no screen reads for the public edition: it shows the
 * label of the catalogue of the sources as it came); an edition that lists the key in its terminology overlay says it in its own words (the enterprise names the local-budget source as what its plan counts it as, equity).
 */
const FUND_WORDS: Readonly<Record<string, string>> = { 'NSDP-DTPT': 'cap.fund.nsdpDtpt.label' };

/** The name of a fund source on a screen: the label of the catalogue, unless the edition says that code its own way. Codes and the figures never change. */
export function useFundName(): (businessKey: string | null | undefined, label: string) => string {
  const { t } = useTranslation();
  const listed = useEdition().manifest.terminology.web;
  return useCallback(
    (businessKey, label) => {
      const key = businessKey === null || businessKey === undefined ? undefined : FUND_WORDS[businessKey];
      return key !== undefined && listed.includes(key) ? t(key) : label;
    },
    [listed, t],
  );
}
