import 'package:flutter/material.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/features/site_diary/diary_models.dart';
import 'package:machvon_mobile/features/site_diary/diary_service.dart';
import 'package:machvon_mobile/features/site_diary/site_diary_feature.dart' as site_diary;

import '../../support/harness.dart' show FakeSession;
import '../field_issues/field_world.dart';

/// A page of a register as the server answers it.
Map<String, Object?> page(List<Object?> items) => <String, Object?>{'items': items, 'next_cursor': null, 'as_of': '2026-11-03T02:00:00Z'};

/// A contract as the register shows it to a contractor who was invited.
Map<String, Object?> contractRow(String id, String code, {String status = 'ACTIVE', String? title}) => <String, Object?>{
      'id': id,
      'code': code,
      'title': title ?? 'Đường tỉnh ĐT.A1 km0-km12',
      'status': status,
      'type': 'UNIT_PRICE',
      'project_id': 'p-1',
      'project_code': 'PRJ-A-001',
      'project_name': 'Đường tỉnh ĐT.A1',
      'contractor_id': 'nt-1',
      'contractor_name': 'Công ty TNHH Xây dựng Minh An',
      'completion_due': '2027-03-31',
      'version': 3,
    };

/// A line of the bill of quantities of a contract.
Map<String, Object?> boqRow(String id, {String? milestone, String? due, String revision = 'EFFECTIVE', String description = 'Đào đất'}) => <String, Object?>{
      'id': id,
      'contract_id': 'c-1',
      'revision_status': revision,
      'line_no': 1,
      'description': description,
      'milestone_code': milestone,
      'milestone_due_on': due,
    };

/// A diary as the server shows it to the contractor.
Map<String, Object?> diaryRow(
  String id, {
  String contractId = 'c-1',
  String date = '2026-11-03',
  String status = 'DRAFT',
  int version = 2,
  Map<String, Object?>? content,
  bool revise = true,
  bool sign = true,
  bool correct = false,
  List<Object?> signatures = const <Object?>[],
  List<Object?> conflicts = const <Object?>[],
  String? correctionOf,
}) =>
    <String, Object?>{
      'id': id,
      'diary_no': 'D-A-0003',
      'contract': <String, Object?>{'id': contractId, 'code': 'HD-A-001', 'status': 'ACTIVE'},
      'record_date': date,
      'status': status,
      'content': content ?? <String, Object?>{'summary': 'Đào móng trụ T3', 'workforce_count': 12},
      'weather_code': null,
      'workforce_count': 12,
      'signatures': signatures,
      'conflicts': conflicts,
      'signable_roles': sign ? <String>['CONTRACTOR'] : <String>[],
      'signature_value': <String, Object?>{'cxn': 'CXN-EXE-05', 'awaiting_confirmation': true},
      'actions': <String, Object?>{'revise': revise, 'contractorSign': sign, 'correct': correct, 'resolveConflict': false},
      'version': version,
      if (correctionOf != null) 'correction_of_id': correctionOf,
    };

Map<String, Object?> signatureRow({String role = 'CONTRACTOR', bool valid = true}) =>
    <String, Object?>{'role': role, 'signer_name': 'Lê Văn C', 'method': 'IN_APP_OTP', 'legal_effect': 'INTERNAL_RECORD', 'signed_at': '2026-11-03T03:00:00Z', 'valid': valid};

/// The reads of one contract and its diaries.
void answerDiaries(FieldServer server, {List<Map<String, Object?>> diaries = const <Map<String, Object?>>[], String contractId = 'c-1', String code = 'HD-A-001'}) {
  server.api
    ..on('GET', '/resources/contract/$contractId', (_) => contractRow(contractId, code))
    ..on('GET', '/resources/site_diary', (_) => page(diaries));
  for (final Map<String, Object?> diary in diaries) {
    server.api.on('GET', '/resources/site_diary/${diary['id']}', (_) => diary);
  }
}

/// A phone on the site diary screens.
/// The diary service of a phone whose store of drafts stops taking writes when [failing] is set: the write that follows a change
/// fails, as on a phone with no room left.
class FailingDiaryService extends DiaryService {
  FailingDiaryService(super.ref);

  bool failing = false;

  @override
  Future<String> save(DiaryDraft draft, {String draftId = ''}) =>
      failing ? Future<String>.error(StateError('the store is full')) : super.save(draft, draftId: draftId);
}

Future<void> openDiaryApp(WidgetTester tester, FieldWorld world, String location, {FakeSession? session, List<Override> overrides = const <Override>[]}) async {
  await world.open(tester, location, extra: <MobileFeature>[site_diary.feature], session: session, overrides: overrides);
  await settleReal(tester, rounds: 10);
}

extension DiaryWorldTools on FieldWorld {
  /// Types into the field with this label.
  Future<void> typeInto(WidgetTester tester, String label, String text) async {
    final Finder field = find.widgetWithText(TextField, label);
    await tester.ensureVisible(field.first);
    await tester.pump();
    await tester.enterText(field.first, text);
    await settleReal(tester, rounds: 6);
  }
}
