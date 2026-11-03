import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../core/l10n/app_strings.dart';
import 'annotation.dart';

/// The photograph with the marks of the person on it. The person draws with a finger; every stroke is kept in the picture's own
/// coordinates (0 to 1), so what is drawn here lands in the same place on the picture that is uploaded. Marking is optional: a
/// photograph is used as it is without a single stroke, so no gesture is the only way to do anything that matters.
///
/// The widget holds no state of the marks: it shows [marks] and reports the next state through [onChanged].
class AnnotationCanvas extends StatefulWidget {
  const AnnotationCanvas({
    required this.image,
    required this.marks,
    required this.onChanged,
    super.key,
  });

  /// The photograph (JPEG or PNG), as it was taken.
  final Uint8List image;
  final AnnotationSet marks;
  final ValueChanged<AnnotationSet> onChanged;

  @override
  State<AnnotationCanvas> createState() => _AnnotationCanvasState();
}

class _AnnotationCanvasState extends State<AnnotationCanvas> {
  ui.Image? _picture;
  AnnotationColor _color = AnnotationColor.red;
  double _width = kPenWidths[1];
  List<AnnotationPoint> _live = const <AnnotationPoint>[];

  @override
  void initState() {
    super.initState();
    _decode();
  }

  @override
  void didUpdateWidget(AnnotationCanvas oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.image, widget.image)) _decode();
  }

  @override
  void dispose() {
    _picture?.dispose();
    super.dispose();
  }

  Future<void> _decode() async {
    final Uint8List bytes = widget.image;
    final ui.Codec codec = await ui.instantiateImageCodec(bytes);
    final ui.FrameInfo frame = await codec.getNextFrame();
    codec.dispose();
    if (!mounted || !identical(bytes, widget.image)) {
      frame.image.dispose();
      return;
    }
    setState(() {
      _picture?.dispose();
      _picture = frame.image;
    });
  }

  AnnotationPoint _at(Offset local, Size size) =>
      AnnotationPoint(local.dx / size.width, local.dy / size.height).clamped();

  void _start(Offset local, Size size) =>
      setState(() => _live = <AnnotationPoint>[_at(local, size)]);

  void _extend(Offset local, Size size) =>
      setState(() => _live = <AnnotationPoint>[..._live, _at(local, size)]);

  void _end() {
    if (_live.isEmpty) return;
    final Stroke stroke = Stroke(color: _color, width: _width, points: _live);
    setState(() => _live = const <AnnotationPoint>[]);
    widget.onChanged(widget.marks.add(stroke));
  }

  @override
  Widget build(BuildContext context) {
    final ui.Image? picture = _picture;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        if (picture == null)
          const SizedBox(
            height: 200,
            child: Center(child: CircularProgressIndicator()),
          )
        else
          Semantics(
            label: context.t('mob.evd.canvas.aria', <String, Object>{
              'count': widget.marks.strokes.length,
            }),
            image: true,
            child: AspectRatio(
              aspectRatio: picture.width / picture.height,
              child: LayoutBuilder(
                builder: (BuildContext context, BoxConstraints box) {
                  final Size size = Size(box.maxWidth, box.maxHeight);
                  return GestureDetector(
                    onPanStart: (DragStartDetails d) =>
                        _start(d.localPosition, size),
                    onPanUpdate: (DragUpdateDetails d) =>
                        _extend(d.localPosition, size),
                    onPanEnd: (DragEndDetails _) => _end(),
                    onPanCancel: _end,
                    child: CustomPaint(
                      foregroundPainter: _MarksPainter(
                        widget.marks.strokes,
                        _live,
                        _color,
                        _width,
                      ),
                      child: RawImage(image: picture, fit: BoxFit.fill),
                    ),
                  );
                },
              ),
            ),
          ),
        const SizedBox(height: MachvonSpace.space8),
        Wrap(
          spacing: MachvonSpace.space8,
          runSpacing: MachvonSpace.space4,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: <Widget>[
            for (final AnnotationColor color in AnnotationColor.values)
              ChoiceChip(
                label: Text(_colorLabel(context, color)),
                selected: _color == color,
                onSelected: (bool _) => setState(() => _color = color),
              ),
          ],
        ),
        Wrap(
          spacing: MachvonSpace.space8,
          runSpacing: MachvonSpace.space4,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: <Widget>[
            for (final double width in kPenWidths)
              ChoiceChip(
                label: Text(_penLabel(context, width)),
                selected: _width == width,
                onSelected: (bool _) => setState(() => _width = width),
              ),
            IconButton(
              onPressed: widget.marks.canUndo
                  ? () => widget.onChanged(widget.marks.undo())
                  : null,
              tooltip: context.t('mob.evd.undo.action'),
              icon: const Icon(Icons.undo),
            ),
            IconButton(
              onPressed: widget.marks.canRedo
                  ? () => widget.onChanged(widget.marks.redoStroke())
                  : null,
              tooltip: context.t('mob.evd.redo.action'),
              icon: const Icon(Icons.redo),
            ),
            IconButton(
              onPressed: widget.marks.isEmpty
                  ? null
                  : () => widget.onChanged(widget.marks.clear()),
              tooltip: context.t('mob.evd.clear.action'),
              icon: const Icon(Icons.delete_outline),
            ),
          ],
        ),
      ],
    );
  }
}

String _penLabel(BuildContext context, double width) {
  if (width == kPenWidths.first) return context.t('mob.evd.pen.thin');
  if (width == kPenWidths.last) return context.t('mob.evd.pen.thick');
  return context.t('mob.evd.pen.medium');
}

String _colorLabel(BuildContext context, AnnotationColor color) {
  switch (color) {
    case AnnotationColor.red:
      return context.t('mob.evd.color.red');
    case AnnotationColor.yellow:
      return context.t('mob.evd.color.yellow');
    case AnnotationColor.blue:
      return context.t('mob.evd.color.blue');
    case AnnotationColor.white:
      return context.t('mob.evd.color.white');
  }
}

class _MarksPainter extends CustomPainter {
  _MarksPainter(this.strokes, this.live, this.color, this.width);

  final List<Stroke> strokes;
  final List<AnnotationPoint> live;
  final AnnotationColor color;
  final double width;

  Paint _pen(AnnotationColor c, double w, Size size) => Paint()
    ..color = Color.fromARGB(255, c.r, c.g, c.b)
    ..strokeWidth = (w * size.longestSide).clamp(1.0, 64.0)
    ..strokeCap = StrokeCap.round
    ..strokeJoin = StrokeJoin.round
    ..style = PaintingStyle.stroke;

  void _line(
    Canvas canvas,
    Size size,
    List<AnnotationPoint> points,
    Paint pen,
  ) {
    if (points.length == 1) {
      canvas.drawCircle(
        Offset(points.first.x * size.width, points.first.y * size.height),
        pen.strokeWidth / 2,
        pen..style = PaintingStyle.fill,
      );
      return;
    }
    final Path path = Path()
      ..moveTo(points.first.x * size.width, points.first.y * size.height);
    for (final AnnotationPoint point in points.skip(1)) {
      path.lineTo(point.x * size.width, point.y * size.height);
    }
    canvas.drawPath(path, pen);
  }

  @override
  void paint(Canvas canvas, Size size) {
    for (final Stroke stroke in strokes) {
      _line(
        canvas,
        size,
        stroke.points,
        _pen(stroke.color, stroke.width, size),
      );
    }
    if (live.isNotEmpty) _line(canvas, size, live, _pen(color, width, size));
  }

  @override
  bool shouldRepaint(_MarksPainter old) =>
      old.strokes != strokes ||
      old.live != live ||
      old.color != color ||
      old.width != width;
}
