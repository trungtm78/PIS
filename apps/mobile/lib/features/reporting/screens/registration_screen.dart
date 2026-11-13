import 'package:flutter/material.dart';

import '../../../core/format/format.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/theme/colors.dart';
import '../../../core/widgets/info_row.dart';
import '../../../core/widgets/work_row.dart';
import '../../read_support/navigate.dart';
import '../labels.dart';
import '../model/fields.dart';
import '../model/report_cells.dart';
import '../model/report_context.dart';
import '../model/report_form.dart';
import '../model/report_review.dart';
import '../widgets/draft_host.dart';
import '../widgets/money_field.dart';
import '../widgets/step_parts.dart';
import 'funding_screen.dart' show isNotApplicable;

/// MOB-18: the money the project expects to disburse next month, by source, with the part that belongs to the national target
/// programmes inside it (DIS-05). The server turns it into the registration of the month once the report is accepted.
Widget buildRegistrationScreen(BuildContext context, ScreenContext screen) => RegistrationScreen(draftId: screen.pathParameters['draftId'] ?? '');

class RegistrationScreen extends StatelessWidget {
  const RegistrationScreen({required this.draftId, super.key});

  final String draftId;

  @override
  Widget build(BuildContext context) {
    return DraftHost(
      draftId: draftId,
      screenId: 'MOB-18',
      step: 5,
      title: context.t('mob.rep.registration.title'),
      body: (BuildContext context, DraftSession session) => _Registration(session: session),
    );
  }
}

class _Registration extends StatelessWidget {
  const _Registration({required this.session});

  final DraftSession session;

  @override
  Widget build(BuildContext context) {
    final ReportForm form = session.form;
    final ReportContext? reportContext = session.snapshot.context;
    final Map<String, Finding> problems = byField(reviewForm(form, reportContext));
    final ({int year, int month})? month = reportContext == null ? null : nextMonthOf(reportContext.periodEnd);
    final String total = sumTyped(<String>[for (final CellKey key in kCells) form.cell(key).nextMonth]);
    final String ctmtqg = sumTyped(<String>[for (final CellKey key in kCells) form.cell(key).nextCtmtqg]);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        if (month != null) StepNote(context.t('mob.rep.registration.month.body', <String, Object>{'month': month.month, 'year': month.year})),
        for (final CellKey key in kCells) _RegistrationCell(session: session, cell: key, problems: problems),
        StepHeading(context.t('mob.rep.totals.title')),
        InfoRow(label: context.t('mob.rep.registration.total.label'), value: moneyLabel(context, total), divider: false),
        InfoRow(label: context.t('mob.rep.totals.ctmtqg.label'), value: moneyLabel(context, ctmtqg)),
        StepNote(context.t('mob.rep.ctmtqg.note.body'), small: true),
        const SizedBox(height: 8),
        WorkRow(
          title: context.t('mob.rep.registration.estimate.action'),
          semanticLabel: context.t('mob.rep.registration.estimate.action'),
          dividerAbove: true,
          trailing: Align(alignment: Alignment.centerRight, child: Icon(Icons.chevron_right, color: context.v2.palette.ink2)),
          onTap: () => openScreen(context, 'MOB-56', pathSuffix: '/${session.snapshot.id}', stacked: true),
        ),
      ],
    );
  }
}

class _RegistrationCell extends StatelessWidget {
  const _RegistrationCell({required this.session, required this.cell, required this.problems});

  final DraftSession session;
  final CellKey cell;
  final Map<String, Finding> problems;

  @override
  Widget build(BuildContext context) {
    final ReportForm form = session.form;
    final CellEntry entry = form.cell(cell);
    final CellReference? reference = session.snapshot.context?.reference(cell);
    final bool notApplicable = isNotApplicable(cell, form, session.snapshot.context);
    final String? remaining = reference == null ? null : differenceDong(reference.allocated, sumTyped(<String>[entry.cumulative]));
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        StepHeading(cellLabel(context, cell)),
        if (reference != null) InfoRow(label: context.t('mob.rep.cell.allocated.label'), value: moneyLabel(context, reference.allocated), divider: false),
        if (remaining != null) InfoRow(label: context.t('mob.rep.registration.remaining.label'), value: moneyLabel(context, remaining)),
        if (notApplicable)
          StepNote(context.t('mob.rep.cell.notApplicable.body', <String, Object>{'level': levelLabel(context, cell.level)}))
        else
          StepFields(
            children: <Widget>[
              MoneyField(
                label: context.t('mob.rep.registration.nextMonth.label', <String, Object>{'cell': cellLabel(context, cell)}),
                value: entry.nextMonth,
                enabled: session.editable,
                error: fieldError(context, problems[fieldOfCell(cell, 'next_month_vnd')]),
                onChanged: (String typed) => session.update((ReportForm f) => f.withCell(cell, f.cell(cell).copyWith(nextMonth: typed))),
              ),
              if (takesCtmtqg(cell.bucket))
                MoneyField(
                  label: context.t('mob.rep.registration.ctmtqg.label', <String, Object>{'cell': cellLabel(context, cell)}),
                  value: entry.nextCtmtqg,
                  enabled: session.editable,
                  hint: context.t('mob.rep.ctmtqg.note.body'),
                  error: fieldError(context, problems[fieldOfCell(cell, 'next_month_ctmtqg_subset_vnd')]),
                  onChanged: (String typed) => session.update((ReportForm f) => f.withCell(cell, f.cell(cell).copyWith(nextCtmtqg: typed))),
                )
              else
                StepNote(context.t('mob.rep.cell.ctmtqgNotApplicable.body'), small: true),
            ],
          ),
      ],
    );
  }
}
