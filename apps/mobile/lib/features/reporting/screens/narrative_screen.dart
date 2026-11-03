import 'package:flutter/material.dart';

import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../labels.dart';
import '../model/fields.dart';
import '../model/report_form.dart';
import '../model/report_review.dart';
import '../widgets/draft_host.dart';
import '../widgets/draft_text_field.dart';

/// MOB-55: the notes of the report: what was achieved, the causes, the solutions and the proposals (DIS-13 and the notes of DIS-06).
/// Every section is optional in the weekly report; the monthly report cannot be sent without the causes, which the server refuses
/// with 422 and this screen says so beforehand.
Widget buildNarrativeScreen(BuildContext context, ScreenContext screen) => NarrativeScreen(draftId: screen.pathParameters['draftId'] ?? '');

class NarrativeScreen extends StatelessWidget {
  const NarrativeScreen({required this.draftId, super.key});

  final String draftId;

  @override
  Widget build(BuildContext context) {
    return DraftHost(
      draftId: draftId,
      screenId: 'MOB-55',
      step: 6,
      title: context.t('mob.rep.narrative.title'),
      body: (BuildContext context, DraftSession session) => _Narrative(session: session),
    );
  }
}

class _Narrative extends StatelessWidget {
  const _Narrative({required this.session});

  final DraftSession session;

  @override
  Widget build(BuildContext context) {
    final ReportForm form = session.form;
    final Map<String, Finding> problems = byField(reviewForm(form, session.snapshot.context));
    final bool needsCauses = form.isMonthly && form.causes.trim().isEmpty;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Text(form.isMonthly ? context.t('mob.rep.narrative.monthly.body') : context.t('mob.rep.narrative.weekly.body'), style: Theme.of(context).textTheme.bodyMedium),
        const SizedBox(height: 8),
        DraftTextField(
          label: context.t('mob.rep.narrative.results.label'),
          value: form.results,
          enabled: session.editable,
          maxLines: 5,
          error: fieldError(context, problems['narrative.results']),
          onChanged: (String typed) => session.update((ReportForm f) => f.copyWith(results: typed)),
        ),
        DraftTextField(
          label: form.isMonthly ? context.t('mob.rep.narrative.causesRequired.label') : context.t('mob.rep.narrative.causes.label'),
          value: form.causes,
          enabled: session.editable,
          maxLines: 5,
          helper: needsCauses ? context.t('mob.rep.narrative.causesMissing.body') : null,
          error: fieldError(context, problems['narrative.causes']),
          onChanged: (String typed) => session.update((ReportForm f) => f.copyWith(causes: typed)),
        ),
        DraftTextField(
          label: context.t('mob.rep.narrative.solutions.label'),
          value: form.solutions,
          enabled: session.editable,
          maxLines: 5,
          error: fieldError(context, problems['narrative.solutions']),
          onChanged: (String typed) => session.update((ReportForm f) => f.copyWith(solutions: typed)),
        ),
        DraftTextField(
          label: context.t('mob.rep.narrative.proposals.label'),
          value: form.proposals,
          enabled: session.editable,
          maxLines: 5,
          error: fieldError(context, problems['narrative.proposals']),
          onChanged: (String typed) => session.update((ReportForm f) => f.copyWith(proposals: typed)),
        ),
      ],
    );
  }
}
