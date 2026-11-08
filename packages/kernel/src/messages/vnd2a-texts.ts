/**
 * The Vietnamese texts of the alerts of the independence, finance and load controls (VND-2, lane part alpha; docs/vendor-controls-independence-finance.md): a module (not the JSON catalogue) because the alert source
 * of the database and the screens read them without a file system. Placeholders are filled by `fill`.
 */
const KIND_LABELS: Readonly<Record<string, string>> = {
  BIDDERS_SHARE_TAX_HEAD: 'hai nhà thầu cùng mã số thuế gốc',
  BIDDERS_SHARE_ADDRESS: 'hai nhà thầu cùng địa chỉ',
  BIDDERS_SHARE_PHONE: 'hai nhà thầu cùng số điện thoại',
  BIDDERS_SHARE_EMAIL: 'hai nhà thầu cùng thư điện tử',
  BIDDERS_SHARE_REPRESENTATIVE: 'hai nhà thầu cùng người đại diện',
  BIDDERS_SHARE_OWNER: 'hai nhà thầu cùng chủ sở hữu',
  BIDDERS_SHARE_BANK_ACCOUNT: 'hai nhà thầu cùng tài khoản',
  BIDDERS_CROSS_OWNERSHIP: 'sở hữu chéo giữa hai nhà thầu',
  BIDDER_IS_OWNER_ORGANISATION: 'nhà thầu chính là chủ đầu tư',
  BIDDER_CROSS_OWNERSHIP_WITH_OWNER: 'sở hữu chéo giữa nhà thầu và chủ đầu tư',
  BIDDER_SHARES_OWNER_WITH_OWNER: 'nhà thầu và chủ đầu tư cùng chủ sở hữu',
  PERSON_REPRESENTS_BIDDER: 'thành viên là người đại diện của nhà thầu',
  PERSON_OWNS_BIDDER: 'thành viên là chủ sở hữu của nhà thầu',
  RELATIVE_REPRESENTS_BIDDER: 'người thân của thành viên là người đại diện của nhà thầu',
  RELATIVE_OWNS_BIDDER: 'người thân của thành viên là chủ sở hữu của nhà thầu',
  PERSON_HOLDS_SHARES_IN_BIDDER: 'thành viên nắm cổ phần của nhà thầu',
  FORMER_OFFICIAL_OF_BIDDER: 'cựu cán bộ trong thời hạn hạn chế làm việc cho nhà thầu',
  ADVISER_OF_BIDDER: 'thành viên là tư vấn của nhà thầu',
};

const fill = (template: string, params: Readonly<Record<string, string | number>>): string => template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));

export const VND2A_TEXT = {
  findingTitle: (code: string, kind: string): string => fill('Gói {code}: {label}', { code, label: KIND_LABELS[kind] ?? kind }),
  findingDetail: (strength: string, since: string): string => fill('Phát hiện {strength} chưa có quyết định, kiểm tra ngày {since}', { strength: strength === 'STRONG' ? 'mạnh' : 'trung bình', since }),
  capacityTitle: (name: string): string => fill('Nhà thầu {name} có tín hiệu tài chính hoặc tải', { name }),
  capacityDetail: (finance: string, load: string): string => fill('Chỉ tiêu tài chính: {finance}; tải: {load}', { finance, load }),
  financeLabel: { MEETS: 'đạt', BELOW: 'dưới ngưỡng', INSUFFICIENT_DATA: 'không đủ dữ liệu' } as Readonly<Record<string, string>>,
  loadLabel: { WITHIN: 'trong năng lực', OVER: 'vượt năng lực', NO_DATA: 'chưa có doanh thu để so' } as Readonly<Record<string, string>>,
} as const;
