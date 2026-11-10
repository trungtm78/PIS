import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import vi from '../i18n/vi.json';
import { EditionProvider } from './EditionContext';
import { PUBLIC_BUNDLE, installEdition, resetEdition } from './edition';
import type { WebEditionBundle } from './edition';
import { enterpriseBundle } from './enterprise';
import { useFundName } from './fund-name';

// This test names the enterprise folder, so it carries `.enterprise.` in its name: the edition check lets only such tests, the loader and the folder itself do so.
const nameIn = (edition: WebEditionBundle): ((key: string | null | undefined, label: string) => string) => {
  const wrapper = ({ children }: { children: ReactNode }) => <EditionProvider edition={edition}>{children}</EditionProvider>;
  return renderHook(() => useFundName(), { wrapper }).result.current;
};
const MASTER = 'Vốn đầu tư phát triển ngân sách địa phương';

afterEach(resetEdition);

describe('the name of a fund source by edition', () => {
  it('says the local-budget source as equity on the enterprise edition, in the words of its overlay', () => {
    installEdition(enterpriseBundle);
    const said = nameIn(enterpriseBundle)('NSDP-DTPT', MASTER);
    expect(said).toBe('Vốn chủ sở hữu - đầu tư phát triển');
    expect(said).not.toMatch(/ngân sách|địa phương/iu);
  });

  it('leaves the label of the catalogue as it came on the public edition, and for a code no overlay words', () => {
    expect(nameIn(PUBLIC_BUNDLE)('NSDP-DTPT', MASTER)).toBe(MASTER);
    expect(nameIn(enterpriseBundle)('ODA-ONLEND', 'Vốn vay ODA')).toBe('Vốn vay ODA');
    expect(nameIn(enterpriseBundle)(null, 'Nguồn khác')).toBe('Nguồn khác');
  });

  it('keeps the public wording in the base catalogue, so the code and the master label are not changed', () => {
    expect(vi['cap.fund.nsdpDtpt.label']).toBe(MASTER);
  });
});
