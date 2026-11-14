import 'package:flutter/material.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../theme/colors.dart';
import '../theme/typography.dart';
import 'deadline.dart';
import 'figure_info.dart';

/// One cell of a [StatStrip]: a figure (Title, 22/30), what it counts (Caption) and, when it needs attention, a band label under it
/// (the shape and the words, never the colour alone).
class StatCell {
  const StatCell({required this.value, required this.label, this.of, this.band, this.bandText, this.info, this.bandInline = false});

  /// The figure: "6".
  final String value;

  /// The small "of" after the figure: "/32".
  final String? of;

  /// What is counted: "Projects behind on disbursement".
  final String label;

  /// The band of attention under the cell, or null for a plain figure.
  final DeadlineBand? band;

  /// The words of the band label: "Watch", "Overdue". Required with [band].
  final String? bandText;

  /// The definition the figure is made by: when there is one, the cell carries the "i" that opens it (a button of its own, in the corner).
  final FigureInfo? info;

  /// Draws the shape of the [band] beside the figure and no band label under the cell: for a strip whose three cells ARE the three bands, where the
  /// label already says the words of the band and a label under it would say them twice (and break in a third of the width).
  final bool bandInline;
}

/// Three figures in one row with thin vertical rules (design B "StatStrip"): the metric tiles of a home screen without the boxes, so they
/// take one band of the screen, not three cards. The cells share the row equally; at a large text scale they stack so no figure is cut.
class StatStrip extends StatelessWidget {
  const StatStrip({required this.cells, super.key});

  final List<StatCell> cells;

  @override
  Widget build(BuildContext context) {
    final MachvonV2 v2 = context.v2;
    final bool large = largeText(context);
    final List<Widget> children = <Widget>[
      for (int index = 0; index < cells.length; index += 1)
        if (large)
          _Cell(cell: cells[index], ruleAbove: index > 0)
        else
          Expanded(child: _Cell(cell: cells[index], ruleBefore: index > 0)),
    ];
    return DecoratedBox(
      decoration: BoxDecoration(border: Border(bottom: BorderSide(color: v2.palette.line))),
      child: large ? Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: children) : IntrinsicHeight(child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: children)),
    );
  }
}

class _Cell extends StatelessWidget {
  const _Cell({required this.cell, this.ruleBefore = false, this.ruleAbove = false});

  final StatCell cell;
  final bool ruleBefore;
  final bool ruleAbove;

  @override
  Widget build(BuildContext context) {
    final MachvonV2 v2 = context.v2;
    final MachvonV2Text text = context.v2text;
    final BorderSide rule = BorderSide(color: v2.palette.line);
    final String band = cell.band == null ? '' : deadlineBandName(context, cell.band!);
    final Widget content = Semantics(
      container: true,
      label: '${cell.value}${cell.of ?? ''} ${cell.label}${cell.band == null || cell.bandInline ? '' : ', ${cell.bandText ?? band}'}',
      excludeSemantics: true,
      child: DecoratedBox(
        decoration: BoxDecoration(border: Border(left: ruleBefore ? rule : BorderSide.none, top: ruleAbove ? rule : BorderSide.none)),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(MachvonV2Space.s16, MachvonV2Space.s12, MachvonV2Space.s8, MachvonV2Space.s12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              // The "i" is drawn over the corner of the cell: the figure keeps clear of it.
              Padding(
                padding: EdgeInsets.only(right: cell.info == null ? 0 : 36),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: <Widget>[
                    if (cell.band != null && cell.bandInline) ...<Widget>[
                      Icon(cell.band!.styleIn(v2).icon, size: 20, color: cell.band!.styleIn(v2).foreground),
                      const SizedBox(width: MachvonV2Space.s8),
                    ],
                    Flexible(
                      child: Text.rich(
                        TextSpan(
                          text: cell.value,
                          children: <InlineSpan>[if (cell.of != null) TextSpan(text: cell.of, style: text.caption)],
                        ),
                        style: text.title,
                        textScaler: cappedScaler(context, MachvonV2Type.titleScaleCap),
                      ),
                    ),
                  ],
                ),
              ),
              Text(cell.label, style: text.caption),
              if (cell.band != null && !cell.bandInline)
                Padding(padding: const EdgeInsets.only(top: MachvonV2Space.s4), child: DeadlineLabel(band: cell.band!, text: cell.bandText ?? band)),
            ],
          ),
        ),
      ),
    );
    if (cell.info == null) return content;
    // The "i" is a button of its own, outside the one sentence the cell is to a screen reader.
    return Stack(children: <Widget>[content, Positioned(top: 0, right: 0, child: FigureInfoButton(info: cell.info!))]);
  }
}
