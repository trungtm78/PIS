import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/l10n/string_table.dart';
import 'package:machvon_mobile/features/command_support/command_outcome.dart';
import 'package:machvon_mobile/features/site_diary/diary_commands.dart';
import 'package:machvon_mobile/features/site_diary/diary_labels.dart';
import 'package:machvon_mobile/features/site_diary/diary_models.dart';
import 'package:machvon_mobile/features/site_diary/diary_strings.dart';

import '../../support/widget_host.dart';

Future<BuildContext> _context(WidgetTester tester, Locale locale) async {
  late BuildContext captured;
  await tester.pumpWidget(hostWidget(Builder(builder: (BuildContext context) {
    captured = context;
    return const SizedBox();
  }), locale: locale, tables: <StringTable>[diaryStrings]));
  return captured;
}

void _allWords(List<String> words) {
  for (final String word in words) {
    expect(word, isNotEmpty);
    expect(word.startsWith('mob.'), isFalse, reason: 'a key shows where words should: $word');
  }
  expect(words.toSet(), hasLength(words.length), reason: 'two different cases read the same');
}

void main() {
  for (final Locale locale in const <Locale>[Locale('vi'), Locale('en')]) {
    testWidgets('UI-MOB-61 UI-MOB-62 every status, weather, role, method, problem and refusal of the diary is in words (${locale.languageCode})', (WidgetTester tester) async {
      final BuildContext context = await _context(tester, locale);
      _allWords(<String>[for (final String s in <String>['ACTIVE', 'CANCELLED', 'CLOSED', 'COMPLETED', 'DRAFT', 'IN_REVIEW', 'SIGNED', 'SUSPENDED', 'TERMINATED']) contractStatusText(context, s)]);
      expect(contractStatusText(context, 'ODD'), 'ODD', reason: 'a status the phone does not know is shown as the server gave it');
      _allWords(<String>[for (final String s in <String>['DRAFT', 'CONTRACTOR_SIGNED', 'SUPERVISED', 'OWNER_CONFIRMED', 'LOCKED', 'SUPERSEDED']) diaryStatusText(context, s)]);
      _allWords(<String>[for (final String s in <String>['SUNNY', 'CLOUDY', 'RAIN', 'HEAVY_RAIN', 'STORM', 'HOT', 'COLD']) weatherText(context, s)]);
      expect(weatherText(context, 'FOG'), 'FOG');
      _allWords(<String>[for (final String s in <String>['CONTRACTOR', 'SUPERVISOR', 'OWNER']) roleText(context, s)]);
      _allWords(<String>[for (final String s in <String>['IN_APP_OTP', 'IN_APP_WEBAUTHN', 'DIGITAL_CERT']) methodText(context, s)]);
      _allWords(<String>[for (final DiaryProblem p in DiaryProblem.values) diaryProblemText(context, p)]);
      _allWords(<String>[for (final CorrectionProblem p in CorrectionProblem.values) correctionProblemText(context, p)]);
      _allWords(<String>[for (final DiaryRefusal r in DiaryRefusal.values) refusalText(context, r)]);
    });
  }

  group('UI-MOB-62 UAT-AC366 UAT-AC356 the refusals of the server are told by their code', () {
    DiaryRefusal of(String code, {String? detail, Map<String, Object?> extensions = const <String, Object?>{}}) =>
        refusalOf(CommandRefused(code, status: 422, detail: detail, extensions: extensions));

    test('a diary in the wrong state says why: a correction already open, a content that changed, or just the state', () {
      expect(of('DIARY_STATE_INVALID', extensions: <String, Object?>{'reason': 'CORRECTION_OPEN'}), DiaryRefusal.correctionOpen);
      expect(of('DIARY_STATE_INVALID', extensions: <String, Object?>{'reason': 'CONTENT_CHANGED'}), DiaryRefusal.contentChanged);
      expect(of('DIARY_STATE_INVALID'), DiaryRefusal.diaryState);
    });

    test('each rule the server holds has its own words, and a signature as a role that is not the reader\'s is told apart from a missing right', () {
      expect(of('DIARY_DAY_EXISTS'), DiaryRefusal.dayExists);
      expect(of('DIARY_SYNC_CONFLICT'), DiaryRefusal.syncConflict);
      expect(of('ALREADY_SIGNED'), DiaryRefusal.alreadySigned);
      expect(of('SIGNATURE_METHOD_NOT_ACCEPTED'), DiaryRefusal.methodNotAccepted);
      expect(of('CONTRACT_STATE_INVALID'), DiaryRefusal.contractState);
      expect(of('PERMIT_GATE_BLOCKED'), DiaryRefusal.permitGate);
      expect(of('VERSION_CONFLICT'), DiaryRefusal.versionConflict);
      expect(of('MFA_REQUIRED'), DiaryRefusal.stepUp);
      expect(of('LICENSE_EXPIRED'), DiaryRefusal.licenseExpired);
      for (final String code in <String>['VALIDATION_FAILED', 'INVALID_REQUEST', 'FIELD_NOT_ALLOWED']) {
        expect(of(code), DiaryRefusal.validation);
      }
      expect(of('RESOURCE_NOT_FOUND'), DiaryRefusal.notFound);
      expect(of('SCOPE_DENIED', detail: 'signer_role'), DiaryRefusal.notYourRole);
      expect(of('SCOPE_DENIED'), DiaryRefusal.denied);
      expect(of('PERMISSION_DENIED'), DiaryRefusal.denied);
      expect(of('ENTITLEMENT_DENIED'), DiaryRefusal.denied);
      expect(of('SESSION_EXPIRED'), DiaryRefusal.sessionEnded);
      expect(of('SOMETHING_NEW'), DiaryRefusal.general);
    });
  });
}
