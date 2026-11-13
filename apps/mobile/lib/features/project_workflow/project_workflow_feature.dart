import '../../core/navigation/feature.dart';
import 'pwf_commands.dart';
import 'pwf_strings.dart';
import 'screens/deadline_preference_screen.dart';
import 'screens/my_score_screen.dart';
import 'screens/my_tasks_screen.dart';
import 'screens/task_detail_screen.dart';
import 'screens/workflow_screen.dart';

/// PWF on the phone (ST-MOB-019): MOB-78 the workflow of a project (the strip of its stages and its tasks by official colour), MOB-79 one task (the
/// checklist, the documents, the evidence, and what the person can do: start, give evidence, complete, ask for more time), MOB-80 "Việc của tôi" by
/// deadline (the colours of the person's own settings, said to be theirs, always with the real day), MOB-81 the score of the person (read-only, never
/// kept on the device) and MOB-82 the reminders of the person.
///
/// The work on a task is queued on the device and sent as `pwf.task.*` commands on the version of the task that was read; an approval and a return
/// are made online. A command that came back in conflict is settled in MOB-79, where the person sees the task as it is now: the queue sends them there and not to the comparison of MOB-42, because what they did on a task
/// is not a field of the record to choose between.
const MobileFeature feature = MobileFeature(
  id: 'project_workflow',
  strings: pwfStrings,
  screens: <ScreenSpec>[
    ScreenSpec(screenId: 'MOB-78', pathSuffix: '/:projectId', builder: buildWorkflowScreen),
    ScreenSpec(screenId: 'MOB-79', pathSuffix: '/:taskId', builder: buildTaskDetailScreen),
    ScreenSpec(screenId: 'MOB-80', builder: buildMyTasksScreen),
    ScreenSpec(screenId: 'MOB-81', builder: buildMyScoreScreen),
    ScreenSpec(screenId: 'MOB-82', builder: buildDeadlinePreferenceScreen),
  ],
  conflictScreens: <String, ConflictScreenOf>{
    kPwfStartCommand: pwfConflictScreen,
    kPwfChecklistCommand: pwfConflictScreen,
    kPwfEvidenceCommand: pwfConflictScreen,
    kPwfCompleteCommand: pwfConflictScreen,
    kPwfExceptionCommand: pwfConflictScreen,
  },
);
