import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show SystemUiOverlayStyle;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import 'machvon_semantic.dart';

/// The published theme of the active tenant as the hex colours the server stores (SAS-04), or null for the base theme.
/// ST-MOB-004 sets it after tenant discovery.
class TenantThemeNotifier extends Notifier<Map<String, String>?> {
  @override
  Map<String, String>? build() => null;

  void publish(Map<String, String>? overlay) => state = overlay;
}

final NotifierProvider<TenantThemeNotifier, Map<String, String>?> tenantThemeProvider =
    NotifierProvider<TenantThemeNotifier, Map<String, String>?>(TenantThemeNotifier.new);

/// Tabular figures: the digits of a number have one width, so columns of amounts line up and a changing value does not jitter.
const List<FontFeature> kTabularFigures = <FontFeature>[FontFeature.tabularFigures()];

/// The theme of the application "Xanh dầu điều hành": the Material theme generated from the design tokens, completed with the
/// themes of every shared control (design.md), with the tenant overlay applied when it is accepted whole by the same contrast
/// rules as the web (a rejected overlay is ignored, never half applied).
///
/// The app bar and the text on it take the tenant `menu` and `menuText`; the bottom navigation is white with the tenant
/// primary as the selected colour; the semantic colours (success, warning, danger, info) are never changed by a tenant.
ThemeData buildAppTheme({TargetPlatform? platform, Map<String, String>? tenantOverlay}) {
  final ThemeData base = machvonTheme(platform: platform);
  final Map<String, Color> colors = <String, Color>{...kBaseTenantTheme};
  if (tenantOverlay != null && overlayAccepted(tenantOverlay)) {
    for (final MapEntry<String, String> entry in tenantOverlay.entries) {
      final Color? parsed = kThemeColorKeys.contains(entry.key) ? parseHexColor(entry.value) : null;
      if (parsed != null) colors[entry.key] = parsed;
    }
  }
  final Color primary = colors['primary']!;
  final Color onPrimary = colors['primaryText']!;
  final Color menu = colors['menu']!;
  final Color menuText = colors['menuText']!;
  final double touch = machvonMinimumTouchTarget(platform ?? base.platform);
  // The soft fill behind a selected item: the base token for the base primary, a 12% tint of the tenant primary otherwise.
  final Color primarySoft = primary == MachvonColors.primary
      ? MachvonColors.primarySoft
      : Color.alphaBlend(primary.withValues(alpha: 0.12), MachvonColors.surface);

  // The teal of a text button is a little darker than the fill of a primary button: its hover, focus and press tint is the same
  // teal at 10%, and the text must still pass 4.5:1 on that tint.
  final Color primaryText = primary == MachvonColors.primary ? MachvonColors.primaryHover : Color.lerp(primary, Colors.black, 0.2)!;
  final TextTheme text = _textTheme(base.textTheme);
  final ColorScheme scheme = base.colorScheme.copyWith(
    primary: primary,
    onPrimary: onPrimary,
    primaryContainer: primarySoft,
    onPrimaryContainer: MachvonColors.ink,
    secondaryContainer: primarySoft,
    onSecondaryContainer: MachvonColors.ink,
    surfaceTint: Colors.transparent,
    surfaceContainerLowest: MachvonColors.surface,
    surfaceContainerLow: MachvonColors.surface2,
    surfaceContainer: MachvonColors.surface2,
    surfaceContainerHigh: MachvonColors.background,
    surfaceContainerHighest: MachvonColors.border,
    onSurfaceVariant: MachvonColors.textSecondary,
    outline: MachvonColors.chartPlan,
    outlineVariant: MachvonColors.border,
    errorContainer: MachvonColors.dangerSoft,
    onErrorContainer: MachvonColors.danger,
  );

  const RoundedRectangleBorder controlShape = RoundedRectangleBorder(borderRadius: BorderRadius.all(Radius.circular(MachvonRadius.control)));
  final WidgetStateProperty<Size> minimum = WidgetStatePropertyAll<Size>(Size(touch, touch));
  const WidgetStateProperty<OutlinedBorder> shape = WidgetStatePropertyAll<OutlinedBorder>(controlShape);
  const WidgetStateProperty<EdgeInsetsGeometry> padding =
      WidgetStatePropertyAll<EdgeInsetsGeometry>(EdgeInsets.symmetric(horizontal: MachvonSpace.space20, vertical: MachvonSpace.space12));
  final WidgetStateProperty<TextStyle?> buttonText = WidgetStatePropertyAll<TextStyle?>(text.labelLarge);
  final Color disabledFill = MachvonColors.ink.withValues(alpha: 0.12);
  final Color disabledText = MachvonColors.ink.withValues(alpha: 0.38);

  final ButtonStyle filled = ButtonStyle(
    minimumSize: minimum,
    shape: shape,
    padding: padding,
    textStyle: buttonText,
    elevation: const WidgetStatePropertyAll<double>(0),
    backgroundColor: WidgetStateProperty.resolveWith<Color>(
      (Set<WidgetState> states) => states.contains(WidgetState.disabled)
          ? disabledFill
          : states.contains(WidgetState.pressed) || states.contains(WidgetState.hovered)
              ? Color.alphaBlend(Colors.black.withValues(alpha: 0.18), primary)
              : primary,
    ),
    foregroundColor: WidgetStateProperty.resolveWith<Color>(
      (Set<WidgetState> states) => states.contains(WidgetState.disabled) ? disabledText : onPrimary,
    ),
  );
  final ButtonStyle outlined = ButtonStyle(
    minimumSize: minimum,
    shape: shape,
    padding: padding,
    textStyle: buttonText,
    foregroundColor: WidgetStateProperty.resolveWith<Color>(
      (Set<WidgetState> states) => states.contains(WidgetState.disabled) ? disabledText : primaryText,
    ),
    side: WidgetStateProperty.resolveWith<BorderSide>(
      (Set<WidgetState> states) => BorderSide(color: states.contains(WidgetState.disabled) ? disabledFill : primary),
    ),
  );
  final ButtonStyle plain = ButtonStyle(
    minimumSize: minimum,
    shape: shape,
    textStyle: buttonText,
    foregroundColor: WidgetStateProperty.resolveWith<Color>(
      (Set<WidgetState> states) => states.contains(WidgetState.disabled) ? disabledText : primaryText,
    ),
  );

  const BorderSide thinBorder = BorderSide(color: MachvonColors.border);
  final OutlineInputBorder fieldBorder = OutlineInputBorder(
    borderRadius: const BorderRadius.all(Radius.circular(MachvonRadius.control)),
    borderSide: BorderSide(color: scheme.outline),
  );

  return base.copyWith(
    scaffoldBackgroundColor: colors['background'],
    colorScheme: scheme,
    textTheme: text,
    primaryTextTheme: text,
    extensions: <ThemeExtension<dynamic>>[const MachvonSemantic()],
    dividerColor: MachvonColors.border,
    dividerTheme: const DividerThemeData(color: MachvonColors.border, thickness: 1, space: 1),
    appBarTheme: AppBarTheme(
      backgroundColor: menu,
      foregroundColor: menuText,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      scrolledUnderElevation: 0,
      centerTitle: false,
      titleSpacing: MachvonSpace.space16,
      iconTheme: IconThemeData(color: menuText),
      actionsIconTheme: IconThemeData(color: menuText),
      systemOverlayStyle: SystemUiOverlayStyle.light,
      titleTextStyle: text.headlineSmall?.copyWith(color: menuText),
    ),
    navigationBarTheme: NavigationBarThemeData(
      backgroundColor: MachvonColors.surface,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      height: 72,
      indicatorColor: primarySoft,
      indicatorShape: const StadiumBorder(),
      labelBehavior: NavigationDestinationLabelBehavior.alwaysShow,
      labelTextStyle: WidgetStateProperty.resolveWith<TextStyle>(
        (Set<WidgetState> states) => TextStyle(
          fontSize: MachvonFont.navSecondary,
          fontWeight: states.contains(WidgetState.selected) ? FontWeight.w700 : FontWeight.w500,
          color: states.contains(WidgetState.selected) ? primary : MachvonColors.textSecondary,
        ),
      ),
      iconTheme: WidgetStateProperty.resolveWith<IconThemeData>(
        (Set<WidgetState> states) => IconThemeData(
          size: 24,
          color: states.contains(WidgetState.selected) ? primary : MachvonColors.textSecondary,
        ),
      ),
    ),
    badgeTheme: const BadgeThemeData(backgroundColor: MachvonColors.danger, textColor: MachvonColors.surface),
    filledButtonTheme: FilledButtonThemeData(style: filled),
    elevatedButtonTheme: ElevatedButtonThemeData(style: filled),
    outlinedButtonTheme: OutlinedButtonThemeData(style: outlined),
    textButtonTheme: TextButtonThemeData(style: plain),
    iconButtonTheme: IconButtonThemeData(style: ButtonStyle(minimumSize: minimum, shape: shape)),
    cardTheme: const CardThemeData(
      color: MachvonColors.surface,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.all(Radius.circular(MachvonRadius.card)), side: thinBorder),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: MachvonColors.surface,
      contentPadding: const EdgeInsets.symmetric(horizontal: MachvonSpace.space16, vertical: MachvonSpace.space12),
      border: fieldBorder,
      enabledBorder: fieldBorder,
      disabledBorder: fieldBorder.copyWith(borderSide: const BorderSide(color: MachvonColors.border)),
      focusedBorder: fieldBorder.copyWith(borderSide: BorderSide(color: primary, width: 2)),
      errorBorder: fieldBorder.copyWith(borderSide: const BorderSide(color: MachvonColors.danger)),
      focusedErrorBorder: fieldBorder.copyWith(borderSide: const BorderSide(color: MachvonColors.danger, width: 2)),
      labelStyle: text.bodyMedium?.copyWith(color: MachvonColors.textSecondary),
      floatingLabelStyle: text.bodySmall?.copyWith(color: MachvonColors.textSecondary),
      helperStyle: text.bodySmall,
      errorStyle: text.bodySmall?.copyWith(color: MachvonColors.danger),
      hintStyle: text.bodyMedium?.copyWith(color: MachvonColors.textSecondary),
    ),
    chipTheme: ChipThemeData(
      backgroundColor: MachvonColors.surface,
      selectedColor: primarySoft,
      disabledColor: MachvonColors.surface2,
      checkmarkColor: primary,
      side: thinBorder,
      shape: const StadiumBorder(),
      labelStyle: text.bodySmall?.copyWith(color: MachvonColors.ink, fontWeight: FontWeight.w500),
      secondaryLabelStyle: text.bodySmall?.copyWith(color: MachvonColors.ink, fontWeight: FontWeight.w600),
      padding: const EdgeInsets.symmetric(horizontal: MachvonSpace.space4),
    ),
    listTileTheme: const ListTileThemeData(
      contentPadding: EdgeInsets.symmetric(horizontal: MachvonSpace.space16),
      minTileHeight: 48,
      iconColor: MachvonColors.textSecondary,
      textColor: MachvonColors.ink,
    ),
    snackBarTheme: SnackBarThemeData(
      behavior: SnackBarBehavior.floating,
      backgroundColor: MachvonColors.sidebar,
      contentTextStyle: text.bodyMedium?.copyWith(color: MachvonColors.menuText),
      actionTextColor: MachvonColors.focusOnDark,
      shape: controlShape,
    ),
    dialogTheme: DialogThemeData(
      backgroundColor: MachvonColors.surface,
      surfaceTintColor: Colors.transparent,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.all(Radius.circular(MachvonRadius.card))),
      titleTextStyle: text.headlineSmall,
      contentTextStyle: text.bodyMedium,
    ),
    bottomSheetTheme: const BottomSheetThemeData(
      backgroundColor: MachvonColors.surface,
      surfaceTintColor: Colors.transparent,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(MachvonRadius.card))),
    ),
    progressIndicatorTheme: ProgressIndicatorThemeData(color: primary, linearTrackColor: MachvonColors.border),
  );
}

/// The type scale of the phone: 12 secondary and labels, 14 compact, 16 body, 20 titles, 28 page title, 32 the number of the command
/// block; digits are tabular on the styles that carry numbers. No size below 12.
TextTheme _textTheme(TextTheme base) {
  TextStyle? sized(TextStyle? style, double size, FontWeight weight, {double? height, bool figures = false, double? letterSpacing}) {
    return style?.copyWith(
      fontSize: size,
      fontWeight: weight,
      height: height,
      letterSpacing: letterSpacing,
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
    bodySmall: base.bodySmall?.copyWith(fontSize: MachvonFont.navSecondary, height: 1.35, color: MachvonColors.textSecondary),
    labelLarge: sized(base.labelLarge, MachvonFont.mobileBody, FontWeight.w600, height: 1.25),
    labelMedium: sized(base.labelMedium, 12, FontWeight.w600, height: 1.25, letterSpacing: 0.2),
    labelSmall: sized(base.labelSmall, 12, FontWeight.w500, height: 1.25),
  );
}

/// The theme provider of the application: the tenant overlay on the tokens, for the platform the app runs on.
final Provider<ThemeData> appThemeProvider = Provider<ThemeData>(
  (Ref ref) => buildAppTheme(tenantOverlay: ref.watch(tenantThemeProvider)),
);
