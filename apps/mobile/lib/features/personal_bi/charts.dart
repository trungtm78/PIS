import 'package:flutter/material.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import 'query_models.dart';

/// The numbers a chart is drawn from. A group with no figure is left out and never drawn as zero; the list under the chart says so.
/// The doubles only place a mark: what a person reads is the exact text of the figure.
List<double> chartValues(List<Group> groups) => <double>[
      for (final Group group in groups)
        if (double.tryParse(group.figure.value ?? '') case final double value when value.isFinite) value,
    ];

/// How much of the widest bar a value fills, 0 to 1, by its size without its sign.
double fractionOf(double value, double widest) => widest <= 0 ? 0 : (value.abs() / widest).clamp(0.0, 1.0);

double widestOf(List<double> values) => values.fold<double>(0, (double widest, double value) => value.abs() > widest ? value.abs() : widest);

/// A bar as long as the share of the widest value it holds. It is a mark and carries no meaning of its own: the figure is the text
/// beside it, so a screen reader skips the bar.
class ProportionBar extends StatelessWidget {
  const ProportionBar({required this.fraction, required this.negative, super.key});

  final double fraction;
  final bool negative;

  @override
  Widget build(BuildContext context) {
    return ExcludeSemantics(
      child: ClipRRect(
        borderRadius: const BorderRadius.all(Radius.circular(MachvonRadius.control)),
        child: Container(
          height: 8,
          color: MachvonColors.border,
          alignment: AlignmentDirectional.centerStart,
          child: FractionallySizedBox(widthFactor: fraction, child: ColoredBox(color: negative ? MachvonColors.danger : MachvonColors.primary, child: const SizedBox(height: 8))),
        ),
      ),
    );
  }
}

/// A line (or an area under it) through the groups that have a figure, in the order they came. Decorative: the groups are listed under
/// it with their exact figures.
class LineSketch extends StatelessWidget {
  const LineSketch({required this.values, required this.area, super.key});

  final List<double> values;
  final bool area;

  @override
  Widget build(BuildContext context) {
    if (values.length < 2) return const SizedBox.shrink();
    return ExcludeSemantics(child: SizedBox(height: 96, child: CustomPaint(size: const Size(double.infinity, 96), painter: _LinePainter(values, area))));
  }
}

class _LinePainter extends CustomPainter {
  const _LinePainter(this.values, this.area);

  final List<double> values;
  final bool area;

  @override
  void paint(Canvas canvas, Size size) {
    final double low = values.fold<double>(0, (double a, double b) => b < a ? b : a);
    final double high = values.fold<double>(0, (double a, double b) => b > a ? b : a);
    final double span = high - low == 0 ? 1 : high - low;
    const double pad = 4;
    final double step = (size.width - pad * 2) / (values.length - 1);
    Offset point(int index) => Offset(pad + index * step, pad + (high - values[index]) / span * (size.height - pad * 2));
    final Path line = Path()..moveTo(point(0).dx, point(0).dy);
    for (int index = 1; index < values.length; index += 1) {
      line.lineTo(point(index).dx, point(index).dy);
    }
    if (area) {
      final double base = pad + high / span * (size.height - pad * 2);
      final Path fill = Path.from(line)
        ..lineTo(point(values.length - 1).dx, base)
        ..lineTo(point(0).dx, base)
        ..close();
      canvas.drawPath(fill, Paint()..color = MachvonColors.primary.withValues(alpha: 0.2));
    }
    canvas.drawPath(line, Paint()
      ..color = MachvonColors.primary
      ..style = PaintingStyle.stroke
      ..strokeWidth = 2);
  }

  @override
  bool shouldRepaint(_LinePainter oldDelegate) => oldDelegate.values != values || oldDelegate.area != area;
}
