import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';

import '../../../core/connectivity/reachability.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/session/session.dart';
import '../../read_support/data_view.dart';
import '../../read_support/loaded.dart';
import '../../read_support/navigate.dart';
import '../data/report_drafts.dart';
import '../data/report_providers.dart';
import '../data/start_options.dart';
import '../labels.dart';
import '../model/report_cells.dart';
import '../model/report_context.dart';
import '../widgets/notices.dart';

/// MOB-13: the choice of the period, the project and the way the cumulative figures are read for a new report (DIS-02, DIS-13).
/// The draft is made on the phone at once, so the report can be entered without a network; when there is one the server makes the
/// report too (with the draft's UUID as `client_operation_id`) and gives back the plan in force and what it allocated to each cell.
Widget buildPeriodScreen(BuildContext context, ScreenContext screen) => PeriodScreen(projectId: screen.queryParameters['project'], periodId: screen.queryParameters['period']);

class PeriodScreen extends ConsumerWidget {
  const PeriodScreen({this.projectId, this.periodId, super.key});

  final String? projectId;
  final String? periodId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Scaffold(
      appBar: AppBar(title: Text(context.t('mob.rep.start.title'))),
      body: SafeArea(
        child: DataView<StartOptions>(
          cacheKey: 'reporting.start',
          read: (MachvonApiClient client) async => <String, Object?>{
            'periods': await client.readAll('get_resources_reporting_period'),
            'projects': await client.readAll('get_resources_project'),
          },
          parse: parseStartOptions,
          isEmpty: (StartOptions options) => options.projects.isEmpty,
          builder: (BuildContext context, Loaded<StartOptions> loaded) => _StartForm(options: loaded.value, projectId: projectId, periodId: periodId),
        ),
      ),
    );
  }
}

class _StartForm extends ConsumerStatefulWidget {
  const _StartForm({required this.options, this.projectId, this.periodId});

  final StartOptions options;
  final String? projectId;
  final String? periodId;

  @override
  ConsumerState<_StartForm> createState() => _StartFormState();
}

class _StartFormState extends ConsumerState<_StartForm> {
  late String _type = widget.options.periods.where((PeriodOption p) => p.id == widget.periodId).firstOrNull?.type ?? 'WEEK';
  late String? _periodId = widget.options.periods.any((PeriodOption p) => p.id == widget.periodId) ? widget.periodId : null;
  late String? _projectId = widget.options.projects.any((ProjectOption p) => p.id == widget.projectId) ? widget.projectId : null;
  String? _basis;
  bool _submitted = false;
  bool _busy = false;
  ReportProblem? _refusal;

  String get _reportType => _type == 'MONTH' ? kMonthly : kWeekly;

  /// The basis a report starts with: the cumulative from the start of the year for the weekly report, what arose in the month for
  /// the monthly one (DIS 3 F1, DIS-13).
  String get _basisOrDefault => _basis ?? (_type == 'MONTH' ? 'PERIOD' : 'YTD');

  Future<void> _create() async {
    setState(() => _submitted = true);
    final PeriodOption? period = widget.options.periods.where((PeriodOption p) => p.id == _periodId).firstOrNull;
    final ProjectOption? project = widget.options.projects.where((ProjectOption p) => p.id == _projectId).firstOrNull;
    if (_busy || period == null || project == null || ref.read(sessionProvider).isReadOnly) return;
    setState(() {
      _busy = true;
      _refusal = null;
    });
    final ReportDrafts drafts = await ref.read(reportDraftsProvider.future);
    final DraftSnapshot? kept = drafts.existingFor(projectId: project.id, periodId: period.id);
    if (kept != null) {
      _open(kept.id);
      return;
    }
    final DraftSnapshot draft = drafts.start(
      context: ReportContext(
        projectCode: project.code,
        projectName: project.name,
        periodCode: period.code,
        periodType: period.type,
        periodStart: period.startDate,
        periodEnd: period.endDate,
        fiscalYear: period.fiscalYear,
        periodStatus: period.status,
      ),
      projectId: project.id,
      periodId: period.id,
      basis: _basisOrDefault,
      reportType: _reportType,
    );
    if (ref.read(reachabilityProvider) == Reachability.offline) {
      _open(draft.id);
      return;
    }
    try {
      await drafts.ensureRecord(draft.id);
    } on ApiError catch (error) {
      if (error.code != networkErrorCode) {
        // The server will not take this report (a locked period, no plan in force, a project outside its stage): there is nothing
        // to keep on the phone for it.
        drafts.discard(draft.id);
        if (mounted) {
          setState(() {
            _busy = false;
            _refusal = problemOf(error);
          });
        }
        return;
      }
    }
    _open(draft.id);
  }

  void _open(String draftId) {
    if (!mounted) return;
    setState(() => _busy = false);
    openScreen(context, 'MOB-14', pathSuffix: '/$draftId', stacked: true);
  }

  @override
  Widget build(BuildContext context) {
    final bool readOnly = ref.watch(sessionProvider).isReadOnly;
    final List<PeriodOption> periods = widget.options.periodsOf(_type).take(30).toList();
    final PeriodOption? chosen = widget.options.periods.where((PeriodOption p) => p.id == _periodId).firstOrNull;
    return ListView(
      padding: const EdgeInsets.all(16),
      children: <Widget>[
        Text(context.t('mob.rep.start.note.body'), style: Theme.of(context).textTheme.bodyMedium),
        if (readOnly) NoticeLine(icon: Icons.lock_outline, text: context.t('mob.rep.readOnly.notice.body')),
        if (_refusal != null) NoticeLine(icon: Icons.error_outline, error: true, text: problemMessage(context, _refusal!)),
        const SizedBox(height: 8),
        Semantics(header: true, child: Text(context.t('mob.rep.start.type.label'), style: Theme.of(context).textTheme.titleSmall)),
        RadioGroup<String>(
          groupValue: _type,
          onChanged: (String? type) {
            if (type == null || _busy) return;
            setState(() {
              _type = type;
              _periodId = null;
              _basis = null;
            });
          },
          child: Column(
            children: <Widget>[
              RadioListTile<String>(value: 'WEEK', title: Text(context.t('mob.rep.start.typeWeek.label'))),
              RadioListTile<String>(value: 'MONTH', title: Text(context.t('mob.rep.start.typeMonth.label'))),
            ],
          ),
        ),
        DropdownButtonFormField<String>(
          key: ValueKey<String>('period-$_type'),
          initialValue: _periodId,
          isExpanded: true,
          decoration: InputDecoration(
            labelText: context.t('mob.rep.start.period.label'),
            errorText: _submitted && _periodId == null ? context.t('mob.rep.start.period.required') : null,
          ),
          hint: Text(context.t('mob.rep.start.period.choose')),
          items: <DropdownMenuItem<String>>[
            for (final PeriodOption period in periods)
              DropdownMenuItem<String>(
                value: period.id,
                child: Text(
                  context.t('mob.rep.start.period.option', <String, Object>{'code': period.code, 'status': periodStatusLabel(context, period.status)}),
                  overflow: TextOverflow.ellipsis,
                ),
              ),
          ],
          onChanged: _busy ? null : (String? id) => setState(() => _periodId = id),
        ),
        if (chosen != null)
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Text(context.t('mob.rep.start.period.range', <String, Object>{'start': chosen.startDate, 'end': chosen.endDate}), style: Theme.of(context).textTheme.bodySmall),
          ),
        if (chosen != null && chosen.isLocked) NoticeLine(icon: Icons.lock_outline, text: context.t('mob.rep.start.locked.body')),
        const SizedBox(height: 8),
        DropdownButtonFormField<String>(
          initialValue: _projectId,
          isExpanded: true,
          decoration: InputDecoration(
            labelText: context.t('mob.rep.start.project.label'),
            errorText: _submitted && _projectId == null ? context.t('mob.rep.start.project.required') : null,
          ),
          hint: Text(context.t('mob.rep.start.project.choose')),
          items: <DropdownMenuItem<String>>[
            for (final ProjectOption project in widget.options.projects)
              DropdownMenuItem<String>(value: project.id, child: Text(context.t('mob.rep.start.project.option', <String, Object>{'code': project.code, 'name': project.name}), overflow: TextOverflow.ellipsis)),
          ],
          onChanged: _busy ? null : (String? id) => setState(() => _projectId = id),
        ),
        const SizedBox(height: 8),
        Semantics(header: true, child: Text(context.t('mob.rep.basis.title'), style: Theme.of(context).textTheme.titleSmall)),
        RadioGroup<String>(
          groupValue: _basisOrDefault,
          onChanged: (String? basis) {
            if (basis != null && !_busy) setState(() => _basis = basis);
          },
          child: Column(
            children: <Widget>[
              for (final String basis in kBases) RadioListTile<String>(value: basis, title: Text(basisLabel(context, basis))),
            ],
          ),
        ),
        Text(context.t('mob.rep.start.plan.label'), style: Theme.of(context).textTheme.titleSmall),
        Text(context.t('mob.rep.start.plan.body'), style: Theme.of(context).textTheme.bodyMedium),
        const SizedBox(height: 16),
        FilledButton(
          onPressed: readOnly || _busy ? null : _create,
          child: Text(_busy ? context.t('mob.rep.start.create.pending') : context.t('mob.rep.start.create.action')),
        ),
        const SizedBox(height: 8),
        OutlinedButton(
          onPressed: () => openScreen(context, 'MOB-22', stacked: true),
          child: Text(context.t('mob.rep.start.drafts.action')),
        ),
      ],
    );
  }
}
