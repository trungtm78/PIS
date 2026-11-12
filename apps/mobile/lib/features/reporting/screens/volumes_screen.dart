import 'package:flutter/material.dart';

import '../../../core/format/format.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
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

/// MOB-14: the volumes of the project as of the last day of the period (what was built, accepted, sent to the Treasury and is
/// being prepared), the way the cumulative figures are read, and, under them, what the cumulative disbursement of the six cells
/// comes to (DIS-03, ST-MOB-011). The draft is written at every change.
Widget buildVolumesScreen(BuildContext context, ScreenContext screen) =>
    VolumesScreen(draftId: screen.pathParameters['draftId'] ?? '');

class VolumesScreen extends StatelessWidget {
  const VolumesScreen({required this.draftId, super.key});

  final String draftId;

  @override
  Widget build(BuildContext context) {
    return DraftHost(
      draftId: draftId,
      screenId: 'MOB-14',
      step: 1,
      title: context.t('mob.rep.volumes.title'),
      body: (BuildContext context, DraftSession session) => _Volumes(session: session),
    );
  }
}

class _Volumes extends StatelessWidget {
  const _Volumes({required this.session});

  final DraftSession session;

  @override
  Widget build(BuildContext context) {
    final ReportForm form = session.form;
    final Map<String, Finding> problems = byField(reviewForm(form, session.snapshot.context));
    String? error(String field) {
      final Finding? finding = problems[field];
      return finding != null && finding.blocksSave ? fieldError(context, finding) : null;
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Text(context.t('mob.rep.volumes.note.body'), style: Theme.of(context).textTheme.bodyMedium),
        const SizedBox(height: 8),
        MoneyField(
          label: context.t('mob.rep.volumes.construction.label'),
          value: form.construction,
          enabled: session.editable,
          error: error('progress.construction_vnd'),
          onChanged: (String typed) => session.update((ReportForm f) => f.copyWith(construction: typed)),
        ),
        MoneyField(
          label: context.t('mob.rep.volumes.acceptance.label'),
          value: form.acceptance,
          enabled: session.editable,
          error: error('progress.acceptance_vnd'),
          onChanged: (String typed) => session.update((ReportForm f) => f.copyWith(acceptance: typed)),
        ),
        MoneyField(
          label: context.t('mob.rep.volumes.treasury.label'),
          value: form.treasury,
          enabled: session.editable,
          error: error('progress.treasury_submitted_vnd'),
          onChanged: (String typed) => session.update((ReportForm f) => f.copyWith(treasury: typed)),
        ),
        MoneyField(
          label: context.t('mob.rep.volumes.preparing.label'),
          value: form.preparing,
          enabled: session.editable,
          error: error('progress.preparing_dossier_vnd'),
          onChanged: (String typed) => session.update((ReportForm f) => f.copyWith(preparing: typed)),
        ),
        DraftTextField(
          label: context.t('mob.rep.volumes.percent.label'),
          suffix: '%',
          value: form.percent,
          enabled: session.editable,
          helper: context.t('mob.rep.volumes.percent.help'),
          error: error('progress.physical_progress_pct'),
          keyboardType: const TextInputType.numberWithOptions(decimal: true),
          onChanged: (String typed) => session.update((ReportForm f) => f.copyWith(percent: typed)),
        ),
        const SizedBox(height: 8),
        Semantics(header: true, child: Text(context.t('mob.rep.basis.title'), style: Theme.of(context).textTheme.titleSmall)),
        RadioGroup<String>(
          groupValue: form.basis,
          onChanged: (String? basis) {
            if (basis != null && session.editable) session.update((ReportForm f) => f.copyWith(basis: basis));
          },
          child: Column(
            children: <Widget>[
              for (final String basis in kBases) RadioListTile<String>(value: basis, enabled: session.editable, title: Text(basisLabel(context, basis))),
            ],
          ),
        ),
        _Cumulative(form: form, reportContext: session.snapshot.context),
      ],
    );
  }
}

/// What the cumulative disbursement of the six cells comes to, beside the period before: the cumulative is what the cells say it
/// is, and the change in the period is the cumulative less the period before, never the two added (BR-DIS-01, UAT-AC241).
class _Cumulative extends StatelessWidget {
  const _Cumulative({required this.form, required this.reportContext});

  final ReportForm form;
  final ReportContext? reportContext;

  @override
  Widget build(BuildContext context) {
    final String cumulative = sumTyped(<String>[for (final CellKey key in kCells) form.cell(key).cumulative]);
    final String? previous = reportContext?.previousTotal;
    return SectionCard(
      title: context.t('mob.rep.cumulative.title'),
      semanticLabel: null,
      children: <Widget>[
        FactLine(label: context.t('mob.rep.cumulative.previous.label'), value: previous == null ? context.t('mob.rep.cumulative.noPrevious.body') : moneyLabel(context, previous)),
        FactLine(label: context.t('mob.rep.cumulative.change.label'), value: previous == null ? context.t('mob.rep.cumulative.noPrevious.body') : signedMoneyLabel(context, differenceDong(cumulative, previous))),
        FactLine(label: context.t('mob.rep.cumulative.total.label'), value: moneyLabel(context, cumulative)),
      ],
    );
  }
}
