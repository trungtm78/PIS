import type { ThemeConfig } from '@machvon/db';

/** The longest name, title or header a theme may carry (TenantThemeConfig in openapi.json); a tenant name may be longer (255). */
export const THEME_DISPLAY_MAX = 160;

/** The tenant name cut to what the theme contract allows, by characters (not UTF-16 units), without a trailing space. */
export function themeDisplayName(tenantName: string): string {
  const characters = Array.from(tenantName.trim());
  return characters.length <= THEME_DISPLAY_MAX ? characters.join('') : characters.slice(0, THEME_DISPLAY_MAX).join('').trimEnd();
}

/**
 * Version 1 of the theme of every new tenant (SAS 3.1 step 10): the colours and texts of the prototype under the name of the
 * tenant. The text fields are the defaults a System Admin replaces in SAS-04; the colours pass the contrast rules of the design tokens.
 */
export function defaultTenantTheme(tenantName: string): ThemeConfig {
  const display = themeDisplayName(tenantName);
  return {
    name: display,
    title: display,
    subtitle: '',
    header: display,
    footer: '',
    address: '',
    email: '',
    phone: '',
    primary: '#007d77',
    primaryText: '#ffffff',
    menu: '#102e3b',
    menuText: '#ffffff',
    selected: '#1c4a52',
    selectedText: '#ffffff',
    headerBg: '#ffffff',
    headerText: '#122d3b',
    footerBg: '#ffffff',
    footerText: '#5b6e77',
    background: '#f3f6f5',
    titleColor: '#122d3b',
    logoAssetId: null,
  };
}
