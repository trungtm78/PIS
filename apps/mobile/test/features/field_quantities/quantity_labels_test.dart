import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/l10n/string_table.dart';
import 'package:machvon_mobile/features/field_quantities/inspection_commands.dart';
import 'package:machvon_mobile/features/field_quantities/inspection_labels.dart';
import 'package:machvon_mobile/features/field_quantities/inspection_models.dart';
import 'package:machvon_mobile/features/field_quantities/quantity_commands.dart';
import 'package:machvon_mobile/features/field_quantities/quantity_labels.dart';
import 'package:machvon_mobile/features/field_quantities/quantity_models.dart';
import 'package:machvon_mobile/features/field_quantities/quantity_strings.dart';

import '../../support/widget_host.dart';

Future<BuildContext> _context(WidgetTester tester, Locale locale) async {
  late BuildContext captured;
  await tester.pumpWidget(hostWidget(Builder(builder: (BuildContext context) {
    captured = context;
    return const SizedBox();
  }), locale: locale, tables: <StringTable>[quantityStrings]));
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
    testWidgets('UI-MOB-63 UI-MOB-64 every status, problem, outcome and refusal of the two screens is in words (${locale.languageCode})', (WidgetTester tester) async {
      final BuildContext context = await _context(tester, locale);
      _allWords(<String>[for (final QuantityProblem p in QuantityProblem.values) quantityProblemText(context, p)]);
      _allWords(<String>[for (final String s in <String>['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'SUPERSEDED']) measurementStatusText(context, s)]);
      _allWords(<String>[for (final QuantityRefusal r in QuantityRefusal.values) quantityRefusalText(context, r)]);
      _allWords(<String>[for (final String s in <String>['REQUESTED', 'SCHEDULED', 'RESULT_RECORDED', 'CANCELLED']) inspectionStatusText(context, s)]);
      _allWords(<String>[for (final String s in <String>['PASS', 'FAIL', 'NA']) outcomeText(context, s)]);
      _allWords(<String>[for (final String s in <String>['PASS', 'FAIL', 'CONDITIONAL']) resultText(context, s)]);
      _allWords(<String>[for (final String s in <String>['CRITICAL', 'MAJOR', 'MINOR']) severityOfNcrText(context, s)]);
      expect(<String>{for (final ResultProblem p in ResultProblem.values) resultProblemText(context, p)}.length, ResultProblem.values.length);
      expect(<String>{for (final RequestProblem p in RequestProblem.values) requestProblemText(context, p)}.length, 3, reason: 'a missing record number and a missing file read alike');
      _allWords(<String>[for (final InspectionRefusal r in InspectionRefusal.values) inspectionRefusalText(context, r)]);
    });
  }

  testWidgets('AC-ST-MOB-021-2 a quantity is shown with the digits of the language and is never turned into a float', (WidgetTester tester) async {
    final BuildContext vi = await _context(tester, const Locale('vi'));
    expect(quantityLabel(vi, '1234.5'), '1.234,5');
    expect(quantityLabel(vi, 'not a number'), 'not a number');
    final BuildContext en = await _context(tester, const Locale('en'));
    expect(quantityLabel(en, '1234.5'), '1,234.5');
  });

  group('AC-ST-MOB-021-2 AC-ST-MOB-021-3 the refusals of the server are told by their code', () {
    test('a quantity: each rule of the measurement has its own refusal, and the reason tells a period taken from a state', () {
      const Map<String, QuantityRefusal> codes = <String, QuantityRefusal>{
        'QUANTITY_EXCEEDS_BOQ': QuantityRefusal.exceeds,
        'CUMULATIVE_DECREASE_WITHOUT_CORRECTION': QuantityRefusal.decrease,
        'MEASUREMENT_REFERENCE_DUPLICATE': QuantityRefusal.duplicateReference,
        'REVISION_NOT_EFFECTIVE': QuantityRefusal.revisionNotEffective,
        'PERMIT_GATE_BLOCKED': QuantityRefusal.permitGate,
        'MEASUREMENT_IN_ACTIVE_ACCEPTANCE': QuantityRefusal.inAcceptance,
        'EVIDENCE_REQUIRED': QuantityRefusal.evidenceRequired,
        'MEASUREMENT_STATE_INVALID': QuantityRefusal.measurementState,
        'VERSION_CONFLICT': QuantityRefusal.versionConflict,
        'MFA_REQUIRED': QuantityRefusal.stepUp,
        'PERIOD_LOCKED': QuantityRefusal.periodLocked,
        'LICENSE_EXPIRED': QuantityRefusal.licenseExpired,
        'VALIDATION_FAILED': QuantityRefusal.validation,
        'INVALID_REQUEST': QuantityRefusal.validation,
        'FIELD_NOT_ALLOWED': QuantityRefusal.validation,
        'RESOURCE_NOT_FOUND': QuantityRefusal.notFound,
        'SCOPE_DENIED': QuantityRefusal.denied,
        'PERMISSION_DENIED': QuantityRefusal.denied,
        'ENTITLEMENT_DENIED': QuantityRefusal.denied,
        'SESSION_EXPIRED': QuantityRefusal.sessionEnded,
        'SOMETHING_NEW': QuantityRefusal.general,
      };
      codes.forEach((String code, QuantityRefusal expected) => expect(refusalOfCode(code), expected, reason: code));
      expect(refusalOfCode('MEASUREMENT_STATE_INVALID', reason: 'PERIOD_ALREADY_MEASURED'), QuantityRefusal.periodTaken);
    });

    test('an inspection: a critical non-conformance that is open is told apart from every other refusal', () {
      const Map<String, InspectionRefusal> codes = <String, InspectionRefusal>{
        'OPEN_CRITICAL_NCR': InspectionRefusal.openCriticalNcr,
        'INSPECTION_NOT_PASSED': InspectionRefusal.notPassed,
        'CONTRACT_STATE_INVALID': InspectionRefusal.contractState,
        'QUALITY_ACCEPTANCE_STATE_INVALID': InspectionRefusal.acceptanceState,
        'INSPECTION_STATE_INVALID': InspectionRefusal.inspectionState,
        'CHECKLIST_INCOMPLETE': InspectionRefusal.checklistIncomplete,
        'VERSION_CONFLICT': InspectionRefusal.versionConflict,
        'MFA_REQUIRED': InspectionRefusal.stepUp,
        'VALIDATION_FAILED': InspectionRefusal.validation,
        'INVALID_REQUEST': InspectionRefusal.validation,
        'FIELD_NOT_ALLOWED': InspectionRefusal.validation,
        'RESOURCE_NOT_FOUND': InspectionRefusal.notFound,
        'SCOPE_DENIED': InspectionRefusal.denied,
        'PERMISSION_DENIED': InspectionRefusal.denied,
        'ENTITLEMENT_DENIED': InspectionRefusal.denied,
        'SESSION_EXPIRED': InspectionRefusal.sessionEnded,
        'SOMETHING_NEW': InspectionRefusal.general,
      };
      codes.forEach((String code, InspectionRefusal expected) => expect(inspectionRefusalOf(code), expected, reason: code));
    });
  });
}
