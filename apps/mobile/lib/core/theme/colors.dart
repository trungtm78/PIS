import 'package:flutter/material.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

/// The colours of the phone design (`mobile.v2`, light or dark) as a theme extension: a widget reads them from the theme
/// (`context.v2`) and never names a token or a hex value, so a tenant overlay and the dark mode reach every widget at once.
///
/// The three deadline bands (late, soon, ok) are never changed by a tenant overlay; the overlay recolours the command band
/// (`header`), the primary colour and the selected fill only (design-system-v2 section 12).
@immutable
class MachvonV2 extends ThemeExtension<MachvonV2> {
  const MachvonV2({required this.palette, required this.brightness});

  /// The palette of the light mode.
  static const MachvonV2 light = MachvonV2(palette: MachvonV2Colors.light, brightness: Brightness.light);

  /// The palette of the dark mode.
  static const MachvonV2 dark = MachvonV2(palette: MachvonV2Colors.dark, brightness: Brightness.dark);

  final MachvonV2Palette palette;
  final Brightness brightness;

  bool get isDark => brightness == Brightness.dark;

  /// A hairline lift for a row group or a metric strip: light mode has a soft shadow, dark mode a border instead of a shadow.
  List<BoxShadow> get e1 => isDark ? MachvonV2Elevation.e1Dark : MachvonV2Elevation.e1Light;

  /// The upward shadow of the action bar, the sheet and the floating button.
  List<BoxShadow> get e2 => isDark ? MachvonV2Elevation.e2Dark : MachvonV2Elevation.e2Light;

  /// The tenant overlay over this palette: the command band, the primary colour and its soft fill. Only the three are overlaid, so the
  /// bands and the neutral ink keep their contrast.
  MachvonV2 withTenant({Color? header, Color? onHeader, Color? primary, Color? onPrimary}) {
    final MachvonV2Palette p = palette;
    final Color nextPrimary = primary ?? p.primary;
    final bool changed = primary != null && primary != p.primary;
    return MachvonV2(
      brightness: brightness,
      palette: MachvonV2Palette(
        bg: p.bg,
        surface: p.surface,
        sunken: p.sunken,
        ink: p.ink,
        ink2: p.ink2,
        ink3: p.ink3,
        line: p.line,
        lineStrong: p.lineStrong,
        outline: p.outline,
        header: header ?? p.header,
        header2: header == null ? p.header2 : Color.alphaBlend(Colors.white.withValues(alpha: 0.08), header),
        onHeader: onHeader ?? p.onHeader,
        onHeader2: p.onHeader2,
        primary: nextPrimary,
        primaryStrong: changed ? (isDark ? Color.lerp(nextPrimary, Colors.white, 0.3)! : Color.lerp(nextPrimary, Colors.black, 0.2)!) : p.primaryStrong,
        primarySoft: changed ? Color.alphaBlend(nextPrimary.withValues(alpha: isDark ? 0.2 : 0.12), p.surface) : p.primarySoft,
        onPrimary: onPrimary ?? p.onPrimary,
        accentOnDark: p.accentOnDark,
        focus: changed ? nextPrimary : p.focus,
        lateFg: p.lateFg,
        lateBg: p.lateBg,
        lateMark: p.lateMark,
        soonFg: p.soonFg,
        soonBg: p.soonBg,
        soonMark: p.soonMark,
        okFg: p.okFg,
        okBg: p.okBg,
        okMark: p.okMark,
        infoFg: p.infoFg,
        infoBg: p.infoBg,
        scrim: p.scrim,
      ),
    );
  }

  @override
  MachvonV2 copyWith({MachvonV2Palette? palette, Brightness? brightness}) =>
      MachvonV2(palette: palette ?? this.palette, brightness: brightness ?? this.brightness);

  /// Palettes are not blended: a mode switch changes at once.
  @override
  MachvonV2 lerp(ThemeExtension<MachvonV2>? other, double t) => other is MachvonV2 && t >= 0.5 ? other : this;
}

/// `context.v2` for every widget; follows the brightness of the theme when a test theme has no extension.
extension MachvonV2Context on BuildContext {
  MachvonV2 get v2 {
    final ThemeData theme = Theme.of(this);
    return theme.extension<MachvonV2>() ?? (theme.brightness == Brightness.dark ? MachvonV2.dark : MachvonV2.light);
  }
}

/// What a state is, as the shape and the words say it and the colour only backs up (design-system-v2 section 4).
enum DeadlineBand {
  /// Less than a day left or past: an octagon with an exclamation mark.
  late,

  /// One to three days left: a triangle with an exclamation mark.
  soon,

  /// More than three days left: a clock.
  ok,

  /// Finished: a tick in a circle, different from the clock.
  done;

  /// The band of a deadline from the days the server counted (negative when passed). The thresholds are the system default
  /// (late below 1 day, soon up to 3 days); a tenant policy passes its own. The phone never counts the days itself.
  static DeadlineBand fromDays(int daysRemaining, {int lateBelow = 1, int soonUpTo = 3}) {
    if (daysRemaining < lateBelow) return DeadlineBand.late;
    if (daysRemaining <= soonUpTo) return DeadlineBand.soon;
    return DeadlineBand.ok;
  }
}

/// The colours and the icon of one band, read from the palette.
@immutable
class DeadlineStyle {
  const DeadlineStyle({required this.foreground, required this.fill, required this.mark, required this.icon});

  /// Text and icon on the soft fill.
  final Color foreground;

  /// The soft fill behind the glyph or the banner.
  final Color fill;

  /// The solid colour for borders and shapes.
  final Color mark;

  /// The shape that says the band without colour.
  final IconData icon;
}

extension DeadlineBandStyle on DeadlineBand {
  DeadlineStyle styleIn(MachvonV2 theme) {
    final MachvonV2Palette p = theme.palette;
    switch (this) {
      case DeadlineBand.late:
        return DeadlineStyle(foreground: p.lateFg, fill: p.lateBg, mark: p.lateMark, icon: Icons.report_outlined);
      case DeadlineBand.soon:
        return DeadlineStyle(foreground: p.soonFg, fill: p.soonBg, mark: p.soonMark, icon: Icons.warning_amber_rounded);
      case DeadlineBand.ok:
        return DeadlineStyle(foreground: p.okFg, fill: p.okBg, mark: p.okMark, icon: Icons.schedule);
      case DeadlineBand.done:
        return DeadlineStyle(foreground: p.primaryStrong, fill: p.primarySoft, mark: p.primary, icon: Icons.check_circle_outline);
    }
  }
}
