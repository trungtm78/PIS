import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/di/providers.dart' show apiClientProvider;
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/widgets/app_scaffold.dart';
import '../../../core/widgets/state_view.dart';
import '../../read_support/data_view.dart';
import '../../read_support/loaded.dart';
import '../../read_support/navigate.dart';
import '../pwf_models.dart';
import '../pwf_progress_section.dart';
import '../pwf_row_sheet.dart';
import '../pwf_step_logic.dart';
import '../pwf_task_read.dart';
import '../pwf_workflow_panel.dart';

/// MOB-78: the workflow of one project as a list of steps (PWF-5). The head says which stage is open, how far the steps are, the deadline of the whole file with its
/// slip and the steps by official colour; under it the phases are sections of steps, each with its unit and holder (or "Chưa có người nhận"), its deadline with the dot in
/// the official colour, its state and what blocks it. A tap on a step opens its actions: take it ("Nhận việc"), hand in evidence, complete it, ask for more time, or open
/// the task. The templates and the rules are edited on the desktop; the colours are the official ones, the same for every reader; a copy kept on the device says the moment
/// it describes and is marked out of date when it is.
Widget buildWorkflowScreen(BuildContext context, ScreenContext screen) => PwfWorkflowScreen(projectId: screen.pathParameters['projectId'] ?? '');

class PwfWorkflowScreen extends ConsumerStatefulWidget {
  const PwfWorkflowScreen({required this.projectId, super.key});

  final String projectId;

  @override
  ConsumerState<PwfWorkflowScreen> createState() => _PwfWorkflowScreenState();
}

class _PwfWorkflowScreenState extends ConsumerState<PwfWorkflowScreen> {
  int _reload = 0;
  PwfRowOutcome? _notice;

  /// The schedule of the project, read beside the workflow for the slip of the whole file and the step that blocks another; null until it is read, and when it cannot be.
  PwfScheduleHints? _hints;
  int _hintsRead = 0;

  @override
  void initState() {
    super.initState();
    _readHints();
  }

  Future<void> _readHints() async {
    final int mine = ++_hintsRead;
    final PwfScheduleHints? hints = await readPwfScheduleHints(ref.read(apiClientProvider), widget.projectId);
    if (mounted && mine == _hintsRead) setState(() => _hints = hints);
  }

  void _read() {
    _readHints();
    setState(() => _reload += 1);
  }

  Future<void> _open(PwfTaskRow task, PwfWorkflow workflow, {required bool fresh}) async {
    final PwfRowOutcome? outcome = await showPwfRowSheet(context, task: task, workflow: workflow, projectId: workflow.projectId ?? widget.projectId, fresh: fresh);
    if (!mounted || outcome == null) return;
    if (outcome.notice != null) setState(() => _notice = outcome);
    if (outcome.reload) _read();
    if (outcome.openTask) openScreen(context, 'MOB-79', pathSuffix: '/${Uri.encodeComponent(task.id)}', stacked: true);
  }

  @override
  Widget build(BuildContext context) {
    return AppScaffold(
      title: context.t('mob.pwf.workflow.title'),
      body: DataView<PwfWorkflowView>(
        cacheKey: 'pwf.workflow.screen.${widget.projectId}',
        read: (client) => readPwfWorkflow(client, widget.projectId),
        parse: parsePwfWorkflowView,
        asOf: (PwfWorkflowView view) => view is PwfWorkflowPresent ? view.workflow.asOf : null,
        reloadKey: _reload,
        builder: (BuildContext context, Loaded<PwfWorkflowView> loaded) {
          final PwfWorkflowView view = loaded.value;
          if (view is! PwfWorkflowPresent) return const PwfNoWorkflow();
          final PwfRowOutcome? notice = _notice;
          return ListView(
            children: <Widget>[
              if (notice != null)
                StatusBanner(
                  text: notice.problem && notice.code != null ? context.t('mob.pwfs.notice.problem', <String, Object>{'text': notice.notice!, 'code': notice.code!}) : notice.notice!,
                  tone: notice.problem ? BannerTone.warning : BannerTone.info,
                  icon: notice.problem ? Icons.error_outline : Icons.check_circle_outline,
                  actionLabel: context.t('mob.pwfs.sheet.close'),
                  onAction: () => setState(() => _notice = null),
                ),
              PwfWorkflowPanel(workflow: view.workflow, hints: _hints, onOpenTask: (PwfTaskRow task) => _open(task, view.workflow, fresh: !loaded.fromCache)),
            ],
          );
        },
      ),
    );
  }
}
