import 'package:flutter/material.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import 'colors.dart';

/// Tabular figures: the digits of a number have one width, so columns of amounts line up and a changing value does not jitter.
const List<FontFeature> kTabularFigures = <FontFeature>[FontFeature.tabularFigures()];

/// The text styles of the phone design: six steps and two emphasised variants of the `mobile.v2` type scale, in the ink colour of the
/// current mode. A widget takes its text from here (`context.v2text.title`); it never writes a `TextStyle` or a font size itself.
@immutable
class MachvonV2Text {
  const MachvonV2Text._(this.display, this.title, this.heading, this.body, this.bodyStrong, this.label, this.caption, this.captionStrong);

  /// The large title of a root screen and the figure of the command band: 32/40, 600.
  final TextStyle display;

  /// The title of a child screen, the figure of a metric, the title of a sheet: 22/30, 600.
  final TextStyle title;

  /// The title of a group inside a card or a form: 16/24, 600.
  final TextStyle heading;

  /// Content: 15/22, 400.
  final TextStyle body;

  /// The title of a row: 15/22, 600.
  final TextStyle bodyStrong;

  /// A deadline label, a chip, a secondary button, a group name: 13/20, 600.
  final TextStyle label;

  /// Context and notes: 12/18, 400. Nothing is smaller than 12.
  final TextStyle caption;

  /// The label of a tab: 12/16, 600.
  final TextStyle captionStrong;

  static TextStyle _style(MachvonV2TypeStep step, Color color, {bool figures = false}) => TextStyle(
        fontFamily: MachvonFont.family,
        fontFamilyFallback: MachvonFont.fallbackFamilies,
        fontSize: step.size,
        height: step.height,
        fontWeight: step.weight,
        color: color,
        fontFeatures: figures ? kTabularFigures : null,
        leadingDistribution: TextLeadingDistribution.even,
      );

  /// The styles in the colours of [theme]. The numbers (display and title) have tabular figures.
  factory MachvonV2Text.of(MachvonV2 theme) {
    final Color ink = theme.palette.ink;
    return MachvonV2Text._(
      _style(MachvonV2Type.display, ink, figures: true),
      _style(MachvonV2Type.title, ink, figures: true),
      _style(MachvonV2Type.heading, ink),
      _style(MachvonV2Type.body, ink),
      _style(MachvonV2Type.bodyStrong, ink),
      _style(MachvonV2Type.label, ink),
      _style(MachvonV2Type.caption, theme.palette.ink2),
      _style(MachvonV2Type.captionStrong, ink),
    );
  }
}

/// `context.v2text` for every widget.
extension MachvonV2TextContext on BuildContext {
  MachvonV2Text get v2text => MachvonV2Text.of(v2);
}

/// The text scale of the system, held at [cap] times for the large titles and the labels of the navigation bar (they would not fit
/// five to a row); the other steps follow the system up to 2.0 times, and line clamps are lifted from `MachvonV2Type.clampFreeFrom`.
TextScaler cappedScaler(BuildContext context, double cap) => MediaQuery.textScalerOf(context).clamp(maxScaleFactor: cap);

/// Whether the text scale of the system is large enough to lift line clamps and let a row wrap its trailing column below the title.
bool largeText(BuildContext context) => MediaQuery.textScalerOf(context).scale(1) >= MachvonV2Type.clampFreeFrom;

/// The Material text theme the screens that are not yet on the new widgets still read (Theme.of(context).textTheme): the scale of
/// before the redesign (12 secondary and labels, 14 compact, 16 body, 20 titles, 28 page title, 32 the number of a command block), in
/// the ink colours of [theme] so the dark mode stays readable. A screen moves to context.v2text when its wave of MUX-3 comes; this
/// function goes with the last screen.
TextTheme legacyTextTheme(TextTheme base, MachvonV2 theme) {
  final Color ink = theme.palette.ink;
  final Color secondary = theme.palette.ink2;
  TextStyle? sized(TextStyle? style, double size, FontWeight weight, {double? height, bool figures = false, double? letterSpacing}) {
    return style?.copyWith(
      fontSize: size,
      fontWeight: weight,
      height: height,
      letterSpacing: letterSpacing,
      color: ink,
      fontFeatures: figures ? kTabularFigures : null,
    );
  }

  return base.copyWith(
    displaySmall: sized(base.displaySmall, 32, FontWeight.w700, height: 1.15, figures: true),
    headlineMedium: sized(base.headlineMedium, MachvonFont.title, FontWeight.w700, height: 1.2, figures: true),
    headlineSmall: sized(base.headlineSmall, 20, FontWeight.w600, height: 1.25),
    titleLarge: sized(base.titleLarge, MachvonFont.title, FontWeight.w600, height: 1.2),
    titleMedium: sized(base.titleMedium, MachvonFont.mobileBody, FontWeight.w600, height: 1.3),
    titleSmall: sized(base.titleSmall, 14, FontWeight.w600, height: 1.3),
    bodyLarge: sized(base.bodyLarge, MachvonFont.mobileBody, FontWeight.w400, height: 1.4),
    bodyMedium: sized(base.bodyMedium, MachvonFont.mobileBody, FontWeight.w400, height: 1.4),
    bodySmall: base.bodySmall?.copyWith(fontSize: MachvonFont.navSecondary, height: 1.35, color: secondary),
    labelLarge: sized(base.labelLarge, MachvonFont.mobileBody, FontWeight.w600, height: 1.25),
    labelMedium: sized(base.labelMedium, 12, FontWeight.w600, height: 1.25, letterSpacing: 0.2),
    labelSmall: sized(base.labelSmall, 12, FontWeight.w500, height: 1.25),
  );
}
