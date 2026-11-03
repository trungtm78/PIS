import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/features/field_quantities/field_quantities_feature.dart' as quantities;

import '../../support/harness.dart' show FakeSession;
import '../field_issues/field_world.dart';
import '../site_diary/diary_fixtures.dart';

export '../site_diary/diary_fixtures.dart' show contractRow, page;

/// A line of the bill of quantities of the revision in force that takes a quantity.
Map<String, Object?> itemRow(String id, String key, {String quantity = '8000', String unit = 'm3', String description = 'Đào đất', bool recordable = true, String revision = 'EFFECTIVE'}) => <String, Object?>{
      'id': id,
      'contract_id': 'c-1',
      'contract_revision_id': 'r-1',
      'revision_status': revision,
      'line_no': 1,
      'business_key': key,
      'description': description,
      'unit_code': unit,
      'quantity': quantity,
      if (recordable) 'boq_item_id': 'item-$id',
    };

Map<String, Object?> periodRow(String id, String code) => <String, Object?>{'id': id, 'code': code, 'status': 'OPEN'};

/// A quantity that was recorded.
Map<String, Object?> measurementRow(String id, {String item = 'B01', String status = 'DRAFT', String quantity = '120.5', String period = '2026-11', String remaining = '7879.5', int version = 1, bool submit = true, int evidence = 0}) =>
    <String, Object?>{
      'id': id,
      'contract': <String, Object?>{'id': 'c-1', 'code': 'HD-A-001', 'status': 'ACTIVE'},
      'boq_item': <String, Object?>{'id': 'item-l-1', 'business_key': item, 'description': 'Đào đất', 'unit_code': 'm3'},
      'period': <String, Object?>{'id': 'per-1', 'code': period},
      'quantity_period': quantity,
      'remaining_quantity': remaining,
      'status': status,
      'reference_no': 'BB-014',
      'evidence_refs': List<Object?>.generate(evidence, (int i) => <String, Object?>{'document_version_id': 'doc-$i'}),
      'actions': <String, Object?>{'submit': submit, 'decide': false, 'correct': false},
      'version': version,
    };

/// An inspection of the contract.
Map<String, Object?> inspectionRow(String id, {String status = 'SCHEDULED', String? result, bool record = true, String type = 'CONCEALED_WORK', int version = 3, List<String> items = const <String>['Cốt thép đúng chủng loại', 'Khoảng cách thép đai']}) => <String, Object?>{
      'id': id,
      'inspection_no': 'INS-A-0002',
      'contract': <String, Object?>{'id': 'c-1', 'code': 'HD-A-001', 'status': 'ACTIVE'},
      'inspection_type': type,
      'title': 'Nghiệm thu cốt thép móng T3',
      'location_text': 'Trụ T3, km3+200',
      'status': status,
      'result': result,
      'requested_for': '2026-11-03',
      'checklist': <Object?>[for (int i = 0; i < items.length; i += 1) <String, Object?>{'code': 'K${i + 1}', 'label': items[i]}],
      'actions': <String, Object?>{'schedule': false, 'record': record, 'cancel': false},
      'version': version,
    };

Map<String, Object?> ncrRow(String id, {String severity = 'CRITICAL', String status = 'OPEN', bool blocks = true, String inspection = 'i-1'}) => <String, Object?>{
      'id': id,
      'ncr_no': 'NCR-100',
      'title': 'Cốt thép sai chủng loại',
      'severity': severity,
      'status': status,
      'blocks_acceptance': blocks,
      'inspection_id': inspection,
    };

/// The reads of MOB-63 for one contract.
void answerQuantities(FieldServer server, {List<Map<String, Object?>>? items, Object? periods, List<Map<String, Object?>> measurements = const <Map<String, Object?>>[]}) {
  server.api
    ..on('GET', '/resources/contract/c-1', (_) => contractRow('c-1', 'HD-A-001'))
    ..on('GET', '/resources/boq_line', (_) => page(items ?? <Map<String, Object?>>[itemRow('l-1', 'B01'), itemRow('l-2', 'B02', quantity: '2500', unit: 'm3', description: 'Bê tông', recordable: false)]))
    ..on('GET', '/resources/measurement', (_) => page(measurements));
  if (periods == null) {
    server.api.on('GET', '/resources/reporting_period', (_) => page(<Object?>[periodRow('per-1', '2026-11'), periodRow('per-2', '2026-10')]));
  } else if (periods == false) {
    server.api.refuse('GET', '/resources/reporting_period', 403, 'SCOPE_DENIED');
  }
}

/// The reads of MOB-64 for one contract.
void answerInspections(FieldServer server, {List<Map<String, Object?>>? inspections, List<Map<String, Object?>> ncrs = const <Map<String, Object?>>[]}) {
  server.api
    ..on('GET', '/resources/contract/c-1', (_) => contractRow('c-1', 'HD-A-001'))
    ..on('GET', '/inspections', (_) => page(inspections ?? <Map<String, Object?>>[inspectionRow('i-1')]))
    ..on('GET', '/resources/quality_nonconformance', (_) => page(ncrs));
}

Future<void> openQuantityApp(WidgetTester tester, FieldWorld world, String location, {FakeSession? session}) async {
  await world.open(tester, location, extra: <MobileFeature>[quantities.feature], session: session);
  await settleReal(tester, rounds: 10);
}
