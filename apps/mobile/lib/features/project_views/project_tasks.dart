import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/l10n/app_strings.dart';
import '../../core/widgets/deadline.dart';
import '../../core/widgets/work_row.dart';

/// One task of the workflow of a project, as the Progress tab lists it. The deadline is what the server counted in Vietnam time
/// ([daysRemaining], negative when passed): the phone never counts days from its own clock.
final class ProjectTaskItem {
  const ProjectTaskItem({required this.id, required this.title, required this.daysRemaining, this.dueDay, this.subtitle, this.done = false});

  final String id;
  final String title;
  final int daysRemaining;

  /// The day the task falls due, `YYYY-MM-DD`.
  final String? dueDay;
  final String? subtitle;
  final bool done;
}

/// Where the tasks of a project come from. The workflow of a project (PWF) is a later wave: today the source gives none, so the Progress tab
/// shows its milestones alone. When the API of the workflow exists, an implementation of this port replaces [EmptyProjectTaskSource] in
/// [projectTaskSourceProvider] and the tab draws the list with no other change.
abstract interface class ProjectTaskSource {
  Future<List<ProjectTaskItem>> tasksOf(String projectId);
}

/// The source of today: no tasks.
final class EmptyProjectTaskSource implements ProjectTaskSource {
  const EmptyProjectTaskSource();

  @override
  Future<List<ProjectTaskItem>> tasksOf(String projectId) async => const <ProjectTaskItem>[];
}

final Provider<ProjectTaskSource> projectTaskSourceProvider = Provider<ProjectTaskSource>((Ref ref) => const EmptyProjectTaskSource());

final projectTasksProvider =
    FutureProvider.autoDispose.family<List<ProjectTaskItem>, String>((Ref ref, String projectId) => ref.watch(projectTaskSourceProvider).tasksOf(projectId));

/// The tasks of a project as rows with their deadline band, late first. It draws nothing while there are none (and while they load or
/// cannot be read): the milestones above it are the content of the tab, and a task list that is not there yet is not an empty state.
class ProjectTaskList extends ConsumerWidget {
  const ProjectTaskList({required this.projectId, super.key});

  final String projectId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final List<ProjectTaskItem> tasks = ref.watch(projectTasksProvider(projectId)).asData?.value ?? const <ProjectTaskItem>[];
    if (tasks.isEmpty) return const SizedBox.shrink();
    final List<ProjectTaskItem> sorted = <ProjectTaskItem>[...tasks]..sort((ProjectTaskItem a, ProjectTaskItem b) {
        if (a.done != b.done) return a.done ? 1 : -1;
        return a.daysRemaining.compareTo(b.daysRemaining);
      });
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        GroupHeader(title: context.t('mob.prj.detail.tasks.title'), count: sorted.length),
        for (int index = 0; index < sorted.length; index += 1)
          sorted[index].done
              ? WorkRow(
                  title: sorted[index].title,
                  subtitle: sorted[index].subtitle,
                  leading: const DeadlineGlyph(band: DeadlineBand.done),
                  trailing: DeadlineLabel(band: DeadlineBand.done, text: context.t('mob.prj.detail.milestone.done'), dueDay: sorted[index].dueDay),
                  dividerAbove: index > 0,
                )
              : WorkRow.deadline(title: sorted[index].title, subtitle: sorted[index].subtitle, daysRemaining: sorted[index].daysRemaining, dueDay: sorted[index].dueDay, dividerAbove: index > 0),
      ],
    );
  }
}
