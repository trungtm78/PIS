import type { ManifestShortcut } from './manifest';

/**
 * The words of the manifest, in Vietnamese (the manifest has one language: `lang` of the page of the installed application). They are read by the build
 * (`vite.pwa.ts`), which has no translator, so they are here and not in the catalogue; the product name is not here, it comes from the edition manifest
 * (`brand.ts`).
 */
const SHORT_NAMES: Readonly<Record<string, string>> = { public: 'Đầu tư công', enterprise: 'Đầu tư XD' };

/** The name under the icon of the home screen: at most 12 characters. */
export const shortNameOfEdition = (edition: string): string => SHORT_NAMES[edition] ?? SHORT_NAMES.public ?? 'Đầu tư';

export const MANIFEST_DESCRIPTION = 'Phê duyệt số liệu kỳ, xem bảng điều hành và theo dõi chỉ đạo ngay trên điện thoại.';

export const MANIFEST_SHORTCUTS: readonly ManifestShortcut[] = [
  { name: 'Hàng đợi phê duyệt', url: '/m/approvals' },
  { name: 'Bảng điều hành', url: '/m/dashboard' },
  { name: 'Theo dõi chỉ đạo', url: '/m/directives' },
];
