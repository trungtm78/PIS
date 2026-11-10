import { useCallback } from 'react';
import { useTranslation } from '../i18n';
import { useEdition } from './EditionContext';

/**
 * The words an edition may say a fund source by, per code of the catalogue of the sources. The base catalogue holds the key with the public wording (which no screen reads for the public edition: it shows the label of the
 * catalogue of the sources as it came); an edition that lists the key in its terminology overlay says it in its own words (the enterprise names the local-budget source as what its plan counts it as, equity).
 */
const NSDP_DTPT_WORDS = 'cap.fund.nsdpDtpt.label';

/** The name of a fund source on a screen: the label of the catalogue, unless the edition says that code its own way. Codes and the figures never change. */
export function useFundName(): (businessKey: string | null | undefined, label: string) => string {
  const { t } = useTranslation();
  const listed = useEdition().manifest.terminology.web;
  return useCallback(
    (businessKey, label) => (businessKey === 'NSDP-DTPT' && listed.includes(NSDP_DTPT_WORDS) ? t('cap.fund.nsdpDtpt.label') : label),
    [listed, t],
  );
}
