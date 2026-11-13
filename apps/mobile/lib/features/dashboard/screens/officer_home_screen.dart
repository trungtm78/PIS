import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/theme/colors.dart';
import '../../../core/widgets/nav_row.dart';
import '../../../core/widgets/stat_strip.dart';
import '../../../core/widgets/state_view.dart';
import '../../read_support/data_view.dart';
import '../../read_support/loaded.dart';
import '../../read_support/navigate.dart';
import '../../read_support/paged.dart';
import '../../read_support/widgets.dart';
import '../alert_badge.dart';
import '../alerts.dart';
import '../my_work.dart';
import '../widgets/alert_list.dart';
import '../widgets/edition_cards.dart';

/// The page size of the work list; the screen follows the pages to the end (or to the limit of pages).
const int workPageSize = 50;

/// MOB-08: "Today's work" of a reporting officer. One list, ordered by due day and grouped under the three bands (overdue, due soon, with
/// time), each a row with its deadline and one primary action; the report deadlines, the reports that came back, the drafts past their period
/// and the work given to the person are all in it, once, because they are one list of the server read in two vocabularies. A tap on a row
/// opens the whole alert (the clocks, who holds it, the other acts). Above the list, how many are open and how many are late.
Widget buildOfficerHomeScreen(BuildContext context, ScreenContext screen) =>
    const OfficerHomeScreen();

/// The work of the person read once: as groups by kind and as alerts by level.
final class OfficerHome {
  const OfficerHome({required this.work, required this.alerts});

  final MyWork work;
  final AlertFeed alerts;
}

OfficerHome? parseOfficerHome(Object? raw) {
  final MyWork? work = parseMyWork(raw);
  final AlertFeed? alerts = parseAlertFeed(raw);
  return work == null || alerts == null
      ? null
      : OfficerHome(work: work, alerts: alerts);
}

class OfficerHomeScreen extends ConsumerStatefulWidget {
  const OfficerHomeScreen({super.key});

  @override
  ConsumerState<OfficerHomeScreen> createState() => _OfficerHomeScreenState();
}

class _OfficerHomeScreenState extends ConsumerState<OfficerHomeScreen> {
  int _retry = 0;

  @override
  void initState() {
    super.initState();
    ref.read(alertBadgeProvider);
  }

  @override
  Widget build(BuildContext context) {
    return ScreenFrame(
      title: context.t('mob.home.officer.title'),
      body: DataView<OfficerHome>(
        cacheKey: 'home.work',
        reloadKey: (_retry, ref.watch(alertsChangedProvider)),
        read: (MachvonApiClient client) => readMerged(
          client,
          'getMyWork',
          query: <String, Object?>{'view': 'mine', 'limit': workPageSize},
        ),
        parse: parseOfficerHome,
        asOf: (OfficerHome home) => home.alerts.asOf,
        builder: (BuildContext context, Loaded<OfficerHome> loaded) =>
            _WorkBody(
              home: loaded.value,
              loaded: loaded,
              onRetry: () => setState(() => _retry += 1),
            ),
      ),
    );
  }
}

class _WorkBody extends StatelessWidget {
  const _WorkBody({
    required this.home,
    required this.loaded,
    required this.onRetry,
  });

  final OfficerHome home;
  final Loaded<OfficerHome> loaded;
  final VoidCallback onRetry;

  MyWork get work => home.work;

  @override
  Widget build(BuildContext context) {
    // Nothing is waiting and every source was read: the day is done. The edition's own cards stay, they read their own status.
    final bool done = home.alerts.isEmpty && home.alerts.isComplete;
    return ListView(
      padding: const EdgeInsets.only(bottom: MachvonV2Space.s24),
      children: <Widget>[
        const EditionHomeHeader(),
        if (work.total > 0)
          StatStrip(
            cells: <StatCell>[
              StatCell(
                value: '${work.total}',
                label: context.t('mob.home.officer.openCount.label'),
              ),
              StatCell(
                value: '${work.overdue}',
                label: context.t('mob.home.officer.lateCount.label'),
                band: work.overdue > 0 ? DeadlineBand.late : null,
                bandText: context.t('mob.home.work.bucket.overdue'),
              ),
            ],
          ),
        if (work.truncated)
          StatusBanner(
            tone: BannerTone.warning,
            icon: Icons.info_outline,
            text: context.t('mob.home.work.truncated'),
          ),
        if (done)
          SizedBox(
            height: 360,
            child: StateView(
              kind: StateKind.empty,
              icon: Icons.check_circle_outline,
              title: context.t('mob.home.officer.done.title'),
              body: context.t('mob.home.officer.done.body'),
              actionLabel: context.t('mob.home.link.unreported'),
              onAction: () => openScreen(context, 'MOB-57'),
            ),
          )
        else
          AlertsPanel(
            feed: home.alerts,
            onReload: onRetry,
            // Every alert that was read is shown: the page size of the read is not a limit of the display.
            limit: home.alerts.items.isEmpty ? 1 : home.alerts.items.length,
            groupByDeadline: true,
            title: context.t('mob.alert.list.titleDue.label'),
            allowAssign: false,
            showSeeAll: false,
            readOnly: loaded.fromCache,
            stale: loaded.fromCache && loaded.stale,
            fetchedAt: loaded.fetchedAt,
          ),
        const EditionHomeCards(),
        if (!done)
          NavRow(
            label: context.t('mob.home.link.unreported'),
            icon: Icons.assignment_late_outlined,
            onTap: () => openScreen(context, 'MOB-57'),
          ),
      ],
    );
  }
}
