import 'package:flutter/material.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../core/format/format.dart';
import '../../core/l10n/app_strings.dart';
import '../../core/theme/colors.dart';
import '../../core/widgets/sheets.dart';
import '../../core/widgets/work_row.dart';
import 'pwf_process_models.dart';

/// The rows of the procedure of a project on the phone (PWF-4, MOB-78 and MOB-79): a step of a phase with its progress, a legal ground of a step
/// or of a task, and the revision of a form. They only show: the phone writes none of this. A state is always told by an icon and by words,
/// never by colour.

String pwfStepStatusLabel(BuildContext context, PwfStepStatus status) => switch (status) {
      PwfStepStatus.done => context.t('mob.pwf.process.step.done'),
      PwfStepStatus.inProgress => context.t('mob.pwf.process.step.inProgress'),
      PwfStepStatus.notStarted => context.t('mob.pwf.process.step.notStarted'),
      PwfStepStatus.notApplicable => context.t('mob.pwf.process.step.notApplicable'),
    };

IconData _stepIcon(PwfStepStatus status) => switch (status) {
      PwfStepStatus.done => Icons.check_circle,
      PwfStepStatus.inProgress => Icons.timelapse,
      PwfStepStatus.notStarted => Icons.radio_button_unchecked,
      PwfStepStatus.notApplicable => Icons.remove_circle_outline,
    };

String pwfLegalStateLabel(BuildContext context, PwfLegalState state) => switch (state) {
      PwfLegalState.inForce => context.t('mob.pwf.process.legal.inForce'),
      PwfLegalState.notYetInForce => context.t('mob.pwf.process.legal.notYet'),
      PwfLegalState.expired => context.t('mob.pwf.process.legal.expired'),
      PwfLegalState.superseded => context.t('mob.pwf.process.legal.superseded'),
      PwfLegalState.unknown => context.t('mob.pwf.process.legal.unknown'),
    };

IconData _legalIcon(PwfLegalState state) => switch (state) {
      PwfLegalState.inForce => Icons.verified_outlined,
      PwfLegalState.notYetInForce => Icons.schedule_outlined,
      PwfLegalState.expired || PwfLegalState.superseded => Icons.cancel_outlined,
      PwfLegalState.unknown => Icons.help_outline,
    };

String _docKindLabel(BuildContext context, String? kind) => switch (kind) {
      'LAW' => context.t('mob.pwf.process.doc.law'),
      'DECREE' => context.t('mob.pwf.process.doc.decree'),
      'CIRCULAR' => context.t('mob.pwf.process.doc.circular'),
      'RESOLUTION' => context.t('mob.pwf.process.doc.resolution'),
      'DECISION' => context.t('mob.pwf.process.doc.decision'),
      'DIRECTIVE' => context.t('mob.pwf.process.doc.directive'),
      _ => context.t('mob.pwf.process.doc.other'),
    };

/// The head of a step under its phase: its place and name, where it stands, how many of its tasks and checklist items are done and its standard
/// time; tapping it opens the legal grounds of the step when it has any.
class PwfStepHeader extends StatelessWidget {
  const PwfStepHeader({required this.step, this.onLegal, super.key});

  final PwfStep step;

  /// Opens the legal grounds of the step; null when the step has none.
  final VoidCallback? onLegal;

  @override
  Widget build(BuildContext context) {
    final String status = pwfStepStatusLabel(context, step.status);
    final List<String> facts = <String>[
      status,
      context.t('mob.pwf.process.step.tasks', <String, Object>{'done': step.taskDone, 'total': step.taskTotal}),
      if (step.checklistTotal > 0) context.t('mob.pwf.process.step.checklist', <String, Object>{'done': step.checklistDone, 'total': step.checklistTotal}),
      context.t('mob.pwf.process.step.days', <String, Object>{'days': step.standardWorkingDays}),
    ];
    final String title = context.t('mob.pwf.process.step.title', <String, Object>{'order': step.order, 'name': step.name});
    final String? legal = step.legalBasis.isEmpty
        ? null
        : (step.attention > 0
            ? context.t('mob.pwf.process.step.legalAttention', <String, Object>{'count': step.legalBasis.length, 'attention': step.attention})
            : context.t('mob.pwf.process.step.legal', <String, Object>{'count': step.legalBasis.length}));
    // The legal grounds are a fact of the step on its line of facts (and the row opens them): as an end column they squeezed the line to "Việc 1/2 · ...".
    return WorkRow(
      title: title,
      titleMaxLines: 3,
      subtitle: <String>[...facts, ?legal].join(' · '),
      subtitleMaxLines: 3,
      leading: Icon(_stepIcon(step.status), color: context.v2.palette.ink2),
      trailing: onLegal == null ? null : Icon(Icons.gavel_outlined, size: 20, color: context.v2.palette.ink2),
      onTap: onLegal,
      semanticLabel: <String>[title, ...facts, if (legal != null) legal].join(', '),
      dividerAbove: true,
      quiet: true,
    );
  }
}

/// One legal ground: the document as the catalogue names it, the article cited (or that none is cited yet), whether the citation is confirmed,
/// and whether the document may still be cited. A document that was replaced names what replaced it.
class PwfLegalBasisRow extends StatelessWidget {
  const PwfLegalBasisRow({required this.basis, this.dividerAbove = false, super.key});

  final PwfLegalBasis basis;
  final bool dividerAbove;

  @override
  Widget build(BuildContext context) {
    final String language = AppStrings.of(context).language;
    final String title = basis.number == null ? basis.documentCode : '${_docKindLabel(context, basis.docKind)} ${basis.number}';
    final String state = pwfLegalStateLabel(context, basis.state);
    final List<String> facts = <String>[
      if (basis.title != null) basis.title!,
      basis.article ?? context.t('mob.pwf.process.legal.articlePending'),
      if (basis.effectiveFrom != null) context.t('mob.pwf.process.legal.from', <String, Object>{'date': formatDay(basis.effectiveFrom!, language: language)}),
      basis.verified ? context.t('mob.pwf.process.legal.verified') : context.t('mob.pwf.process.legal.unverified'),
      if (basis.state == PwfLegalState.superseded && basis.supersededBy != null) context.t('mob.pwf.process.legal.replacedBy', <String, Object>{'code': basis.supersededBy!}),
    ];
    return WorkRow(
      title: title,
      titleMaxLines: 3,
      subtitle: <String>[state, ...facts].join(' · '),
      subtitleMaxLines: 5,
      leading: Icon(_legalIcon(basis.state), color: context.v2.palette.ink2),
      semanticLabel: <String>[title, state, ...facts].join(', '),
      dividerAbove: dividerAbove,
    );
  }
}

/// Opens the legal grounds of a step in a sheet (read only).
Future<void> showPwfLegalBasisSheet(BuildContext context, {required String title, required List<PwfLegalBasis> basis}) {
  return showActionSheet<void>(
    context,
    title: context.t('mob.pwf.process.legal.sheet', <String, Object>{'name': title}),
    builder: (BuildContext sheet) => Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        for (int index = 0; index < basis.length; index += 1) PwfLegalBasisRow(basis: basis[index], dividerAbove: index > 0),
        const SizedBox(height: MachvonV2Space.s8),
      ],
    ),
  );
}

/// The revision of one form of a task: the one in force, the one the task used, and a warning in words when the form was revised since.
class PwfFormRevisionRow extends StatelessWidget {
  const PwfFormRevisionRow({required this.form, this.dividerAbove = false, super.key});

  final PwfFormRevision form;
  final bool dividerAbove;

  @override
  Widget build(BuildContext context) {
    final List<String> facts = <String>[
      form.pinned ? context.t('mob.pwf.process.forms.pinned', <String, Object>{'revision': form.pinnedRevision ?? 0}) : context.t('mob.pwf.process.forms.latest'),
      form.currentRevision == null ? context.t('mob.pwf.process.forms.noCurrent') : context.t('mob.pwf.process.forms.current', <String, Object>{'revision': form.currentRevision!}),
      if (form.usedRevision != null) context.t('mob.pwf.process.forms.used', <String, Object>{'revision': form.usedRevision!}),
    ];
    final String? warning = form.newerAvailable ? context.t('mob.pwf.process.forms.newer') : null;
    final String title = form.title ?? form.code;
    return WorkRow(
      title: title,
      titleMaxLines: 3,
      subtitle: <String>[?warning, ...facts].join(' · '),
      subtitleMaxLines: 3,
      leading: Icon(form.newerAvailable ? Icons.warning_amber_outlined : Icons.description_outlined, color: context.v2.palette.ink2),
      semanticLabel: <String>[title, ...facts, if (warning != null) warning].join(', '),
      dividerAbove: dividerAbove,
    );
  }
}
