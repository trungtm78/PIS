import 'package:flutter/material.dart';

import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/widgets/app_scaffold.dart';
import '../../read_support/data_view.dart';
import '../../read_support/loaded.dart';
import '../../read_support/navigate.dart';
import '../pwf_models.dart';
import '../pwf_progress_section.dart';
import '../pwf_workflow_panel.dart';

/// MOB-78: the workflow of one project. The strip of its stages, the tasks by official colour, the milestones ahead and the tasks of each stage with
/// their deadline bands. It only reads (the templates and the rules are edited on the desktop); the colours are the official ones, the same for every
/// reader; a copy kept on the device says the moment it describes and is marked out of date when it is.
Widget buildWorkflowScreen(BuildContext context, ScreenContext screen) => PwfWorkflowScreen(projectId: screen.pathParameters['projectId'] ?? '');

class PwfWorkflowScreen extends StatelessWidget {
  const PwfWorkflowScreen({required this.projectId, super.key});

  final String projectId;

  @override
  Widget build(BuildContext context) {
    return AppScaffold(
      title: context.t('mob.pwf.workflow.title'),
      body: DataView<PwfWorkflowView>(
        cacheKey: 'pwf.workflow.screen.$projectId',
        read: (client) => readPwfWorkflow(client, projectId),
        parse: parsePwfWorkflowView,
        asOf: (PwfWorkflowView view) => view is PwfWorkflowPresent ? view.workflow.asOf : null,
        builder: (BuildContext context, Loaded<PwfWorkflowView> loaded) {
          final PwfWorkflowView view = loaded.value;
          if (view is! PwfWorkflowPresent) return const PwfNoWorkflow();
          return ListView(
            children: <Widget>[
              PwfWorkflowPanel(workflow: view.workflow, onOpenTask: (PwfTaskRow task) => openScreen(context, 'MOB-79', pathSuffix: '/${Uri.encodeComponent(task.id)}', stacked: true)),
            ],
          );
        },
      ),
    );
  }
}
