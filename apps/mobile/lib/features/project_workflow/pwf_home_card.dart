import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';

import '../../core/di/providers.dart' show apiClientProvider;
import '../../core/l10n/app_strings.dart';
import '../../core/widgets/nav_row.dart';
import '../../core/widgets/section_panel.dart';
import '../../core/widgets/stat_strip.dart';
import '../read_support/navigate.dart';

/// The counts of the person's own workflow tasks by official colour, as `/me/project-tasks` answers them (`counts_by_band`).
typedef PwfHomeCounts = ({int red, int yellow, int green});

/// Reads the counts out of the answer; null when the server gives none (an older server) or the answer is not a record.
PwfHomeCounts? parsePwfHomeCounts(Object? raw) {
  if (raw is! Map<String, Object?>) return null;
  final Object? counts = raw['counts_by_band'];
  if (counts is! Map<String, Object?>) return null;
  int of(String band) => counts[band] is int ? counts[band]! as int : 0;
  return (red: of('RED'), yellow: of('YELLOW'), green: of('GREEN'));
}

/// The block "my tasks by deadline" of the home screen: how many of the person's workflow tasks are red, yellow and green by the official colours, and
/// the way to the list (MOB-80). It reads for itself and never takes the home screen down with it: while it reads, when the read fails, when the server
/// gives no counts or when the person has no such task, it draws nothing (the alert card of the home already names what is overdue).
class PwfHomeDeadlines extends ConsumerStatefulWidget {
  const PwfHomeDeadlines({super.key});

  @override
  ConsumerState<PwfHomeDeadlines> createState() => _PwfHomeDeadlinesState();
}

class _PwfHomeDeadlinesState extends ConsumerState<PwfHomeDeadlines> {
  PwfHomeCounts? _counts;

  @override
  void initState() {
    super.initState();
    _read();
  }

  Future<void> _read() async {
    try {
      final PwfHomeCounts? counts = parsePwfHomeCounts(await ref.read(apiClientProvider).getMyTasks(query: const <String, Object?>{'limit': 1}));
      if (mounted) setState(() => _counts = counts);
    } on Object {
      // The home screen stands without this block.
    }
  }

  @override
  Widget build(BuildContext context) {
    final PwfHomeCounts? counts = _counts;
    if (counts == null || counts.red + counts.yellow + counts.green == 0) return const SizedBox.shrink();
    return SectionPanel(
      title: context.t('mob.pwf6.home.title'),
      padded: false,
      children: <Widget>[
        StatStrip(
          cells: <StatCell>[
            StatCell(value: '${counts.red}', label: context.t('mob.pwf6.home.red')),
            StatCell(value: '${counts.yellow}', label: context.t('mob.pwf6.home.yellow')),
            StatCell(value: '${counts.green}', label: context.t('mob.pwf6.home.green')),
          ],
        ),
        NavRow(label: context.t('mob.pwf.entry.tasks'), icon: Icons.event_available_outlined, dividerAbove: true, onTap: () => openScreen(context, 'MOB-80')),
      ],
    );
  }
}
