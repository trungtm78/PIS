import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';

import '../../core/di/providers.dart';
import '../../core/format/format.dart';
import '../../core/l10n/app_strings.dart';
import '../../core/session/session.dart';
import '../../features/account/account_providers.dart';
import '../../features/read_support/widgets.dart';
import '../../features/read_support/wire.dart';
import '../../features/session/auth/identity_api.dart';
import '../../features/session/membership_label.dart';

/// The enterprise home on the phone, read only: the period status, the HPM push status and the EBS reconciliation status, each from the real
/// read operations of ENT-2 (`get_resources_reporting_period`, `getHpmConnection`, `getEbsConnection`, `listEbsDifferences`). A card whose read
/// is refused (the person has no `hpm.read`, `ebs.read`) is not drawn; a card whose read failed says so. Nothing here changes anything.

/// The hook of the enterprise snapshot reader (lane ENT-3a): when it is set, a card reads the snapshot through it. Unset by default, so the
/// home shows no snapshot card until that lane plugs its reader in.
final Provider<Future<Object?> Function(MachvonApiClient client)?> enterpriseSnapshotReaderProvider = Provider<Future<Object?> Function(MachvonApiClient client)?>((Ref ref) => null);

enum _Outcome { ok, refused, failed }

typedef _Reads = Future<Map<String, Object?>> Function(MachvonApiClient client);

/// A card that reads once when it is drawn.
class _ReadCard extends ConsumerStatefulWidget {
  const _ReadCard({required this.title, required this.read, required this.lines});

  final String Function(BuildContext context) title;
  final _Reads read;
  final List<String> Function(BuildContext context, Map<String, Object?> answer) lines;

  @override
  ConsumerState<_ReadCard> createState() => _ReadCardState();
}

class _ReadCardState extends ConsumerState<_ReadCard> {
  late final Future<(_Outcome, Map<String, Object?>)> _future = _run();

  Future<(_Outcome, Map<String, Object?>)> _run() async {
    try {
      return (_Outcome.ok, await widget.read(ref.read(apiClientProvider)));
    } on ApiError catch (error) {
      return (error.status == 401 || error.status == 403 ? _Outcome.refused : _Outcome.failed, const <String, Object?>{});
    }
  }

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<(_Outcome, Map<String, Object?>)>(
      future: _future,
      builder: (BuildContext context, AsyncSnapshot<(_Outcome, Map<String, Object?>)> snapshot) {
        final (_Outcome, Map<String, Object?>)? result = snapshot.data;
        if (result == null || result.$1 == _Outcome.refused) return const SizedBox.shrink();
        final ThemeData theme = Theme.of(context);
        final List<String> lines = result.$1 == _Outcome.ok ? widget.lines(context, result.$2) : <String>[context.t('mob.ent.card.unavailable')];
        return SectionCard(
          title: widget.title(context),
          semanticLabel: '${widget.title(context)}. ${lines.join('. ')}',
          children: <Widget>[for (final String line in lines) Text(line, style: theme.textTheme.bodyMedium)],
        );
      },
    );
  }
}

Json _object(Object? raw) => asRecord(raw) ?? const <String, Object?>{};

/// The period that runs today (its first day is not after today and its last day is not before it), else the next one that starts.
Json? currentPeriod(List<Object?> items, String today) {
  Json? upcoming;
  for (final Object? entry in items) {
    final Json? period = asRecord(entry);
    final String? from = filled(period?['start_date']);
    final String? to = filled(period?['end_date']);
    if (period == null || from == null || to == null) continue;
    if (from.compareTo(today) <= 0 && to.compareTo(today) >= 0) return period;
    if (from.compareTo(today) > 0 && (upcoming == null || from.compareTo(upcoming['start_date']! as String) < 0)) upcoming = period;
  }
  return upcoming;
}

Widget buildPeriodStatusCard(BuildContext context) => _ReadCard(
      title: (BuildContext context) => context.t('mob.ent.period.title'),
      read: (MachvonApiClient client) async => _object(await client.getResourcesReportingPeriod(query: <String, Object?>{'limit': 50})),
      lines: (BuildContext context, Map<String, Object?> answer) {
        final String today = vietnamTodayText();
        final Json? period = currentPeriod(listOf(answer['items']), today);
        if (period == null) return <String>[context.t('mob.ent.period.none')];
        final String deadline = filled(period['deadline_at']) == null ? '' : formatMoment(period['deadline_at']! as String);
        return <String>[
          context.t('mob.ent.period.current', <String, Object>{'code': text(period['code']) ?? '', 'from': formatDay(period['start_date']! as String), 'to': formatDay(period['end_date']! as String), 'deadline': deadline}),
          filled(period['locked_at']) != null ? context.t('mob.ent.period.locked') : context.t('mob.ent.period.open'),
        ];
      },
    );

String _hpmStatus(BuildContext context, String? status) {
  switch (status) {
    case 'FRESH':
      return context.t('mob.ent.hpm.fresh');
    case 'AGING':
      return context.t('mob.ent.hpm.aging');
    case 'STALE':
      return context.t('mob.ent.hpm.stale');
    case 'NEVER_PUSHED':
      return context.t('mob.ent.hpm.never');
  }
  return status ?? '';
}

Widget buildHpmStatusCard(BuildContext context) => _ReadCard(
      title: (BuildContext context) => context.t('mob.ent.hpm.title'),
      read: (MachvonApiClient client) async => _object(await client.getHpmConnection()),
      lines: (BuildContext context, Map<String, Object?> answer) {
        final Json health = _object(answer['health']);
        final Json counts = _object(answer['counts']);
        return <String>[
          context.t('mob.ent.hpm.status', <String, Object>{'status': _hpmStatus(context, text(health['status']))}),
          context.t('mob.ent.hpm.counts', <String, Object>{'pushes': count(counts['pushes']), 'accepted': count(counts['accepted']), 'failed': count(counts['failed']), 'rejected': count(counts['rejected'])}),
          if (count(health['awaiting_receipt']) > 0) context.t('mob.ent.hpm.awaiting', <String, Object>{'count': count(health['awaiting_receipt'])}),
          if (health['push_blocked'] == true) context.t('mob.ent.hpm.blocked'),
        ];
      },
    );

Widget buildEbsStatusCard(BuildContext context) => _ReadCard(
      title: (BuildContext context) => context.t('mob.ent.ebs.title'),
      read: (MachvonApiClient client) async => _object(await client.listEbsDifferences(query: <String, Object?>{'limit': 1})),
      lines: (BuildContext context, Map<String, Object?> answer) {
        final Json counts = _object(answer['counts']);
        if (count(counts['open']) == 0 && count(counts['overdue']) == 0 && count(counts['reviews_due']) == 0) return <String>[context.t('mob.ent.ebs.none')];
        return <String>[
          context.t('mob.ent.ebs.counts', <String, Object>{'open': count(counts['open']), 'overdue': count(counts['overdue']), 'resolved': count(counts['resolved'])}),
          if (count(counts['reviews_due']) > 0) context.t('mob.ent.ebs.reviews', <String, Object>{'count': count(counts['reviews_due'])}),
        ];
      },
    );

/// Today in Vietnam as `yyyy-MM-dd`, from the clock of the application.
String vietnamTodayText() {
  final DateTime now = DateTime.now().toUtc().add(const Duration(hours: 7));
  String two(int value) => value.toString().padLeft(2, '0');
  return '${now.year.toString().padLeft(4, '0')}-${two(now.month)}-${two(now.day)}';
}

/// The head of the enterprise home screens: the name of the product and, under it, the organisation and the role of the signed-in session
/// (read from the memberships of the person, as the account screen does; nothing is named here that the server did not say).
Widget buildEnterpriseHomeHeader(BuildContext context) => const _EnterpriseHomeHeader();

class _EnterpriseHomeHeader extends ConsumerWidget {
  const _EnterpriseHomeHeader();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final SessionSnapshot session = ref.watch(sessionProvider);
    final MembershipChoice? current = ref.watch(myMembershipsProvider).asData?.value.where((MembershipChoice m) => isCurrentMembership(m, session)).firstOrNull;
    final ThemeData theme = Theme.of(context);
    final String name = context.t('mob.ent.brand.name');
    final String product = context.t('mob.ent.brand.product');
    final String? line = current == null
        ? null
        : context.t('mob.ent.brand.role', <String, Object>{'organisation': current.tenantName, 'role': membershipTypeLabel(context, current.membershipType)});
    return Semantics(
      container: true,
      label: line == null ? '$name. $product' : '$name. $product. $line',
      child: ExcludeSemantics(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text(name, style: theme.textTheme.titleMedium?.copyWith(color: theme.colorScheme.primary, fontWeight: FontWeight.w700)),
              Text(product, style: theme.textTheme.labelLarge),
              if (line != null) Text(line, style: theme.textTheme.titleMedium),
            ],
          ),
        ),
      ),
    );
  }
}
