import '../../core/l10n/string_table.dart';

/// The words shared by the screens that read and show data: where it came from and how old it is (BR-MOB-01), and the
/// way amounts are written. Nothing here says the data is the newest: a copy kept on the device says the moment it
/// describes, and nothing more.
const StringTable readSupportStrings = StringTable(
  vi: <String, String>{
    'mob.read.asOf.line': 'Số liệu tại {time}',
    'mob.read.fetched.line': 'Đã tải lúc {time}',
    'mob.read.saved.asOf': 'Không kết nối được máy chủ. Đang hiển thị dữ liệu đã lưu trên máy, số liệu tại {time}.',
    'mob.read.saved.fetched': 'Không kết nối được máy chủ. Đang hiển thị dữ liệu đã lưu trên máy lúc {time}.',
    'mob.read.saved.readOnly': 'Số tiền chỉ để tham khảo, không sửa được.',
    'mob.read.stale.line': 'Bản lưu đã quá {hours} giờ. Hãy kết nối mạng để kiểm tra lại.',
    'mob.read.refresh.action': 'Làm mới',
    'mob.read.refreshing.label': 'Đang tải lại',
    'mob.read.money.millions': '{value} triệu đồng',
    'mob.read.money.dong': '{value} đồng',
    'mob.read.money.none': 'Chưa có số liệu',
  },
  en: <String, String>{
    'mob.read.asOf.line': 'Figures as of {time}',
    'mob.read.fetched.line': 'Loaded at {time}',
    'mob.read.saved.asOf': 'The server cannot be reached. Showing the copy kept on this device, as of {time}.',
    'mob.read.saved.fetched': 'The server cannot be reached. Showing the copy kept on this device from {time}.',
    'mob.read.saved.readOnly': 'Amounts are reference data and cannot be edited.',
    'mob.read.stale.line': 'This copy is older than {hours} hours. Connect to check it again.',
    'mob.read.refresh.action': 'Refresh',
    'mob.read.refreshing.label': 'Reloading',
    'mob.read.money.millions': '{value} million dong',
    'mob.read.money.dong': '{value} dong',
    'mob.read.money.none': 'No figure yet',
  },
);
