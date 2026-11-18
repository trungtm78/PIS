import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/di/providers.dart' show apiClientProvider;
import '../../core/l10n/app_strings.dart';
import '../../core/theme/colors.dart';
import '../../core/widgets/nav_row.dart';
import '../../core/widgets/section_panel.dart';
import '../../core/widgets/stat_strip.dart';
import '../read_support/navigate.dart';
import 'pwf_models.dart';
import 'pwf_todo_read.dart';

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

/// The figures of the block of the home from the first page of `/me/project-tasks` (L7b). When the tasks of the answer can be read, they and every page
/// after them are counted by [readPwfTodo], the reader the head of "Việc của tôi" uses, so a tap on the block opens a list whose head says the same
/// three numbers. The `counts_by_band` of the server is NOT that triple: it counts the tasks that wait for another person's approval too, and always by
/// the official colour. It is only what is left for an answer whose tasks cannot be read (an older server), so the block is not lost with it.
Future<({PwfHomeCounts counts, bool more})?> readPwfHomeTodo(PwfTaskPageRead readPage) async {
  final Object? raw = await readPage(null);
  final PwfMyTasks? first = parsePwfMyTasks(raw);
  if (first == null) {
    final PwfHomeCounts? said = parsePwfHomeCounts(raw);
    return said == null ? null : (counts: said, more: false);
  }
  final PwfTodoCount count = await readPwfTodo(first, readPage);
  return (counts: count.personal, more: count.more);
}

/// The block "my tasks by deadline" of the home screen: how many of the person's workflow tasks are still theirs to do, red, yellow and green as
/// "Việc của tôi" counts them ([readPwfHomeTodo]: every page, not the first one only), and the way to the list (MOB-80). A count that did not reach
/// the end of a very long list is written with a "+". It reads for itself and never takes the home screen down with it: while it reads, when the read fails, when the server
/// gives no counts or when the person has no such task, it draws nothing (the alert card of the home already names what is overdue).
class PwfHomeDeadlines extends ConsumerStatefulWidget {
  const PwfHomeDeadlines({super.key});

  @override
  ConsumerState<PwfHomeDeadlines> createState() => _PwfHomeDeadlinesState();
}

class _PwfHomeDeadlinesState extends ConsumerState<PwfHomeDeadlines> {
  PwfHomeCounts? _counts;
  bool _more = false;

  @override
  void initState() {
    super.initState();
    _read();
  }

  Future<void> _read() async {
    try {
      final ({PwfHomeCounts counts, bool more})? read = await readPwfHomeTodo(pwfTaskPages(ref.read(apiClientProvider)));
      if (!mounted) return;
      setState(() {
        _counts = read?.counts;
        _more = read?.more ?? false;
      });
    } on Object {
      // The home screen stands without this block.
    }
  }

  @override
  Widget build(BuildContext context) {
    final PwfHomeCounts? counts = _counts;
    // Nothing to do, and the whole list was counted: no block. A count that stopped short is shown even at nought ("0+"), since more may wait.
    if (counts == null || (counts.red + counts.yellow + counts.green == 0 && !_more)) return const SizedBox.shrink();
    return SectionPanel(
      title: context.t('mob.pwf6.home.title'),
      padded: false,
      children: <Widget>[
        StatStrip(
          cells: <StatCell>[
            StatCell(value: pwfTodoFigure(counts.red, more: _more), label: context.t('mob.pwf6.home.red'), band: DeadlineBand.late, bandInline: true),
            StatCell(value: pwfTodoFigure(counts.yellow, more: _more), label: context.t('mob.pwf6.home.yellow'), band: DeadlineBand.soon, bandInline: true),
            StatCell(value: pwfTodoFigure(counts.green, more: _more), label: context.t('mob.pwf6.home.green'), band: DeadlineBand.ok, bandInline: true),
          ],
        ),
        NavRow(label: context.t('mob.pwf.entry.tasks'), icon: Icons.event_available_outlined, dividerAbove: true, onTap: () => openScreen(context, 'MOB-80')),
      ],
    );
  }
}
