import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';

import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/widgets/app_scaffold.dart';
import '../../read_support/data_view.dart';
import '../../read_support/loaded.dart';
import '../approval_models.dart';
import 'approval_detail_screen.dart';
import 'decision_panels.dart';

/// MOB-25: the confirmation of an approval as a screen (a deep link, or a push that opens the task: it never decides it). The detail opens
/// the same panel as a sheet; the rules are in [ApprovalConfirmPanel].
Widget buildApprovalConfirmScreen(BuildContext context, ScreenContext screen) => ApprovalConfirmScreen(taskId: screen.pathParameters['taskId'] ?? '');

class ApprovalConfirmScreen extends ConsumerWidget {
  const ApprovalConfirmScreen({required this.taskId, super.key});

  final String taskId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return AppScaffold(
      title: context.t('mob.apv.confirm.title'),
      body: DataView<ApprovalDetail>(
        cacheKey: 'approvals.task.$taskId',
        read: (MachvonApiClient client) => readApprovalDetail(client, taskId, withRecord: false),
        parse: parseApprovalDetail,
        builder: (BuildContext context, Loaded<ApprovalDetail> loaded) => ListView(
          children: <Widget>[ApprovalConfirmPanel(task: loaded.value.task, unitName: loaded.value.unitName, fromCopy: loaded.fromCache, host: PanelHost.screen)],
        ),
      ),
    );
  }
}
