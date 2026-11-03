import 'package:flutter/material.dart';

import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../read_support/amounts.dart';
import '../../read_support/widgets.dart';
import '../labels.dart';
import '../model/fields.dart';
import '../model/report_cells.dart';
import '../model/report_context.dart';
import '../model/report_form.dart';
import '../model/report_review.dart';
import '../widgets/draft_host.dart';
import '../widgets/draft_text_field.dart';
import '../widgets/money_field.dart';

/// MOB-15, MOB-16 and MOB-17: the cumulative disbursement of one source, in its central and its local budget, with the part that
/// belongs to the national target programmes (CTMTQG) written inside the cell and never added to a total (DIS-04, BR-DIS-01).
Widget buildYearFundingScreen(BuildContext context, ScreenContext screen) => FundingScreen(draftId: screen.pathParameters['draftId'] ?? '', bucket: 'CURRENT_YEAR');

Widget buildCarryoverFundingScreen(BuildContext context, ScreenContext screen) => FundingScreen(draftId: screen.pathParameters['draftId'] ?? '', bucket: 'CARRYOVER');

Widget buildOtherFundingScreen(BuildContext context, ScreenContext screen) => FundingScreen(draftId: screen.pathParameters['draftId'] ?? '', bucket: 'OTHER');

class FundingScreen extends StatelessWidget {
  const FundingScreen({required this.draftId, required this.bucket, super.key});

  final String draftId;
  final String bucket;

  String _title(BuildContext context) {
    switch (bucket) {
      case 'CURRENT_YEAR':
        return context.t('mob.rep.fundingYear.title');
      case 'CARRYOVER':
        return context.t('mob.rep.fundingCarryover.title');
      default:
        return context.t('mob.rep.fundingOther.title');
    }
  }

  @override
  Widget build(BuildContext context) {
    return DraftHost(
      draftId: draftId,
      screenId: kScreenOfBucket[bucket]!,
      step: kSteps.indexOf(kScreenOfBucket[bucket]!) + 1,
      title: _title(context),
      body: (BuildContext context, DraftSession session) => _Funding(session: session, bucket: bucket),
    );
  }
}

/// A cell whose source the plan gave nothing to, and that holds no figure: there is nothing to enter, and the screen says so
/// instead of offering a box that reads zero. Only the carried-over plan is judged so (a carry-over exists only where an extension
/// was granted); a figure that was entered is never hidden.
bool isNotApplicable(CellKey key, ReportForm form, ReportContext? context) {
  if (key.bucket != 'CARRYOVER') return false;
  final CellReference? reference = context?.reference(key);
  if (reference == null || BigInt.parse(reference.allocated) != BigInt.zero) return false;
  final CellEntry entry = form.cell(key);
  return valueOf(entry.cumulative) == BigInt.zero && valueOf(entry.ctmtqg) == BigInt.zero && valueOf(entry.nextMonth) == BigInt.zero && valueOf(entry.nextCtmtqg) == BigInt.zero;
}

class _Funding extends StatelessWidget {
  const _Funding({required this.session, required this.bucket});

  final DraftSession session;
  final String bucket;

  @override
  Widget build(BuildContext context) {
    final ReportForm form = session.form;
    final ReportContext? reportContext = session.snapshot.context;
    final List<Finding> findings = reviewForm(form, reportContext);
    final Map<String, Finding> problems = byField(findings);
    final String cumulative = sumTyped(<String>[for (final CellKey key in kCells) form.cell(key).cumulative]);
    final String ctmtqg = sumTyped(<String>[for (final CellKey key in kCells) form.cell(key).ctmtqg]);
    final String ofBucket = sumTyped(<String>[for (final CellKey key in cellsOf(bucket)) form.cell(key).cumulative]);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        _ReferenceLine(reportContext: reportContext),
        for (final CellKey key in cellsOf(bucket)) _CellCard(session: session, cell: key, problems: problems),
        SectionCard(
          title: context.t('mob.rep.totals.title'),
          children: <Widget>[
            FactLine(label: context.t('mob.rep.totals.bucket.label'), value: millionsLabel(context, ofBucket)),
            FactLine(label: context.t('mob.rep.totals.six.label'), value: millionsLabel(context, cumulative)),
            FactLine(label: context.t('mob.rep.totals.ctmtqg.label'), value: millionsLabel(context, ctmtqg)),
            Text(context.t('mob.rep.ctmtqg.note.body'), style: Theme.of(context).textTheme.bodySmall),
          ],
        ),
        if (hasFall(form, reportContext))
          SectionCard(
            title: context.t('mob.rep.explanation.title'),
            children: <Widget>[
              Text(context.t('mob.rep.explanation.fall.body'), style: Theme.of(context).textTheme.bodyMedium),
              DraftTextField(
                label: context.t('mob.rep.explanation.label'),
                value: form.explanation,
                enabled: session.editable,
                maxLines: 4,
                helper: context.t('mob.rep.explanation.help'),
                error: fieldError(context, problems['negative_delta_explanation']),
                onChanged: (String typed) => session.update((ReportForm f) => f.copyWith(explanation: typed)),
              ),
            ],
          ),
      ],
    );
  }
}

/// Says where the allocation and the figures of the period before come from, or that they are not known yet.
class _ReferenceLine extends StatelessWidget {
  const _ReferenceLine({required this.reportContext});

  final ReportContext? reportContext;

  @override
  Widget build(BuildContext context) {
    final String? fetchedAt = reportContext?.hasReference ?? false ? reportContext!.fetchedAt : null;
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Text(
        fetchedAt == null ? context.t('mob.rep.reference.none.body') : context.t('mob.rep.reference.asOf.body', <String, Object>{'time': asOfLabel(fetchedAt)}),
        style: Theme.of(context).textTheme.bodySmall,
      ),
    );
  }
}

class _CellCard extends StatelessWidget {
  const _CellCard({required this.session, required this.cell, required this.problems});

  final DraftSession session;
  final CellKey cell;
  final Map<String, Finding> problems;

  @override
  Widget build(BuildContext context) {
    final ReportForm form = session.form;
    final CellEntry entry = form.cell(cell);
    final CellReference? reference = session.snapshot.context?.reference(cell);
    final bool notApplicable = isNotApplicable(cell, form, session.snapshot.context);
    final String? delta = deltaOf(reference, entry.cumulative);
    return SectionCard(
      title: cellLabel(context, cell),
      children: <Widget>[
        if (reference != null) FactLine(label: context.t('mob.rep.cell.allocated.label'), value: millionsLabel(context, reference.allocated)),
        if (reference?.previous != null) FactLine(label: context.t('mob.rep.cell.previous.label'), value: millionsLabel(context, reference!.previous)),
        if (notApplicable)
          Semantics(
            container: true,
            child: Text(context.t('mob.rep.cell.notApplicable.body', <String, Object>{'level': levelLabel(context, cell.level)}), style: Theme.of(context).textTheme.bodyMedium),
          )
        else ...<Widget>[
          MoneyField(
            label: context.t('mob.rep.cell.cumulative.label', <String, Object>{'cell': cellLabel(context, cell)}),
            value: entry.cumulative,
            enabled: session.editable,
            error: fieldError(context, problems[fieldOfCell(cell, 'cumulative_vnd')]),
            onChanged: (String typed) => session.update((ReportForm f) => f.withCell(cell, f.cell(cell).copyWith(cumulative: typed))),
          ),
          if (delta != null)
            Padding(
              padding: const EdgeInsets.only(bottom: 4),
              child: Text(
                context.t('mob.rep.cell.change.label', <String, Object>{'change': signedMillionsLabel(context, delta)}),
                style: Theme.of(context).textTheme.bodySmall?.copyWith(color: delta.startsWith('-') ? Theme.of(context).colorScheme.error : null),
              ),
            ),
        ],
        if (notApplicable)
          const SizedBox.shrink()
        else if (takesCtmtqg(cell.bucket))
          MoneyField(
            label: context.t('mob.rep.cell.ctmtqg.label', <String, Object>{'cell': cellLabel(context, cell)}),
            value: entry.ctmtqg,
            enabled: session.editable,
            hint: context.t('mob.rep.ctmtqg.note.body'),
            error: fieldError(context, problems[fieldOfCell(cell, 'ctmtqg_subset_vnd')]),
            onChanged: (String typed) => session.update((ReportForm f) => f.withCell(cell, f.cell(cell).copyWith(ctmtqg: typed))),
          )
        else
          Text(context.t('mob.rep.cell.ctmtqgNotApplicable.body'), style: Theme.of(context).textTheme.bodyMedium),
      ],
    );
  }
}
