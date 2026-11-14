import 'package:flutter/widgets.dart';

import '../../core/l10n/app_strings.dart';

/// The names people read for the codes a workflow carries (roles, kinds of evidence, legal document types, grades, the shipped templates). A template of a province
/// may use a code this table has no name for: the code itself is then shown, never a guessed name.
String _key(String code) {
  final List<String> parts = code.trim().toLowerCase().split(RegExp('[^a-z0-9]+')).where((String part) => part.isNotEmpty).toList();
  if (parts.isEmpty) return '';
  return parts.first + parts.skip(1).map((String part) => part[0].toUpperCase() + part.substring(1)).join();
}

String _named(BuildContext context, String key, String fallback) {
  final String text = context.t(key);
  return text == key ? fallback : text;
}

String pwfRoleName(BuildContext context, String code) => _named(context, 'mob.pwf6.role.${_key(code)}', code);
String pwfEvidenceKindName(BuildContext context, String code) => _named(context, 'mob.pwf6.evidence.${_key(code)}', code);
String pwfDocTypeName(BuildContext context, String code) => _named(context, 'mob.pwf6.doc.${_key(code)}', code);
String pwfGradeName(BuildContext context, String code) => _named(context, 'mob.pwf6.grade.${_key(code)}', code);

/// "System default" for version 0 of a rule (the shipped default has no version of the tenant), else "version N".
String pwfVersionText(BuildContext context, int version) => version == 0 ? context.t('mob.pwf6.version.default') : context.t('mob.pwf6.version.numbered', <String, Object>{'version': version});
