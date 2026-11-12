import 'package:flutter/material.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/format/format.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
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
    return ScreenFrame(
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
              padding: const EdgeInsets.all(MachvonSpace.space16),
              child: Text(context.t('mob.paytrack.projects.intro'), style: Theme.of(context).textTheme.bodyMedium),
            ),
            for (final ProjectLine project in loaded.value.projects)
              TappableRow(
                semanticLabel: context.t('mob.paytrack.projects.row.aria', <String, Object>{'code': project.code, 'name': project.name}),
                onTap: () => openScreen(context, 'MOB-27', query: <String, String>{'project': project.id}, stacked: true),
                child: Row(
                  children: <Widget>[
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: <Widget>[
                          Text(project.code, style: Theme.of(context).textTheme.bodyLarge),
                          Text(project.name, style: Theme.of(context).textTheme.bodyMedium),
                        ],
                      ),
                    ),
                    const ExcludeSemantics(child: Icon(Icons.chevron_right)),
                  ],
                ),
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
    return ScreenFrame(
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
    final ThemeData theme = Theme.of(context);
    final List<ChainNode> contracts = chain.nodesOf('contract');
    final List<ChainNode> requests = chain.requests(contractId: contractId);
    return ListView(
      padding: const EdgeInsets.only(bottom: MachvonSpace.space24),
      children: <Widget>[
        SectionCard(
          title: context.t('mob.paytrack.chain.totals.title'),
          children: <Widget>[
            KpiGroup(
              columns: 1,
              tiles: <Widget>[
                KpiTile(label: context.t('mob.paytrack.chain.totals.count'), value: '${chain.countedRequests}'),
                KpiTile(label: context.t('mob.paytrack.chain.totals.gross'), value: moneyExactLabel(context, chain.countedGrossVnd)),
                KpiTile(label: context.t('mob.paytrack.chain.totals.settled'), value: moneyExactLabel(context, chain.settledGrossVnd)),
              ],
            ),
            const SizedBox(height: MachvonSpace.space8),
            Text(context.t('mob.paytrack.readOnly'), style: theme.textTheme.bodySmall),
          ],
        ),
        if (contracts.length > 1)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: MachvonSpace.space16, vertical: MachvonSpace.space8),
            child: DropdownButtonFormField<String?>(
              initialValue: contractId,
              isExpanded: true,
              decoration: InputDecoration(labelText: context.t('mob.paytrack.chain.contract.label')),
              items: <DropdownMenuItem<String?>>[
                DropdownMenuItem<String?>(child: Text(context.t('mob.paytrack.chain.contract.all'))),
                for (final ChainNode contract in contracts) DropdownMenuItem<String?>(value: contract.id, child: Text(contract.label)),
              ],
              onChanged: onContract,
            ),
          ),
        if (chain.truncated.isNotEmpty) Padding(padding: const EdgeInsets.symmetric(horizontal: MachvonSpace.space16), child: Text(context.t('mob.paytrack.chain.truncated'), style: theme.textTheme.bodySmall)),
        if (requests.isEmpty)
          Padding(padding: const EdgeInsets.all(MachvonSpace.space16), child: Text(context.t('mob.paytrack.chain.none'), style: theme.textTheme.bodyMedium)),
        for (final ChainNode request in requests) _RequestRow(projectId: projectId, request: request),
      ],
    );
  }
}

class _RequestRow extends StatelessWidget {
  const _RequestRow({required this.projectId, required this.request});

  final String projectId;
  final ChainNode request;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final String status = paymentStatusLabel(context, request.status ?? 'DRAFT');
    final String kind = paymentKindLabel(context, request.fact('request_kind') ?? 'INTERIM');
    final String? net = request.fact('net_vnd');
    final String? created = request.fact('created_at');
    final String amounts = context.t('mob.paytrack.chain.row.amounts', <String, Object>{
      'gross': request.amountVnd == null ? context.t('mob.treasury.figure.none') : moneyExactLabel(context, request.amountVnd),
      'net': net == null ? context.t('mob.treasury.figure.none') : moneyExactLabel(context, net),
    });
    return TappableRow(
      semanticLabel: context.t('mob.paytrack.chain.row.aria', <String, Object>{'no': request.label, 'kind': kind, 'status': status, 'amounts': amounts}),
      onTap: () => openScreen(context, 'MOB-27', query: <String, String>{'project': projectId, 'request': request.id}, stacked: true),
      child: Row(
        children: <Widget>[
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(request.label, style: theme.textTheme.bodyLarge),
                Text(kind, style: theme.textTheme.bodyMedium),
                StatusPill(label: status),
                Text(amounts, style: theme.textTheme.bodyMedium),
                if (created != null) Text(context.t('mob.paytrack.chain.row.created', <String, Object>{'time': formatMoment(created)}), style: theme.textTheme.bodySmall),
              ],
            ),
          ),
          const ExcludeSemantics(child: Icon(Icons.chevron_right)),
        ],
      ),
    );
  }
}

class _RequestScreen extends StatelessWidget {
  const _RequestScreen({required this.projectId, required this.requestId});

  final String projectId;
  final String requestId;

  @override
  Widget build(BuildContext context) {
    return ScreenFrame(
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
    final ThemeData theme = Theme.of(context);
    final PaymentRequest request = timeline.request;
    return ListView(
      padding: const EdgeInsets.only(bottom: MachvonSpace.space24),
      children: <Widget>[
        SectionCard(
          title: request.requestNo,
          children: <Widget>[
            Wrap(
              spacing: MachvonSpace.space8,
              children: <Widget>[StatusPill(label: paymentStatusLabel(context, request.status)), StatusPill(label: paymentKindLabel(context, request.kind))],
            ),
            if (request.contractCode.isNotEmpty) FactLine(label: context.t('mob.paytrack.request.contract'), value: request.contractCode),
            if (timeline.lastEventAt != null) FactLine(label: context.t('mob.paytrack.request.lastEvent'), value: formatMoment(timeline.lastEventAt!)),
            if (request.returnReason != null) Text(context.t('mob.paytrack.request.returnReason', <String, Object>{'reason': request.returnReason!}), style: theme.textTheme.bodyMedium),
            if (request.cancelReason != null) Text(context.t('mob.paytrack.request.cancelReason', <String, Object>{'reason': request.cancelReason!}), style: theme.textTheme.bodyMedium),
            Text(context.t('mob.paytrack.readOnly'), style: theme.textTheme.bodySmall),
          ],
        ),
        SectionCard(
          title: context.t('mob.paytrack.amounts.title'),
          children: <Widget>[
            KpiTile(label: context.t('mob.paytrack.amounts.gross'), value: moneyExactLabel(context, request.grossVnd)),
            const SizedBox(height: MachvonSpace.space8),
            FactLine(label: context.t('mob.paytrack.amounts.advance'), value: moneyExactLabel(context, request.advanceRecoveryVnd)),
            FactLine(label: context.t('mob.paytrack.amounts.retention'), value: moneyExactLabel(context, request.retentionVnd)),
            if (request.taxAdjustmentVnd != null) FactLine(label: context.t('mob.paytrack.amounts.tax'), value: moneyExactLabel(context, request.taxAdjustmentVnd)),
            if (request.advanceRecoveryExtraVnd != null) FactLine(label: context.t('mob.paytrack.amounts.extra'), value: moneyExactLabel(context, request.advanceRecoveryExtraVnd)),
            const SizedBox(height: MachvonSpace.space8),
            KpiTile(label: context.t('mob.paytrack.amounts.net'), value: moneyExactLabel(context, request.netVnd)),
          ],
        ),
        SectionCard(
          title: context.t('mob.paytrack.events.title'),
          children: <Widget>[
            if (timeline.events.isEmpty) Text(context.t('mob.paytrack.events.none'), style: theme.textTheme.bodyMedium),
            for (final TimelineEvent event in timeline.events) _EventLine(event: event),
          ],
        ),
      ],
    );
  }
}

class _EventLine extends StatelessWidget {
  const _EventLine({required this.event});

  final TimelineEvent event;

  String _name(BuildContext context) {
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

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final String? when = event.instant != null ? formatMoment(event.instant!) : (event.day != null ? formatDay(event.day!) : null);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: MachvonSpace.space8),
      child: MergeSemantics(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Text(_name(context), style: theme.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600)),
            if (when != null) Text(when, style: theme.textTheme.bodySmall),
            if (event.amountVnd != null) Text(moneyExactLabel(context, event.amountVnd), style: theme.textTheme.bodySmall),
          ],
        ),
      ),
    );
  }
}
