import 'package:flutter/material.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../theme/colors.dart';
import '../theme/typography.dart';
import 'deadline.dart';

/// One event of a [TimelineList]: when it happened, what it was and, when it is a state of a deadline, its band.
class TimelineEntry {
  const TimelineEntry({required this.title, required this.when, this.detail, this.band, this.icon});

  final String title;

  /// "10:42" or "Yesterday 16:00", already worded.
  final String when;
  final String? detail;

  /// Colours the dot and gives it the shape of the band (octagon, triangle, clock, tick).
  final DeadlineBand? band;

  /// A dot icon when there is no band; null draws a plain dot.
  final IconData? icon;
}

/// A vertical timeline of events (the history of a task, the notifications of a day): a dot per entry on a thin rail, the title and the
/// time beside it. The dot is a shape, not only a colour: an entry with a band shows its glyph. Entries are read in order, each as one
/// "title, time, detail" node.
class TimelineList extends StatelessWidget {
  const TimelineList({required this.entries, super.key});

  final List<TimelineEntry> entries;

  @override
  Widget build(BuildContext context) {
    final MachvonV2 v2 = context.v2;
    final MachvonV2Text text = context.v2text;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        for (int index = 0; index < entries.length; index += 1)
          Semantics(
            container: true,
            label: <String>[entries[index].title, entries[index].when, if (entries[index].detail != null) entries[index].detail!].join(', '),
            excludeSemantics: true,
            child: IntrinsicHeight(
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: <Widget>[
                  SizedBox(
                    width: MachvonV2Size.glyph,
                    child: Column(
                      children: <Widget>[
                        Expanded(child: SizedBox(width: 2, child: ColoredBox(color: index == 0 ? Colors.transparent : v2.palette.line))),
                        _Dot(entry: entries[index]),
                        Expanded(child: SizedBox(width: 2, child: ColoredBox(color: index == entries.length - 1 ? Colors.transparent : v2.palette.line))),
                      ],
                    ),
                  ),
                  const SizedBox(width: MachvonV2Space.s8),
                  Expanded(
                    child: Padding(
                      padding: const EdgeInsets.symmetric(vertical: MachvonV2Space.s8),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: <Widget>[
                          Text(entries[index].title, style: text.bodyStrong),
                          Text(entries[index].when, style: text.caption),
                          if (entries[index].detail != null) Padding(padding: const EdgeInsets.only(top: MachvonV2Space.s4), child: Text(entries[index].detail!, style: text.body)),
                        ],
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
      ],
    );
  }
}

class _Dot extends StatelessWidget {
  const _Dot({required this.entry});

  final TimelineEntry entry;

  @override
  Widget build(BuildContext context) {
    final MachvonV2 v2 = context.v2;
    if (entry.band != null) return DeadlineGlyph(band: entry.band!, size: 28);
    if (entry.icon != null) {
      return SizedBox(
        width: 28,
        height: 28,
        child: DecoratedBox(
          decoration: BoxDecoration(color: v2.palette.primarySoft, borderRadius: BorderRadius.circular(MachvonV2Radius.glyph)),
          child: Icon(entry.icon, size: 16, color: v2.palette.primaryStrong),
        ),
      );
    }
    return SizedBox(
      width: 12,
      height: 12,
      child: DecoratedBox(decoration: BoxDecoration(color: v2.palette.outline, shape: BoxShape.circle)),
    );
  }
}
