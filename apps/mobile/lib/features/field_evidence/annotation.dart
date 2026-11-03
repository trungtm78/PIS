import 'dart:math' as math;

import 'package:image/image.dart' as img;

/// The colours a person can mark a photograph with. The names are what is stored; the values are what is drawn.
enum AnnotationColor {
  red(0xFF, 0x1F, 0x1F),
  yellow(0xFF, 0xD2, 0x00),
  blue(0x1E, 0x6B, 0xFF),
  white(0xFF, 0xFF, 0xFF);

  const AnnotationColor(this.r, this.g, this.b);

  final int r;
  final int g;
  final int b;

  static AnnotationColor parse(Object? name) {
    for (final AnnotationColor color in AnnotationColor.values) {
      if (color.name == name) return color;
    }
    return AnnotationColor.red;
  }
}

/// The pen widths a person can choose, as a fraction of the longer side of the picture, so a mark looks the same on a small
/// preview and on the picture that is uploaded.
const List<double> kPenWidths = <double>[0.004, 0.008, 0.014];

/// One point of a mark, in the picture's own coordinates from 0 to 1 (left to right, top to bottom).
final class AnnotationPoint {
  const AnnotationPoint(this.x, this.y);

  final double x;
  final double y;

  AnnotationPoint clamped() =>
      AnnotationPoint(x.clamp(0.0, 1.0), y.clamp(0.0, 1.0));

  @override
  bool operator ==(Object other) =>
      other is AnnotationPoint && other.x == x && other.y == y;

  @override
  int get hashCode => Object.hash(x, y);
}

/// One stroke of the pen.
final class Stroke {
  const Stroke({
    required this.color,
    required this.width,
    required this.points,
  });

  final AnnotationColor color;

  /// A fraction of the longer side of the picture.
  final double width;
  final List<AnnotationPoint> points;

  Map<String, Object?> toJson() => <String, Object?>{
    'color': color.name,
    'width': width,
    'points': <Object?>[
      for (final AnnotationPoint point in points) <Object?>[point.x, point.y],
    ],
  };

  /// A stroke from its stored form, or null when it is not one (the draft is read back after an update of the application: a
  /// mark that cannot be read is left out, the picture is not lost).
  static Stroke? fromJson(Object? json) {
    if (json is! Map) return null;
    final Object? width = json['width'];
    final Object? raw = json['points'];
    if (width is! num || raw is! List) return null;
    final List<AnnotationPoint> points = <AnnotationPoint>[];
    for (final Object? pair in raw) {
      if (pair is! List ||
          pair.length != 2 ||
          pair[0] is! num ||
          pair[1] is! num)
        return null;
      points.add(
        AnnotationPoint(
          (pair[0] as num).toDouble(),
          (pair[1] as num).toDouble(),
        ).clamped(),
      );
    }
    if (points.isEmpty) return null;
    return Stroke(
      color: AnnotationColor.parse(json['color']),
      width: width.toDouble().clamp(0.001, 0.05),
      points: points,
    );
  }
}

/// The marks a person drew on one photograph, and the words under it. Immutable: every change returns the next state, so the
/// canvas can undo and redo without copying the picture. The picture is never changed by the marks until it is flattened for the
/// upload; the original file stays as it was taken.
final class AnnotationSet {
  const AnnotationSet({
    this.strokes = const <Stroke>[],
    this.redo = const <Stroke>[],
    this.caption = '',
  });

  static const AnnotationSet empty = AnnotationSet();

  /// The most the caption may say (the limit of the note of a photograph on the server).
  static const int captionMax = 500;

  final List<Stroke> strokes;

  /// The strokes taken back and not drawn again yet.
  final List<Stroke> redo;
  final String caption;

  bool get isEmpty => strokes.isEmpty;
  bool get canUndo => strokes.isNotEmpty;
  bool get canRedo => redo.isNotEmpty;

  AnnotationSet add(Stroke stroke) =>
      AnnotationSet(strokes: <Stroke>[...strokes, stroke], caption: caption);

  AnnotationSet undo() => strokes.isEmpty
      ? this
      : AnnotationSet(
          strokes: strokes.sublist(0, strokes.length - 1),
          redo: <Stroke>[...redo, strokes.last],
          caption: caption,
        );

  AnnotationSet redoStroke() => redo.isEmpty
      ? this
      : AnnotationSet(
          strokes: <Stroke>[...strokes, redo.last],
          redo: redo.sublist(0, redo.length - 1),
          caption: caption,
        );

  AnnotationSet clear() => AnnotationSet(caption: caption);

  AnnotationSet withCaption(String value) => AnnotationSet(
    strokes: strokes,
    redo: redo,
    caption: value.length > captionMax ? value.substring(0, captionMax) : value,
  );

  Map<String, Object?> toJson() => <String, Object?>{
    'caption': caption,
    'strokes': <Object?>[for (final Stroke stroke in strokes) stroke.toJson()],
  };

  static AnnotationSet fromJson(Object? json) {
    if (json is! Map) return empty;
    final Object? raw = json['strokes'];
    final Object? caption = json['caption'];
    return AnnotationSet(
      strokes: <Stroke>[
        if (raw is List)
          for (final Object? item in raw)
            if (Stroke.fromJson(item) case final Stroke stroke) stroke,
      ],
      caption: caption is String
          ? (caption.length > captionMax
                ? caption.substring(0, captionMax)
                : caption)
          : '',
    );
  }
}

/// Draws the marks into the picture. The marks are in the picture's own coordinates, so they land where the person saw them
/// once the orientation of the photograph has been applied.
void drawAnnotations(img.Image canvas, AnnotationSet marks) {
  final int longer = math.max(canvas.width, canvas.height);
  for (final Stroke stroke in marks.strokes) {
    final img.ColorRgb8 colour = img.ColorRgb8(
      stroke.color.r,
      stroke.color.g,
      stroke.color.b,
    );
    final num thickness = math.max(1.0, stroke.width * longer);
    final List<AnnotationPoint> points = stroke.points;
    for (int i = 0; i < points.length; i += 1) {
      final AnnotationPoint from = points[i];
      final AnnotationPoint to = i + 1 < points.length ? points[i + 1] : from;
      img.drawLine(
        canvas,
        x1: (from.x * (canvas.width - 1)).round(),
        y1: (from.y * (canvas.height - 1)).round(),
        x2: (to.x * (canvas.width - 1)).round(),
        y2: (to.y * (canvas.height - 1)).round(),
        color: colour,
        thickness: thickness,
      );
    }
  }
}
