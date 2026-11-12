import '../../core/edition/edition_brand.g.dart';
import '../../core/l10n/string_table.dart';

/// The strings of the welcome screen MOB-01.
const StringTable tenantDiscoveryStrings = StringTable(
  vi: <String, String>{
    'mob.welcome.title.text': 'Chào mừng đến $kPublicProductNameVi',
    'mob.welcome.body.text': 'Nhập mã tổ chức hoặc tên miền để ứng dụng tải đúng cấu hình đăng nhập và giao diện của tổ chức bạn.',
    'mob.welcome.field.label': 'Mã tổ chức hoặc tên miền',
    'mob.welcome.field.hint': 'ví dụ minh-ha hoặc minhha.machvon.vn',
    'mob.welcome.invalid.text': 'Mã hoặc tên miền chỉ gồm chữ thường, số, dấu gạch ngang và dấu chấm.',
    'mob.welcome.notFound.text': 'Không tìm thấy tổ chức với mã này. Kiểm tra lại mã hoặc tên miền.',
    'mob.welcome.rateLimited.text': 'Bạn đã thử quá nhiều lần. Thử lại sau {seconds} giây.',
    'mob.welcome.submit.action': 'Tiếp tục',
    'mob.welcome.last.action': 'Dùng lại {code}',
    'mob.welcome.logo.label': 'Biểu trưng $kPublicProductNameVi',
    'mob.welcome.domain.label': 'Tên miền',
  },
  en: <String, String>{
    'mob.welcome.title.text': 'Welcome to the $kPublicProductNameEn',
    'mob.welcome.body.text': 'Enter your organisation code or domain so the app loads the right sign-in settings and look for your organisation.',
    'mob.welcome.field.label': 'Organisation code or domain',
    'mob.welcome.field.hint': 'for example minh-ha or minhha.machvon.vn',
    'mob.welcome.invalid.text': 'A code or domain has only lower-case letters, digits, hyphens and dots.',
    'mob.welcome.notFound.text': 'No organisation was found for this code. Check the code or domain.',
    'mob.welcome.rateLimited.text': 'Too many attempts. Try again in {seconds} seconds.',
    'mob.welcome.submit.action': 'Continue',
    'mob.welcome.last.action': 'Use {code} again',
    'mob.welcome.logo.label': '$kPublicProductNameEn logo',
    'mob.welcome.domain.label': 'Domain',
  },
);
