import 'package:flutter/material.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

/// The five semantic tones of the design (design.md "Semantic"): a state is never shown by colour alone, so every use pairs
/// the tone with a label and an icon.
enum MachvonTone { success, warning, danger, info, neutral }

/// The semantic colours (a strong colour for text and icons, a soft one for the fill behind it) as a theme extension, so a
/// widget reads them from the theme instead of naming a token, and a tenant theme can never change what "danger" means.
@immutable
class MachvonSemantic extends ThemeExtension<MachvonSemantic> {
  const MachvonSemantic({
    this.success = MachvonColors.success,
    this.successSoft = MachvonColors.successSoft,
    this.warning = MachvonColors.warning,
    this.warningSoft = MachvonColors.warningSoft,
    this.danger = MachvonColors.danger,
    this.dangerSoft = MachvonColors.dangerSoft,
    this.info = MachvonColors.info,
    this.infoSoft = MachvonColors.infoSoft,
    this.neutral = MachvonColors.neutral,
    this.neutralSoft = MachvonColors.neutralSoft,
  });

  final Color success;
  final Color successSoft;
  final Color warning;
  final Color warningSoft;
  final Color danger;
  final Color dangerSoft;
  final Color info;
  final Color infoSoft;
  final Color neutral;
  final Color neutralSoft;

  /// The strong colour of [tone]: text, icons and borders on the soft fill or on white.
  Color strong(MachvonTone tone) {
    switch (tone) {
      case MachvonTone.success:
        return success;
      case MachvonTone.warning:
        return warning;
      case MachvonTone.danger:
        return danger;
      case MachvonTone.info:
        return info;
      case MachvonTone.neutral:
        return neutral;
    }
  }

  /// The soft fill of [tone].
  Color soft(MachvonTone tone) {
    switch (tone) {
      case MachvonTone.success:
        return successSoft;
      case MachvonTone.warning:
        return warningSoft;
      case MachvonTone.danger:
        return dangerSoft;
      case MachvonTone.info:
        return infoSoft;
      case MachvonTone.neutral:
        return neutralSoft;
    }
  }

  /// The colour of text drawn on the soft fill of [tone]: the strong colour, darkened toward the ink only as far as needed to reach
  /// the 4.5:1 text contrast (the success green of the tokens is a little short of it on its own soft fill).
  Color onSoft(MachvonTone tone) {
    final Color strong = this.strong(tone);
    final Color fill = soft(tone);
    Color text = strong;
    for (int step = 1; step <= 10 && contrastRatio(text, fill) < kMinTextContrast; step += 1) {
      text = Color.lerp(strong, MachvonColors.ink, step / 10)!;
    }
    return text;
  }

  /// The icon that says the tone without colour.
  IconData icon(MachvonTone tone) {
    switch (tone) {
      case MachvonTone.success:
        return Icons.check_circle_outline;
      case MachvonTone.warning:
        return Icons.warning_amber_rounded;
      case MachvonTone.danger:
        return Icons.error_outline;
      case MachvonTone.info:
        return Icons.info_outline;
      case MachvonTone.neutral:
        return Icons.remove_circle_outline;
    }
  }

  @override
  MachvonSemantic copyWith({
    Color? success,
    Color? successSoft,
    Color? warning,
    Color? warningSoft,
    Color? danger,
    Color? dangerSoft,
    Color? info,
    Color? infoSoft,
    Color? neutral,
    Color? neutralSoft,
  }) {
    return MachvonSemantic(
      success: success ?? this.success,
      successSoft: successSoft ?? this.successSoft,
      warning: warning ?? this.warning,
      warningSoft: warningSoft ?? this.warningSoft,
      danger: danger ?? this.danger,
      dangerSoft: dangerSoft ?? this.dangerSoft,
      info: info ?? this.info,
      infoSoft: infoSoft ?? this.infoSoft,
      neutral: neutral ?? this.neutral,
      neutralSoft: neutralSoft ?? this.neutralSoft,
    );
  }

  @override
  MachvonSemantic lerp(ThemeExtension<MachvonSemantic>? other, double t) {
    if (other is! MachvonSemantic) return this;
    return MachvonSemantic(
      success: Color.lerp(success, other.success, t)!,
      successSoft: Color.lerp(successSoft, other.successSoft, t)!,
      warning: Color.lerp(warning, other.warning, t)!,
      warningSoft: Color.lerp(warningSoft, other.warningSoft, t)!,
      danger: Color.lerp(danger, other.danger, t)!,
      dangerSoft: Color.lerp(dangerSoft, other.dangerSoft, t)!,
      info: Color.lerp(info, other.info, t)!,
      infoSoft: Color.lerp(infoSoft, other.infoSoft, t)!,
      neutral: Color.lerp(neutral, other.neutral, t)!,
      neutralSoft: Color.lerp(neutralSoft, other.neutralSoft, t)!,
    );
  }
}

/// `context.semantic` for every widget; falls back to the token values when a test theme has no extension.
extension MachvonSemanticContext on BuildContext {
  MachvonSemantic get semantic => Theme.of(this).extension<MachvonSemantic>() ?? const MachvonSemantic();
}
