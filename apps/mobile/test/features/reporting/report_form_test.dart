import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/format/format.dart';
import 'package:machvon_mobile/features/reporting/model/estimate_entry.dart';
import 'package:machvon_mobile/features/reporting/model/report_cells.dart';
import 'package:machvon_mobile/features/reporting/model/report_context.dart';
import 'package:machvon_mobile/features/reporting/model/report_form.dart';
import 'package:machvon_mobile/features/reporting/model/report_review.dart';
import 'package:machvon_mobile/features/reporting/model/report_view.dart';
import 'package:machvon_mobile/features/reporting/screens/funding_screen.dart' show isNotApplicable;

import 'reporting_fixtures.dart';

Finding? find(List<Finding> findings, String code, [String? field]) {
  for (final Finding finding in findings) {
    if (finding.code == code && (field == null || finding.field == field)) return finding;
  }
  return null;
}

void main() {
  group('TK-MOB-011-5 amounts are typed as whole dong with any separator and read exactly', () {
    test('the separators of thousands are dropped; a sign, a fraction or letters make it not an amount', () {
      expect(digitsOf('1.250.000.000'), '1250000000');
      expect(digitsOf('1,250,000,000'), '1250000000');
      expect(digitsOf(' 1 250 000 000 '), '1250000000');
      expect(digitsOf('0'), '0');
      expect(digitsOf('007'), '7');
      expect(digitsOf('-5'), isNull);
      expect(digitsOf('12a'), isNull);
      expect(digitsOf(''), isNull);
      expect(digitsOf('1' * 25), isNull);
      expect(digitsOf('9' * 24), '9' * 24);
    });

    test('a total counts exactly what is an amount and nothing else, with no rounding', () {
      expect(sumTyped(<String>['1.000', 'x', '2,000', '']), '3000');
      expect(sumTyped(<String>['999999999999999999999999', '1']), '1000000000000000000000000');
    });
  });

  group('AC-ST-MOB-011-2 UAT-AC240 the CTMTQG is inside its cell and is never a cell of the total', () {
    test('FX-DIS-001: 100/200/30/70/0/20 million with 40 million of CTMTQG in the first cell total 420 million, not 460', () {
      final ReportForm form = completeForm();
      expect(sumTyped(<String>[for (final CellKey key in kCells) form.cell(key).cumulative]), '420000000');
      expect(sumTyped(<String>[for (final CellKey key in kCells) form.cell(key).ctmtqg]), '40000000');
      expect(sumTyped(<String>[for (final CellKey key in kCells) form.cell(key).cumulative]), isNot('460000000'));
    });

    test('central 400 million with CTMTQG 40 million as a subset and 20 million local give 420 million', () {
      ReportForm form = const ReportForm(projectId: projectId, periodId: periodId);
      form = form.withCell(const CellKey('CURRENT_YEAR', 'CENTRAL'), const CellEntry(cumulative: '400.000.000', ctmtqg: '40.000.000'));
      form = form.withCell(const CellKey('CURRENT_YEAR', 'LOCAL'), const CellEntry(cumulative: '20.000.000'));
      expect(sumTyped(<String>[for (final CellKey key in kCells) form.cell(key).cumulative]), '420000000');
    });

    test('the part of a cell can be equal to the cell but not larger; the other sources have no CTMTQG at all', () {
      ReportForm form = completeForm();
      expect(reviewForm(form, null).where((Finding f) => f.isError), isEmpty);
      form = form.withCell(const CellKey('CURRENT_YEAR', 'CENTRAL'), form.cell(const CellKey('CURRENT_YEAR', 'CENTRAL')).copyWith(ctmtqg: '100000000'));
      expect(find(reviewForm(form, null), 'SUBSET_EXCEEDS_PARENT'), isNull);
      form = form.withCell(const CellKey('CURRENT_YEAR', 'CENTRAL'), form.cell(const CellKey('CURRENT_YEAR', 'CENTRAL')).copyWith(ctmtqg: '100000001'));
      final Finding? exceeds = find(reviewForm(form, null), 'SUBSET_EXCEEDS_PARENT');
      expect(exceeds!.field, 'funding_lines[0].ctmtqg_subset_vnd');
      expect(exceeds.values, <String, String?>{'parent_vnd': '100000000', 'subset_vnd': '100000001'});
      expect(exceeds.blocksSave, isTrue);

      form = completeForm().withCell(const CellKey('OTHER', 'CENTRAL'), const CellEntry(cumulative: '5', ctmtqg: '1'));
      expect(find(reviewForm(form, null), 'CTMTQG_NOT_ALLOWED', 'funding_lines[4].ctmtqg_subset_vnd'), isNotNull);
    });

    test('a CTMTQG that is not an amount is told as such, and cells are the same cell when their source and budget are', () {
      final ReportForm form = completeForm().withCell(const CellKey('CURRENT_YEAR', 'CENTRAL'), const CellEntry(cumulative: '10', ctmtqg: 'x'));
      expect(find(reviewForm(form, null), 'CELL_INVALID', 'funding_lines[0].ctmtqg_subset_vnd')!.blocksSave, isTrue);
      expect(const CellKey('OTHER', 'LOCAL'), const CellKey('OTHER', 'LOCAL'));
      expect(const CellKey('OTHER', 'LOCAL').hashCode, const CellKey('OTHER', 'LOCAL').hashCode);
      expect(const CellKey('OTHER', 'LOCAL'), isNot(const CellKey('OTHER', 'CENTRAL')));
      expect(const CellKey('OTHER', 'LOCAL').id, 'OTHER:LOCAL');
    });

    test('the part registered for next month is judged against the registration, not against the cumulative', () {
      final ReportForm form = completeForm().withCell(const CellKey('CURRENT_YEAR', 'CENTRAL'), const CellEntry(cumulative: '100000000', ctmtqg: '40000000', nextMonth: '10', nextCtmtqg: '11'));
      expect(find(reviewForm(form, null), 'SUBSET_EXCEEDS_PARENT', 'funding_lines[0].next_month_ctmtqg_subset_vnd'), isNotNull);
    });
  });

  group('AC-ST-MOB-011-3 UAT-AC241 the cumulative is what the cells say; the change is the cumulative less the period before', () {
    test('a period before of 100 million and a cumulative of 150 million is a change of 50 million, never 250', () {
      final ReportContext context = withReference(previous: <String, String>{'CURRENT_YEAR:CENTRAL': '100000000'});
      final ReportForm form = completeForm().withCell(const CellKey('CURRENT_YEAR', 'CENTRAL'), const CellEntry(cumulative: '150000000'));
      final String? delta = deltaOf(context.reference(const CellKey('CURRENT_YEAR', 'CENTRAL')), form.cell(const CellKey('CURRENT_YEAR', 'CENTRAL')).cumulative);
      expect(delta, '50000000');
      expect(context.previousTotal, '100000000');
      expect(differenceDong('150000000', context.previousTotal!), '50000000');
      expect(differenceDong('150000000', context.previousTotal!), isNot('250000000'));
    });

    test('nothing to compare with gives no change; a fall is negative and is never shown as zero', () {
      expect(deltaOf(null, '5'), isNull);
      expect(deltaOf(const CellReference(allocated: '0'), '5'), isNull);
      expect(deltaOf(const CellReference(allocated: '0', previous: '100'), 'abc'), isNull);
      expect(deltaOf(const CellReference(allocated: '0', previous: '100'), '70'), '-30');
    });
  });

  group('TK-MOB-011-4 the review tells what the server would refuse, all at once', () {
    final CellKey first = kCells.first;
    ReportContext fallingContext() => withReference(previous: <String, String>{'CURRENT_YEAR:CENTRAL': '300000000'});

    test('a complete report has no error', () {
      expect(reviewForm(completeForm(), null).where((Finding f) => f.isError), isEmpty);
    });

    test('a blank, invalid or missing entry is an error that blocks the save, with the field the server names', () {
      ReportForm form = completeForm().withCell(first, const CellEntry(cumulative: '', nextMonth: 'x1'));
      List<Finding> findings = reviewForm(form, null);
      expect(find(findings, 'CELL_REQUIRED', 'funding_lines[0].cumulative_vnd')!.blocksSave, isTrue);
      expect(find(findings, 'CELL_INVALID', 'funding_lines[0].next_month_vnd')!.blocksSave, isTrue);
      form = completeForm().copyWith(construction: '12a', percent: '120');
      findings = reviewForm(form, null);
      expect(find(findings, 'VOLUME_INVALID', 'progress.construction_vnd'), isNotNull);
      expect(find(findings, 'PERCENT_RANGE'), isNotNull);
      expect(reviewForm(completeForm().copyWith(percent: '40,5'), null).where((Finding f) => f.isError), isEmpty);
      expect(find(reviewForm(completeForm().copyWith(percent: '40.555'), null), 'PERCENT_INVALID'), isNotNull);
      expect(reviewForm(completeForm().copyWith(percent: '100'), null).where((Finding f) => f.isError), isEmpty);
    });

    test('the volumes missing stop the sending but not the save', () {
      final List<Finding> findings = reviewForm(completeForm().copyWith(preparing: ''), null);
      final Finding missing = find(findings, 'VALIDATION_FAILED', 'progress')!;
      expect(missing.blocksSave, isFalse);
      expect(missing.isError, isTrue);
    });

    test('a fall in a cell needs an explanation of 10 to 2000 characters; the explained fall is a warning', () {
      ReportForm form = completeForm().withCell(first, const CellEntry(cumulative: '200000000', ctmtqg: '40000000', nextMonth: '1'));
      expect(find(reviewForm(form, null), 'NEGATIVE_DELTA_EXPLANATION_REQUIRED'), isNull, reason: 'without the period before the server judges it');
      List<Finding> findings = reviewForm(form, fallingContext());
      expect(find(findings, 'NEGATIVE_DELTA_EXPLANATION_REQUIRED', 'negative_delta_explanation'), isNotNull);
      form = form.copyWith(explanation: 'ngắn');
      findings = reviewForm(form, fallingContext());
      expect(find(findings, 'EXPLANATION_INVALID')!.blocksSave, isTrue);
      form = form.copyWith(explanation: 'Điều chỉnh sau khi đối chiếu với Kho bạc');
      findings = reviewForm(form, fallingContext());
      expect(findings.where((Finding f) => f.isError && f.code.startsWith('NEGATIVE') || f.code == 'EXPLANATION_INVALID'), isEmpty);
      final Finding explained = find(findings, 'NEGATIVE_DELTA')!;
      expect(explained.isError, isFalse);
      expect(explained.values['delta_vnd'], '-100000000');
      expect(find(reviewForm(form.copyWith(explanation: 'a' * 2001), fallingContext()), 'EXPLANATION_INVALID'), isNotNull);
      expect(find(reviewForm(form.copyWith(explanation: 'điều chỉnh \u0001 sau'), fallingContext()), 'EXPLANATION_INVALID'), isNotNull);
      expect(find(reviewForm(form.copyWith(explanation: 'điều chỉnh\nsau khi\tđối chiếu'), fallingContext()), 'EXPLANATION_INVALID'), isNull, reason: 'a tab and a line break are not control characters');
    });

    test('a monthly report cannot be sent without the causes; a weekly one can', () {
      expect(find(reviewForm(completeForm(reportType: kMonthly).copyWith(causes: '  '), null), 'VALIDATION_FAILED', 'narrative.causes_text'), isNotNull);
      expect(find(reviewForm(completeForm(reportType: kMonthly), null), 'VALIDATION_FAILED', 'narrative.causes_text'), isNull);
      expect(find(reviewForm(completeForm(), null), 'VALIDATION_FAILED', 'narrative.causes_text'), isNull);
      expect(find(reviewForm(completeForm().copyWith(solutions: 'a' * 4001), null), 'NARRATIVE_TOO_LONG', 'narrative.solutions')!.blocksSave, isTrue);
      expect(find(reviewForm(completeForm().copyWith(solutions: 'a' * 4000), null), 'NARRATIVE_TOO_LONG'), isNull);
    });

    test('warnings are told and do not stop: the volume above the allocation, next month empty while capital is left', () {
      final ReportContext context = withReference();
      List<Finding> findings = reviewForm(completeForm().copyWith(construction: '2000000000'), context);
      final Finding exceeds = find(findings, 'VOLUME_EXCEEDS_ALLOCATION')!;
      expect(exceeds.isError, isFalse);
      expect(exceeds.values['ratio_pct'], '200.0');
      expect(exceeds.values['allocated_vnd'], '1000000000');
      ReportForm none = completeForm();
      for (final CellKey key in kCells) {
        none = none.withCell(key, none.cell(key).copyWith(nextMonth: '0'));
      }
      findings = reviewForm(none, context);
      expect(find(findings, 'NEXT_MONTH_EMPTY_WITH_CAPITAL_LEFT')!.values['remaining_vnd'], '580000000');
      expect(reviewForm(none, null).where((Finding f) => !f.isError), isEmpty, reason: 'warnings need the allocation, which the server gives');
    });

    test('the share of a volume in the allocation is rounded half up to one decimal, and nothing is divided by zero', () {
      expect(percentOf(BigInt.from(1), BigInt.from(3)), '33.3');
      expect(percentOf(BigInt.from(2), BigInt.from(3)), '66.7');
      expect(percentOf(BigInt.from(5), BigInt.zero), isNull);
      expect(percentOf(BigInt.from(1), BigInt.from(8)), '12.5');
    });

    test('a finding is put right at the screen that holds it', () {
      String? at(String field, [String code = 'CELL_INVALID']) => screenOfFinding(Finding(code: code, field: field, severity: Severity.error));
      expect(at('progress.construction_vnd'), 'MOB-14');
      expect(at('narrative.causes_text'), 'MOB-55');
      expect(at('funding_lines[0].cumulative_vnd'), 'MOB-15');
      expect(at('funding_lines[3].ctmtqg_subset_vnd'), 'MOB-16');
      expect(at('funding_lines[5].cumulative_vnd'), 'MOB-17');
      expect(at('funding_lines[1].next_month_vnd'), 'MOB-18');
      expect(at('funding_lines[2].next_month_ctmtqg_subset_vnd'), 'MOB-18');
      expect(at('funding_lines', 'NEXT_MONTH_EMPTY_WITH_CAPITAL_LEFT'), 'MOB-18');
      expect(at('funding_lines', 'TREASURY_GAP'), 'MOB-15');
      expect(at('negative_delta_explanation'), 'MOB-15');
      expect(at('period', 'PERIOD_LOCKED'), isNull);
      expect(at('funding_lines[9].cumulative_vnd'), isNull);
      expect(cellOfFinding(const Finding(code: 'x', field: 'funding_lines[4].cumulative_vnd', severity: Severity.error)), const CellKey('OTHER', 'CENTRAL'));
      expect(cellOfFinding(const Finding(code: 'x', field: 'funding_lines[9].cumulative_vnd', severity: Severity.error)), isNull);
      expect(cellOfFinding(const Finding(code: 'x', field: 'progress', severity: Severity.error)), isNull);
    });
  });

  group('AC-ST-MOB-011-4 UI-MOB-16 a field that does not apply is not a zero input', () {
    const CellKey carryover = CellKey('CARRYOVER', 'CENTRAL');

    test('a carried-over cell the plan gave nothing to, and that holds no figure, is not applicable', () {
      final ReportContext context = withReference();
      expect(isNotApplicable(carryover, completeForm().withCell(carryover, const CellEntry()), context), isTrue);
      expect(isNotApplicable(const CellKey('CARRYOVER', 'LOCAL'), completeForm(), context), isFalse, reason: 'the plan allocated to it');
    });

    test('a figure that was entered is never hidden, whatever the plan says', () {
      final ReportContext context = withReference();
      expect(isNotApplicable(carryover, completeForm(), context), isFalse, reason: 'it holds 30 million');
      expect(isNotApplicable(carryover, const ReportForm(projectId: projectId, periodId: periodId).withCell(carryover, const CellEntry(nextMonth: '5')), context), isFalse);
    });

    test('without the allocation of the server nothing is judged not applicable, and the other sources are never judged so', () {
      expect(isNotApplicable(carryover, const ReportForm(projectId: projectId, periodId: periodId), null), isFalse);
      expect(isNotApplicable(carryover, const ReportForm(projectId: projectId, periodId: periodId), chosenOnly), isFalse);
      expect(isNotApplicable(const CellKey('OTHER', 'CENTRAL'), const ReportForm(projectId: projectId, periodId: periodId), withReference(allocated: <String, String>{for (final CellKey key in kCells) key.id: '0'})), isFalse);
    });

    test('only the year plan and the carried-over plan take a CTMTQG part', () {
      expect(<bool>[for (final String bucket in kBuckets) takesCtmtqg(bucket)], <bool>[true, true, false]);
      expect(cellsOf('OTHER'), const <CellKey>[CellKey('OTHER', 'CENTRAL'), CellKey('OTHER', 'LOCAL')]);
    });
  });

  group('AC-ST-MOB-011-1 the draft keeps what was typed and restores the same values', () {
    test('toFields and fromFields give the same form, with the texts as they were typed', () {
      final ReportForm typed = completeForm().withCell(first(), const CellEntry(cumulative: '1.250.000', ctmtqg: '', nextMonth: '1,5')).copyWith(percent: '40,5', explanation: '  ghi chú  ', results: 'Xong phần móng', linkedIssueIds: <String>['i-1']);
      final ReportForm restored = ReportForm.fromFields(typed.toFields());
      expect(restored, typed);
      expect(restored.cell(first()).cumulative, '1.250.000');
      expect(restored.percent, '40,5');
      expect(restored.explanation, '  ghi chú  ');
      expect(restored.linkedIssueIds, <String>['i-1']);
    });

    test('a form with nothing entered is pristine; one change makes it not so', () {
      const ReportForm fresh = ReportForm(projectId: projectId, periodId: periodId, planVersionId: planId);
      expect(fresh.isPristine, isTrue);
      expect(fresh.copyWith(construction: '1').isPristine, isFalse);
      expect(fresh.withCell(first(), const CellEntry(cumulative: '5')).isPristine, isFalse);
      expect(fresh.copyWith(basis: 'PERIOD').isPristine, isTrue, reason: 'the way the figures are read is chosen when the draft is started; it is not an entry');
    });

    test('a new cell reads zero for the cumulative and for next month, as on the web', () {
      const CellEntry entry = CellEntry();
      expect(entry.cumulative, '0');
      expect(entry.nextMonth, '0');
      expect(entry.ctmtqg, isEmpty);
    });

    test('equal forms are equal whatever order their cells were entered in', () {
      final ReportForm a = const ReportForm(projectId: projectId, periodId: periodId).withCell(kCells[0], const CellEntry(cumulative: '1')).withCell(kCells[1], const CellEntry(cumulative: '2'));
      final ReportForm b = const ReportForm(projectId: projectId, periodId: periodId).withCell(kCells[1], const CellEntry(cumulative: '2')).withCell(kCells[0], const CellEntry(cumulative: '1'));
      expect(a, b);
      expect(a.hashCode, b.hashCode);
    });
  });

  group('TK-MOB-011-4 the command carries whole dong, the same names as the web, and only what is complete', () {
    test('toPayload writes exact digits, trims the words, names the report and keeps the six cells in order', () {
      final ReportForm form = completeForm().withCell(first(), const CellEntry(cumulative: '1.000.000', ctmtqg: '2,000', nextMonth: '3 000', nextCtmtqg: '')).copyWith(percent: '40,5', explanation: '  Điều chỉnh sau đối chiếu  ', results: ' Xong ');
      final Map<String, Object?> payload = form.toPayload(reportId);
      expect(payload['report_id'], reportId);
      expect(payload['project_id'], projectId);
      expect(payload['plan_version_id'], planId);
      expect(payload['report_type'], 'WEEKLY');
      expect(payload['measurement_basis'], 'YTD');
      final List<Object?> lines = payload['funding_lines']! as List<Object?>;
      expect(lines, hasLength(6));
      expect(lines.first, <String, Object?>{'bucket': 'CURRENT_YEAR', 'budget_level': 'CENTRAL', 'cumulative_vnd': '1000000', 'ctmtqg_subset_vnd': '2000', 'next_month_vnd': '3000'});
      expect((lines[5]! as Map<String, Object?>)['cumulative_vnd'], '20000000');
      expect(payload['construction_vnd'], '300000000');
      expect(payload['physical_progress_pct'], '40.5');
      expect(payload['negative_delta_explanation'], 'Điều chỉnh sau đối chiếu');
      expect(payload['narrative'], <String, Object?>{'results': 'Xong'});
      expect(payload.containsKey('_ctx'), isFalse);
      expect(payload.containsKey('client_operation_id'), isFalse);
    });

    test('the volumes go only when all four are amounts, so a save without them leaves the server\'s as they are', () {
      final Map<String, Object?> partial = completeForm().copyWith(preparing: '').toPayload(reportId);
      expect(partial.keys.where((String key) => key.endsWith('_vnd') && key != 'cumulative_vnd'), isEmpty);
      expect(partial.containsKey('physical_progress_pct'), isFalse);
      expect(completeForm().toPayload(reportId).containsKey('preparing_dossier_vnd'), isTrue);
    });

    test('the narrative keeps the issues the server named and is empty when nothing was written', () {
      expect(completeForm().toPayload(reportId)['narrative'], isEmpty);
      expect(completeForm().copyWith(linkedIssueIds: <String>['i-1']).toPayload(reportId)['narrative'], <String, Object?>{'linked_issue_ids': <String>['i-1']});
    });

    test('the payload reads back into the same form, which is what the queue writes into a draft after a retry', () {
      final ReportForm form = completeForm(reportType: kMonthly).copyWith(percent: '12.5', explanation: 'Điều chỉnh sau đối chiếu');
      final ReportForm back = ReportForm.fromFields(form.toPayload(reportId));
      expect(back.toPayload(reportId), form.toPayload(reportId));
      expect(back.isMonthly, isTrue);
    });
  });

  group('the server\'s report is read into a form and a context', () {
    test('a draft with the plan, the allocation and the period before', () {
      final ReportView view = parseReportView(serverReport(form: completeForm(), previous: <String, String>{'CURRENT_YEAR:CENTRAL': '90000000'}), fetchedAt: '2026-11-03T03:00:00Z')!;
      expect(view.id, reportId);
      expect(view.version, 1);
      expect(view.isDraft, isTrue);
      expect(view.form.cell(first()).cumulative, '100000000');
      expect(view.form.construction, '300000000');
      expect(view.form.planVersionId, planId);
      expect(view.context.projectCode, 'DA-2026-002');
      expect(view.context.reference(first())!.previous, '90000000');
      expect(view.context.allocatedTotal, '1000000000');
      expect(view.context.previousTotal, '90000000');
      expect(view.context.fetchedAt, '2026-11-03T03:00:00Z');
      expect(view.review!.errors, isEmpty);
      expect(view.cumulativeTotal, '420000000');
      expect(view.ctmtqgTotal, '40000000');
    });

    test('a report that was handed in has no review and carries the time the server received it', () {
      final ReportView view = parseReportView(serverReport(status: 'SUBMITTED', revision: 2, submittedAt: '2026-11-03T03:20:00.000Z', isLate: true), fetchedAt: 'x')!;
      expect(view.isDraft, isFalse);
      expect(view.review, isNull);
      expect(view.revision, 2);
      expect(view.submittedAt, '2026-11-03T03:20:00.000Z');
      expect(view.isLate, isTrue);
    });

    test('the findings of the server are read with their figures', () {
      final ReportView view = parseReportView(
        serverReport(review: <String, Object?>{
          'blocking': true,
          'errors': <Object?>[
            <String, Object?>{'code': 'SUBSET_EXCEEDS_PARENT', 'field': 'funding_lines[0].ctmtqg_subset_vnd', 'values': <String, Object?>{'parent_vnd': '10', 'subset_vnd': '20'}},
            <String, Object?>{'field': 'no code'},
          ],
          'warnings': <Object?>[
            <String, Object?>{'code': 'TREASURY_GAP', 'field': 'funding_lines', 'values': <String, Object?>{'gap_pct': null, 'reported_vnd': '5'}},
          ],
        }),
        fetchedAt: 'x',
      )!;
      expect(view.review!.errors, hasLength(1));
      expect(view.review!.errors.single.values, <String, String?>{'parent_vnd': '10', 'subset_vnd': '20'});
      expect(view.review!.warnings.single.isError, isFalse);
      expect(view.review!.warnings.single.values['gap_pct'], isNull);
    });

    test('an answer without what makes a figure citable is refused whole', () {
      expect(parseReportView(null, fetchedAt: 'x'), isNull);
      expect(parseReportView(<String, Object?>{'id': reportId}, fetchedAt: 'x'), isNull);
      final Map<String, Object?> noPeriod = serverReport()..remove('period');
      expect(parseReportView(noPeriod, fetchedAt: 'x'), isNull);
    });

    test('the context survives the device: written as JSON and read back', () {
      final ReportContext back = ReportContext.fromJson(withReference(previous: <String, String>{'OTHER:LOCAL': '7'}).toJson());
      expect(back.projectName, 'Đường vành đai 3');
      expect(back.reference(const CellKey('OTHER', 'LOCAL'))!.previous, '7');
      expect(back.hasReference, isTrue);
      expect(back.fetchedAt, '2026-11-03T03:00:00.000Z');
      expect(ReportContext.fromJson(chosenOnly.toJson()).hasReference, isFalse);
      expect(chosenOnly.allocatedTotal, isNull);
      expect(chosenOnly.previousTotal, isNull);
    });

    test('the month of the registration is the one after the month the period ends in', () {
      expect(nextMonthOf('2026-11-06'), (year: 2026, month: 12));
      expect(nextMonthOf('2026-12-31'), (year: 2027, month: 1));
      expect(nextMonthOf('soon'), isNull);
    });
  });

  group('UI-MOB-56 the estimate is judged before it is sent', () {
    test('the month, the amount and the assumption are required; the assumption has a limit and no control character', () {
      expect(reviewEstimate(const EstimateEntry()).keys, containsAll(<String>['month', 'amount', 'assumption']));
      const EstimateEntry good = EstimateEntry(month: '11', amount: '1.000.000', assumption: 'Nghiệm thu đợt 2');
      expect(reviewEstimate(good), isEmpty);
      expect(reviewEstimate(good.copyWith(month: '14'))['month'], EstimateProblem.monthRequired);
      expect(reviewEstimate(good.copyWith(month: '13')), isEmpty, reason: 'the adjustment month');
      expect(reviewEstimate(good.copyWith(month: '0'))['month'], EstimateProblem.monthRequired);
      expect(reviewEstimate(good.copyWith(amount: '1.5x'))['amount'], EstimateProblem.amountInvalid);
      expect(reviewEstimate(good.copyWith(amount: ' '))['amount'], EstimateProblem.amountRequired);
      expect(reviewEstimate(good.copyWith(assumption: 'a' * 2001))['assumption'], EstimateProblem.assumptionTooLong);
      expect(reviewEstimate(good.copyWith(assumption: 'a\u0002b'))['assumption'], EstimateProblem.assumptionInvalid);
      expect(reviewEstimate(good.copyWith(assumption: 'a\tb\nc')), isEmpty);
      expect(reviewEstimate(good.copyWith(reason: 'r' * 2001))['reason'], EstimateProblem.reasonTooLong);
    });

    test('the command is a monthly forecast of one source with the amount as exact dong', () {
      final Map<String, Object?> json = estimateBody(
        const EstimateEntry(month: '11', source: 'CARRYOVER:LOCAL', amount: '1.250.000', assumption: ' Nghiệm thu đợt 2 ', reason: ' '),
        projectId: projectId,
        planYear: 2026,
      ).toJson();
      expect(json, <String, Object?>{
        'project_id': projectId,
        'plan_year': 2026,
        'granularity': 'MONTH',
        'month': 11,
        'kind': 'FORECAST',
        'bucket': 'CARRYOVER',
        'budget_level': 'LOCAL',
        'amount_vnd': '1250000',
        'assumption': 'Nghiệm thu đợt 2',
      });
    });

    test('an entry is kept as JSON, and an unknown source falls back to the first cell', () {
      const EstimateEntry entry = EstimateEntry(month: '3', source: 'OTHER:LOCAL', amount: '5', assumption: 'a', reason: 'b');
      expect(EstimateEntry.fromJson(entry.toJson()).source, 'OTHER:LOCAL');
      expect(const EstimateEntry(source: 'NOPE').cell, kCells.first);
      expect(const EstimateEntry().isEmpty, isTrue);
      expect(entry.isEmpty, isFalse);
    });
  });

  group('AC-ST-MOB-012-1 two forms are the same report only when the issues linked to them are the same too', () {
    test('another link makes another report; the order of the links does not', () {
      const ReportForm base = ReportForm(projectId: 'p-1', periodId: 'per-1', linkedIssueIds: <String>['iss-1', 'iss-2']);
      expect(sameFigures(base, const ReportForm(projectId: 'p-1', periodId: 'per-1', linkedIssueIds: <String>['iss-2', 'iss-1'])), isTrue);
      expect(sameFigures(base, const ReportForm(projectId: 'p-1', periodId: 'per-1', linkedIssueIds: <String>['iss-1'])), isFalse);
      expect(sameFigures(base, const ReportForm(projectId: 'p-1', periodId: 'per-1', linkedIssueIds: <String>['iss-1', 'iss-3'])), isFalse);
      expect(sameFigures(const ReportForm(projectId: 'p-1', periodId: 'per-1'), const ReportForm(projectId: 'p-1', periodId: 'per-1', linkedIssueIds: <String>['iss-1'])), isFalse);
      expect(sameFigures(const ReportForm(projectId: 'p-1', periodId: 'per-1', linkedIssueIds: <String>['iss-1']), const ReportForm(projectId: 'p-1', periodId: 'per-1', linkedIssueIds: <String>['iss-1'])), isTrue);
    });
  });
}

CellKey first() => kCells.first;
