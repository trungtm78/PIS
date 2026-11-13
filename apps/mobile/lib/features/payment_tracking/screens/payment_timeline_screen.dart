import 'package:flutter/material.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/format/format.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/theme/colors.dart';
import '../../../core/theme/typography.dart';
import '../../../core/widgets/app_scaffold.dart';
import '../../../core/widgets/filter_chips.dart';
import '../../../core/widgets/info_row.dart';
import '../../../core/widgets/stage_strip.dart';
import '../../../core/widgets/state_view.dart';
import '../../../core/widgets/timeline.dart';
import '../../acceptance_handover/widgets/fact_row.dart';
import '../../project_views/project_models.dart';
import '../../read_support/data_view.dart';
import '../../read_support/loaded.dart';
import '../../read_support/navigate.dart';
import '../../read_support/paged.dart';
import '../../read_support/widgets.dart';
import '../payment_models.dart';
import '../payment_support.dart';

/// MOB-27: the payment requests of a project on a timeline. Three views of one screen, by what the location names:
///
///  * `/projects/mob-27`: the projects, to choose one;
///  * `?project=<id>`: the chain of the project, the payment requests in the order they were drawn up, with their status and amounts;
///  * `?project=<id>&request=<id>`: one request: its amounts and what happened to it, with the Treasury's transactions.
///
/// It only reads. The phone does not draw up, change or send a payment request (MOB.md 2, the accountant follows payments and
/// reconciles), so no view of this screen offers to create one, whatever the server says the person may do. Amounts are whole dong shown
/// in full, never rounded; every moment is the server's. A copy kept on the device says the moment it describes.
Widget buildPaymentTimelineScreen(BuildContext context, ScreenContext screen) {
  final String? project = screen.queryParameters['project'];
  final String? request = screen.queryParameters['request'];
  if (project == null || project.isEmpty) return const _ProjectsScreen();
  if (request == null || request.isEmpty) return _ChainScreen(projectId: project, contractId: screen.queryParameters['contract']);
  return _RequestScreen(projectId: project, requestId: request);
}

Future<Object?> _readChain(MachvonApiClient client, String projectId) => client.getPaymentChain(query: <String, Object?>{'project_id': projectId});

Future<Object?> _readRequest(MachvonApiClient client, String projectId, String requestId) async {
  final Object? request = await client.getResourcesPaymentRequestId(id: requestId);
  return <String, Object?>{'chain': await _readChain(client, projectId), 'request': request};
}

class _ProjectsScreen extends StatelessWidget {
  const _ProjectsScreen();

  @override
  Widget build(BuildContext context) {
    return AppScaffold(
      title: context.t('mob.paytrack.projects.title'),
      body: DataView<ProjectRegister>(
        cacheKey: 'paytrack.projects',
        read: (MachvonApiClient client) => readMerged(client, 'get_resources_project', query: <String, Object?>{'limit': 200}),
        parse: parseProjectRegister,
        asOf: (ProjectRegister register) => register.asOf,
        isEmpty: (ProjectRegister register) => register.projects.isEmpty,
        builder: (BuildContext context, Loaded<ProjectRegister> loaded) => ListView(
          children: <Widget>[
            Padding(
              padding: const EdgeInsets.fromLTRB(MachvonV2Space.s16, MachvonV2Space.s4, MachvonV2Space.s16, MachvonV2Space.s12),
              child: Text(context.t('mob.paytrack.projects.intro'), style: context.v2text.caption.copyWith(color: context.v2.palette.ink2)),
            ),
            for (int index = 0; index < loaded.value.projects.length; index += 1)
              FactRow(
                title: loaded.value.projects[index].code,
                icon: Icons.account_balance_wallet_outlined,
                lines: <String>[loaded.value.projects[index].name],
                dividerAbove: index > 0,
                semanticLabel: context.t('mob.paytrack.projects.row.aria', <String, Object>{'code': loaded.value.projects[index].code, 'name': loaded.value.projects[index].name}),
                onTap: () => openScreen(context, 'MOB-27', query: <String, String>{'project': loaded.value.projects[index].id}, stacked: true),
              ),
          ],
        ),
      ),
    );
  }
}

class _ChainScreen extends StatefulWidget {
  const _ChainScreen({required this.projectId, this.contractId});

  final String projectId;
  final String? contractId;

  @override
  State<_ChainScreen> createState() => _ChainScreenState();
}

class _ChainScreenState extends State<_ChainScreen> {
  late String? _contract = widget.contractId;

  @override
  Widget build(BuildContext context) {
    return AppScaffold(
      title: context.t('mob.paytrack.chain.title'),
      body: DataView<PaymentChain>(
        cacheKey: 'paytrack.chain.${widget.projectId}',
        read: (MachvonApiClient client) => _readChain(client, widget.projectId),
        parse: parseChain,
        asOf: (PaymentChain chain) => chain.asOf,
        builder: (BuildContext context, Loaded<PaymentChain> loaded) => _ChainBody(
          projectId: widget.projectId,
          chain: loaded.value,
          contractId: _contract,
          onContract: (String? id) => setState(() => _contract = id),
        ),
      ),
    );
  }
}

class _ChainBody extends StatelessWidget {
  const _ChainBody({required this.projectId, required this.chain, required this.contractId, required this.onContract});

  final String projectId;
  final PaymentChain chain;
  final String? contractId;
  final ValueChanged<String?> onContract;

  @override
  Widget build(BuildContext context) {
    final MachvonV2Text text = context.v2text;
    final List<ChainNode> contracts = chain.nodesOf('contract');
    final List<ChainNode> requests = chain.requests(contractId: contractId);
    return ListView(
      padding: const EdgeInsets.only(bottom: MachvonV2Space.s24),
      children: <Widget>[
        SectionCard(
          title: context.t('mob.paytrack.chain.totals.title'),
          children: <Widget>[
            InfoRow(label: context.t('mob.paytrack.chain.totals.count'), value: '${chain.countedRequests}', divider: false),
            InfoRow(label: context.t('mob.paytrack.chain.totals.gross'), value: moneyExactLabel(context, chain.countedGrossVnd)),
            InfoRow(label: context.t('mob.paytrack.chain.totals.settled'), value: moneyExactLabel(context, chain.settledGrossVnd)),
            Padding(padding: const EdgeInsets.only(top: MachvonV2Space.s8), child: Text(context.t('mob.paytrack.readOnly'), style: text.caption)),
          ],
        ),
        if (contracts.length > 1)
          FilterChips<String?>(
            options: <ChipOption<String?>>[
              ChipOption<String?>(value: null, label: context.t('mob.paytrack.chain.contract.all')),
              for (final ChainNode contract in contracts) ChipOption<String?>(value: contract.id, label: contract.label),
            ],
            selected: contractId,
            onChanged: onContract,
          ),
        if (chain.truncated.isNotEmpty) StatusBanner(text: context.t('mob.paytrack.chain.truncated'), tone: BannerTone.warning),
        if (requests.isEmpty)
          SizedBox(
            height: 360,
            child: StateView(
              kind: StateKind.empty,
              title: context.t('mob.paytrack.chain.none'),
              body: context.t('mob.paytrack.chain.none.body'),
              actionLabel: contractId == null ? context.t('mob.paytrack.chain.none.other') : context.t('mob.paytrack.chain.none.action'),
              onAction: contractId == null ? () => openScreen(context, 'MOB-27') : () => onContract(null),
            ),
          ),
        for (int index = 0; index < requests.length; index += 1) _RequestRow(projectId: projectId, request: requests[index], dividerAbove: index > 0),
      ],
    );
  }
}

class _RequestRow extends StatelessWidget {
  const _RequestRow({required this.projectId, required this.request, required this.dividerAbove});

  final String projectId;
  final ChainNode request;
  final bool dividerAbove;

  @override
  Widget build(BuildContext context) {
    final String statusCode = request.status ?? 'DRAFT';
    final String status = paymentStatusLabel(context, statusCode);
    final String kind = paymentKindLabel(context, request.fact('request_kind') ?? 'INTERIM');
    final String? net = request.fact('net_vnd');
    final String? created = request.fact('created_at');
    final String amounts = context.t('mob.paytrack.chain.row.amounts', <String, Object>{
      'gross': request.amountVnd == null ? context.t('mob.treasury.figure.none') : moneyExactLabel(context, request.amountVnd),
      'net': net == null ? context.t('mob.treasury.figure.none') : moneyExactLabel(context, net),
    });
    return FactRow(
      title: request.label,
      icon: Icons.receipt_long_outlined,
      lines: <String>[
        kind,
        amounts,
        if (created != null) context.t('mob.paytrack.chain.row.created', <String, Object>{'time': formatMoment(created)}),
      ],
      trailing: StatusPill(label: status, tone: paymentTone(statusCode)),
      dividerAbove: dividerAbove,
      semanticLabel: context.t('mob.paytrack.chain.row.aria', <String, Object>{'no': request.label, 'kind': kind, 'status': status, 'amounts': amounts}),
      onTap: () => openScreen(context, 'MOB-27', query: <String, String>{'project': projectId, 'request': request.id}, stacked: true),
    );
  }
}

class _RequestScreen extends StatelessWidget {
  const _RequestScreen({required this.projectId, required this.requestId});

  final String projectId;
  final String requestId;

  @override
  Widget build(BuildContext context) {
    return AppScaffold(
      title: context.t('mob.paytrack.request.title'),
      body: DataView<PaymentTimeline>(
        cacheKey: 'paytrack.request.$requestId',
        read: (MachvonApiClient client) => _readRequest(client, projectId, requestId),
        parse: parsePaymentTimeline,
        asOf: (PaymentTimeline timeline) => timeline.asOf,
        builder: (BuildContext context, Loaded<PaymentTimeline> loaded) => _TimelineBody(timeline: loaded.value),
      ),
    );
  }
}

class _TimelineBody extends StatelessWidget {
  const _TimelineBody({required this.timeline});

  final PaymentTimeline timeline;

  @override
  Widget build(BuildContext context) {
    final MachvonV2Text text = context.v2text;
    final PaymentRequest request = timeline.request;
    final int? step = paymentStep(request.status);
    return ListView(
      padding: const EdgeInsets.only(bottom: MachvonV2Space.s24),
      children: <Widget>[
        SectionCard(
          title: request.requestNo,
          children: <Widget>[
            Wrap(
              spacing: MachvonV2Space.s8,
              runSpacing: MachvonV2Space.s4,
              children: <Widget>[
                StatusPill(label: paymentStatusLabel(context, request.status), tone: paymentTone(request.status)),
                StatusPill(label: paymentKindLabel(context, request.kind), tone: MachvonTone.neutral),
              ],
            ),
            InfoRow(label: context.t('mob.paytrack.request.contract'), value: request.contractCode),
            InfoRow(label: context.t('mob.paytrack.request.lastEvent'), value: timeline.lastEventAt == null ? null : formatMoment(timeline.lastEventAt!)),
            if (request.returnReason != null) Padding(padding: const EdgeInsets.only(top: MachvonV2Space.s8), child: Text(context.t('mob.paytrack.request.returnReason', <String, Object>{'reason': request.returnReason!}), style: text.body)),
            if (request.cancelReason != null) Padding(padding: const EdgeInsets.only(top: MachvonV2Space.s8), child: Text(context.t('mob.paytrack.request.cancelReason', <String, Object>{'reason': request.cancelReason!}), style: text.body)),
            Padding(padding: const EdgeInsets.only(top: MachvonV2Space.s8), child: Text(context.t('mob.paytrack.readOnly'), style: text.caption)),
          ],
        ),
        if (step != null)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: MachvonV2Space.s8),
            child: StageStrip(
              total: paymentSteps,
              current: step,
              currentFraction: 1,
              label: context.t('mob.paytrack.request.stage', <String, Object>{'n': step, 'total': paymentSteps, 'status': paymentStatusLabel(context, request.status)}),
            ),
          ),
        SectionCard(
          title: context.t('mob.paytrack.amounts.title'),
          children: <Widget>[
            InfoRow(label: context.t('mob.paytrack.amounts.gross'), value: moneyExactLabel(context, request.grossVnd), divider: false),
            InfoRow(label: context.t('mob.paytrack.amounts.advance'), value: moneyExactLabel(context, request.advanceRecoveryVnd)),
            InfoRow(label: context.t('mob.paytrack.amounts.retention'), value: moneyExactLabel(context, request.retentionVnd)),
            InfoRow(label: context.t('mob.paytrack.amounts.tax'), value: request.taxAdjustmentVnd == null ? null : moneyExactLabel(context, request.taxAdjustmentVnd)),
            InfoRow(label: context.t('mob.paytrack.amounts.extra'), value: request.advanceRecoveryExtraVnd == null ? null : moneyExactLabel(context, request.advanceRecoveryExtraVnd)),
            InfoRow(label: context.t('mob.paytrack.amounts.net'), value: moneyExactLabel(context, request.netVnd)),
          ],
        ),
        SectionCard(
          title: context.t('mob.paytrack.events.title'),
          children: <Widget>[
            if (timeline.events.isEmpty) Text(context.t('mob.paytrack.events.none'), style: text.body) else TimelineList(entries: <TimelineEntry>[for (final TimelineEvent event in timeline.events) _entry(context, event)]),
          ],
        ),
      ],
    );
  }
}

String _eventName(BuildContext context, TimelineEvent event) {
  switch (event.kind) {
    case 'created':
      return context.t('mob.paytrack.event.created');
    case 'submitted':
      return context.t('mob.paytrack.event.submitted');
    case 'sentTreasury':
      return context.t('mob.paytrack.event.sentTreasury');
    case 'transaction':
      return context.t('mob.paytrack.event.transaction', <String, Object>{'voucher': event.label ?? ''});
    case 'refund':
      return context.t('mob.paytrack.event.refund', <String, Object>{'voucher': event.label ?? ''});
    case 'paid':
      return context.t('mob.paytrack.event.paid');
    case 'reversed':
      return context.t('mob.paytrack.event.reversed');
    default:
      return context.t('mob.paytrack.event.settlement', <String, Object>{'label': event.label ?? ''});
  }
}

IconData _eventIcon(String kind) => switch (kind) {
      'created' => Icons.edit_note,
      'submitted' => Icons.outbox_outlined,
      'sentTreasury' => Icons.account_balance_outlined,
      'transaction' => Icons.swap_horiz,
      'refund' || 'reversed' => Icons.undo,
      'paid' => Icons.check_circle_outline,
      _ => Icons.task_alt,
    };

TimelineEntry _entry(BuildContext context, TimelineEvent event) {
  final String? when = event.instant != null ? formatMoment(event.instant!) : (event.day != null ? formatDay(event.day!) : null);
  return TimelineEntry(
    title: _eventName(context, event),
    when: when ?? '',
    detail: event.amountVnd == null ? null : moneyExactLabel(context, event.amountVnd),
    icon: _eventIcon(event.kind),
  );
}
