import 'package:flutter/material.dart';

import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../read_support/amounts.dart';
import '../../read_support/money.dart';
import '../../read_support/navigate.dart';
import '../../read_support/widgets.dart';
import '../labels.dart';
import '../model/fields.dart';
import '../model/report_cells.dart';
import '../model/report_context.dart';
import '../model/report_form.dart';
import '../model/report_review.dart';
import '../widgets/draft_host.dart';
import '../widgets/money_field.dart';
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
        if (month != null) Text(context.t('mob.rep.registration.month.body', <String, Object>{'month': month.month, 'year': month.year}), style: Theme.of(context).textTheme.titleSmall),
        for (final CellKey key in kCells) _RegistrationCell(session: session, cell: key, problems: problems),
        SectionCard(
          title: context.t('mob.rep.totals.title'),
          children: <Widget>[
            FactLine(label: context.t('mob.rep.registration.total.label'), value: millionsLabel(context, total)),
            FactLine(label: context.t('mob.rep.totals.ctmtqg.label'), value: millionsLabel(context, ctmtqg)),
            Text(context.t('mob.rep.ctmtqg.note.body'), style: Theme.of(context).textTheme.bodySmall),
          ],
        ),
        Align(
          alignment: Alignment.centerLeft,
          child: TextButton(
            onPressed: () => openScreen(context, 'MOB-56', pathSuffix: '/${session.snapshot.id}', stacked: true),
            child: Text(context.t('mob.rep.registration.estimate.action')),
          ),
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
    return SectionCard(
      title: cellLabel(context, cell),
      children: <Widget>[
        if (reference != null) FactLine(label: context.t('mob.rep.cell.allocated.label'), value: millionsLabel(context, reference.allocated)),
        if (remaining != null) FactLine(label: context.t('mob.rep.registration.remaining.label'), value: millionsLabel(context, remaining)),
        if (notApplicable)
          Text(context.t('mob.rep.cell.notApplicable.body', <String, Object>{'level': levelLabel(context, cell.level)}), style: Theme.of(context).textTheme.bodyMedium)
        else ...<Widget>[
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
            Text(context.t('mob.rep.cell.ctmtqgNotApplicable.body'), style: Theme.of(context).textTheme.bodyMedium),
        ],
      ],
    );
  }
}
