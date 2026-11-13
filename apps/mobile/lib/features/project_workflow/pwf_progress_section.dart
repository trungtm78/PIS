import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../core/api/problem.dart';
import '../../core/di/providers.dart' show apiClientProvider;
import '../../core/format/format.dart';
import '../../core/l10n/app_strings.dart';
import '../../core/session/session.dart';
import '../../core/state/screen_state.dart';
import '../../core/theme/typography.dart';
import '../../core/widgets/work_row.dart';
import '../read_support/clock.dart';
import '../read_support/loaded.dart';
import '../read_support/navigate.dart';
import '../read_support/read_cache.dart';
import 'pwf_models.dart';
import 'pwf_workflow_panel.dart';

/// The read of the workflow of a project, with the rules of BR-MOB-01 for a copy kept on the device: the server is asked first; when it cannot be
/// reached the copy of the last read is shown with the moment it describes; a refusal never falls back to a copy and drops it. A project with no
/// workflow (the server answers 404) is a result, not a failure: [PwfWorkflowAbsent].
Future<Object?> readPwfWorkflow(MachvonApiClient client, String projectId) async {
  try {
    return await client.getProjectWorkflow(projectId: projectId);
  } on ApiError catch (error) {
    if (error.status == 404) return <String, Object?>{'absent': true};
    rethrow;
  }
}

final pwfWorkflowProvider = FutureProvider.autoDispose.family<Loaded<PwfWorkflowView>, String>((Ref ref, String projectId) async {
  final SessionSnapshot session = ref.watch(sessionProvider);
  final String? tenant = session.tenantId;
  final String? user = session.userId;
  final MachvonApiClient client = ref.watch(apiClientProvider);
  final ReadCache cache = ref.read(readCacheProvider);
  final DateTime Function() now = ref.read(clockProvider);
  final String key = 'pwf.workflow.$projectId';
  final CacheScope? scope = tenant == null || user == null ? null : CacheScope(tenantId: tenant, userId: user);
  try {
    final Object? raw = await readPwfWorkflow(client, projectId);
    final PwfWorkflowView? value = parsePwfWorkflowView(raw);
    if (value == null) throw const ContractMismatch('getProjectWorkflow', 'does not hold what the screen needs');
    final DateTime fetchedAt = now();
    final String? asOf = value is PwfWorkflowPresent ? value.workflow.asOf : null;
    if (scope != null) await cache.write(scope, key, CacheEntry(raw: raw, asOf: asOf, fetchedAt: fetchedAt));
    return Loaded<PwfWorkflowView>(value: value, source: DataSource.network, asOf: asOf, fetchedAt: fetchedAt);
  } on ApiError catch (error) {
    if (error.code == networkErrorCode && scope != null) {
      final CacheEntry? entry = await cache.read(scope, key);
      final PwfWorkflowView? copy = entry == null ? null : parsePwfWorkflowView(entry.raw);
      if (entry != null && copy != null) return Loaded<PwfWorkflowView>(value: copy, source: DataSource.cache, asOf: entry.asOf, fetchedAt: entry.fetchedAt);
    } else if (scope != null && (error.status == 403 || error.status == 401)) {
      await cache.forget(scope, key);
    }
    rethrow;
  }
});

/// The Progress tab of a project (and the body of MOB-78): the strip of the stages of its workflow, the tasks by official colour, the milestones ahead
/// and the tasks of each stage. It is a column that sits inside the scroll of the screen that hosts it. A project that has no workflow, or a person who
/// may not read it, draws nothing here: the milestones of the project are the content of the tab and a task list that is not there is not an empty state.
class PwfProgressSection extends ConsumerWidget {
  const PwfProgressSection({required this.projectId, this.showMilestones = true, super.key});

  final String projectId;

  /// The milestones ahead are a group of their own in the panel; a screen that already lists the milestones of the project says false.
  final bool showMilestones;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final AsyncValue<Loaded<PwfWorkflowView>> read = ref.watch(pwfWorkflowProvider(projectId));
    final MachvonV2Text text = context.v2text;
    return read.when(
      loading: () => const Column(children: <Widget>[WorkRowSkeleton(), WorkRowSkeleton(), WorkRowSkeleton()]),
      error: (Object error, StackTrace _) {
        final ProblemView problem = ProblemView.from(error);
        if (problem.state == ScreenState.denied) return const SizedBox.shrink();
        return Padding(
          padding: const EdgeInsets.all(MachvonV2Space.s16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text(context.t('mob.pwf.section.failed', <String, Object>{'code': problem.code}), style: text.body),
              TextButton(onPressed: () => ref.invalidate(pwfWorkflowProvider(projectId)), child: Text(context.t('mob.pwf.section.retry'))),
            ],
          ),
        );
      },
      data: (Loaded<PwfWorkflowView> loaded) {
        final PwfWorkflowView view = loaded.value;
        if (view is! PwfWorkflowPresent) return const SizedBox.shrink();
        final String? asOf = loaded.asOf;
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            if (asOf != null)
              Padding(
                padding: const EdgeInsets.only(left: MachvonV2Space.s16, top: MachvonV2Space.s12, right: MachvonV2Space.s16),
                child: Text(
                  loaded.fromCache ? context.t('mob.pwf.section.saved', <String, Object>{'time': asOfLabel(asOf, language: AppStrings.of(context).language)}) : context.t('mob.pwf.section.asOf', <String, Object>{'time': asOfLabel(asOf, language: AppStrings.of(context).language)}),
                  style: text.caption,
                ),
              ),
            PwfWorkflowPanel(workflow: view.workflow, showMilestones: showMilestones, onOpenTask: (PwfTaskRow task) => openScreen(context, 'MOB-79', pathSuffix: '/${Uri.encodeComponent(task.id)}', stacked: true)),
          ],
        );
      },
    );
  }
}
