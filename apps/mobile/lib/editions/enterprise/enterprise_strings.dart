import '../../core/l10n/string_table.dart';

/// The name of the enterprise product in Vietnamese: the title of the application and the word the overlay below says in place of the public
/// name. `npm run edition:check` holds it equal to the product name of the manifest of `packages/edition-enterprise`.
const String kEnterpriseProductNameVi = 'Phần mềm quản lý đầu tư xây dựng';

/// The terminology overlay of the enterprise edition on the phone: the keys of the base strings that name the product. The manifest lists the
/// same keys (`terminology.mobile`), the check compares both lists and the catalogue refuses a key the base does not declare.
const StringTable kEnterpriseStrings = StringTable(
  vi: <String, String>{
    'mob.account.biometric.reason':
        'Bật mở khóa Phần mềm quản lý đầu tư xây dựng bằng sinh trắc học',
    'mob.alert.source.treasuryRecon.label': 'Đối chiếu số liệu đã chốt',
    'mob.home.context.cutoff.label': 'Số liệu chốt đến ngày',
    'mob.home.leader.title': 'Trang chủ điều hành',
    'mob.home.tile.metric.disbursed': 'Giải ngân lũy kế',
    'mob.home.tile.metric.planPm': 'Kế hoạch vốn được giao',
    'mob.home.tile.metric.ratePm': 'Tỷ lệ theo kế hoạch vốn được giao',
    'mob.home.tile.nullReason.treasuryNone': 'Chưa ghi nhận giải ngân',
    'mob.prj.list.work.treasury': 'Đối soát số liệu đã chốt',
    'mob.release.upgrade.failed': 'Chưa mở được trang cập nhật. Thử lại hoặc tìm Phần mềm quản lý đầu tư xây dựng trong cửa hàng ứng dụng.',
    'mob.signIn.unlock.reason': 'Mở khóa Phần mềm quản lý đầu tư xây dựng',
    'mob.welcome.logo.label': 'Biểu trưng Phần mềm quản lý đầu tư xây dựng',
    'mob.welcome.title.text': 'Chào mừng đến Phần mềm quản lý đầu tư xây dựng',
  },
  en: <String, String>{
    'mob.account.biometric.reason': 'Turn on biometric unlock for the Construction Investment Management Software',
    'mob.alert.source.treasuryRecon.label': 'Reconciliation of the closed figures',
    'mob.home.context.cutoff.label': 'Closed figures as of',
    'mob.home.leader.title': 'Executive home',
    'mob.home.tile.metric.disbursed': 'Cumulative disbursement',
    'mob.home.tile.metric.planPm': 'Assigned capital plan',
    'mob.home.tile.metric.ratePm': 'Rate on the assigned capital plan',
    'mob.home.tile.nullReason.treasuryNone': 'No disbursement recorded',
    'mob.prj.list.work.treasury': 'Reconciliation of the closed figures',
    'mob.release.upgrade.failed': 'The update page could not be opened. Try again or look for the Construction Investment Management Software in the app store.',
    'mob.signIn.unlock.reason':
        'Unlock the Construction Investment Management Software',
    'mob.welcome.logo.label':
        'Construction Investment Management Software logo',
    'mob.welcome.title.text':
        'Welcome to the Construction Investment Management Software',
  },
);
