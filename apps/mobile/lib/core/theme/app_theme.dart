import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import 'colors.dart';
import 'components.dart';
import 'machvon_semantic.dart';
import 'typography.dart';

export 'colors.dart';
export 'components.dart';
export 'theme_mode.dart';
export 'typography.dart';

/// The published theme of the active tenant as the hex colours the server stores (SAS-04), or null for the base theme.
/// ST-MOB-004 sets it after tenant discovery.
class TenantThemeNotifier extends Notifier<Map<String, String>?> {
  @override
  Map<String, String>? build() => null;

  void publish(Map<String, String>? overlay) => state = overlay;
}

final NotifierProvider<TenantThemeNotifier, Map<String, String>?> tenantThemeProvider =
    NotifierProvider<TenantThemeNotifier, Map<String, String>?>(TenantThemeNotifier.new);

/// The neutral colours the stock widgets of the theme are drawn with: the colours the application has always had in the light mode (so
/// the screens that are not yet on the new widgets do not move), and the dark palette of `mobile.v2` in the dark mode.
@immutable
class _Neutrals {
  const _Neutrals({
    required this.surface,
    required this.surface2,
    required this.background,
    required this.border,
    required this.ink,
    required this.secondary,
    required this.outline,
    required this.danger,
    required this.dangerSoft,
    required this.snack,
    required this.snackText,
    required this.snackAction,
  });

  factory _Neutrals.of(MachvonV2 v2) {
    if (v2.isDark) {
      final MachvonV2Palette p = v2.palette;
      return _Neutrals(
        surface: p.surface,
        surface2: p.sunken,
        background: p.bg,
        border: p.line,
        ink: p.ink,
        secondary: p.ink2,
        outline: p.outline,
        danger: p.lateFg,
        dangerSoft: p.lateBg,
        snack: p.lineStrong,
        snackText: p.ink,
        snackAction: p.primaryStrong,
      );
    }
    return const _Neutrals(
      surface: MachvonColors.surface,
      surface2: MachvonColors.surface2,
      background: MachvonColors.background,
      border: MachvonColors.border,
      ink: MachvonColors.ink,
      secondary: MachvonColors.textSecondary,
      outline: MachvonColors.chartPlan,
      danger: MachvonColors.danger,
      dangerSoft: MachvonColors.dangerSoft,
      snack: MachvonColors.sidebar,
      snackText: MachvonColors.menuText,
      snackAction: MachvonColors.focusOnDark,
    );
  }

  final Color surface;
  final Color surface2;
  final Color background;
  final Color border;
  final Color ink;
  final Color secondary;
  final Color outline;
  final Color danger;
  final Color dangerSoft;
  final Color snack;
  final Color snackText;
  final Color snackAction;
}

/// The theme of the application "Executive oil green": the Material theme generated from the design tokens, completed with the
/// themes of every shared control (design.md), the phone palette `mobile.v2` as the theme extension [MachvonV2], with the tenant overlay
/// applied when it is accepted whole by the same contrast rules as the web (a rejected overlay is ignored, never half applied).
///
/// In the light mode the stock controls keep the look the application has always had; in the dark mode they take the dark palette. The
/// semantic colours (success, warning, danger, info) and the three deadline bands are never changed by a tenant. The tenant `menu`
/// colour is the command band (`header`) of the new design.
ThemeData buildAppTheme({TargetPlatform? platform, Map<String, String>? tenantOverlay, Brightness brightness = Brightness.light}) {
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
  final bool dark = brightness == Brightness.dark;
  final MachvonV2 v2 = (dark ? MachvonV2.dark : MachvonV2.light).withTenant(
    header: dark ? null : menu,
    onHeader: dark ? null : menuText,
    primary: dark ? null : primary,
    onPrimary: dark ? null : onPrimary,
  );
  final _Neutrals n = _Neutrals.of(v2);
  final double touch = machvonMinimumTouchTarget(platform ?? base.platform);
  final BorderSide thinBorder = BorderSide(color: n.border);

  // The primary colour of the mode: the tenant primary in the light mode, the light teal of the dark palette in the dark mode.
  final Color accent = dark ? v2.palette.primary : primary;
  final Color accentOn = dark ? v2.palette.onPrimary : onPrimary;
  // The soft fill behind a selected item: the base token for the base primary, a 12% tint of the tenant primary otherwise.
  final Color primarySoft = dark
      ? v2.palette.primarySoft
      : primary == MachvonColors.primary
          ? MachvonColors.primarySoft
          : Color.alphaBlend(primary.withValues(alpha: 0.12), MachvonColors.surface);

  // The teal of a text button is a little darker than the fill of a primary button: its hover, focus and press tint is the same
  // teal at 10%, and the text must still pass 4.5:1 on that tint.
  final Color accentText = dark
      ? v2.palette.primaryStrong
      : primary == MachvonColors.primary
          ? MachvonColors.primaryHover
          : Color.lerp(primary, Colors.black, 0.2)!;
  final TextTheme text = legacyTextTheme(base.textTheme, v2);
  final ColorScheme scheme = dark
      ? v2DarkColorScheme(v2)
      : base.colorScheme.copyWith(
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
  final Color disabledFill = n.ink.withValues(alpha: 0.12);
  final Color disabledText = n.ink.withValues(alpha: 0.38);

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
              ? Color.alphaBlend(Colors.black.withValues(alpha: 0.18), accent)
              : accent,
    ),
    foregroundColor: WidgetStateProperty.resolveWith<Color>(
      (Set<WidgetState> states) => states.contains(WidgetState.disabled) ? disabledText : accentOn,
    ),
  );
  final ButtonStyle outlined = ButtonStyle(
    minimumSize: minimum,
    shape: shape,
    padding: padding,
    textStyle: buttonText,
    foregroundColor: WidgetStateProperty.resolveWith<Color>(
      (Set<WidgetState> states) => states.contains(WidgetState.disabled) ? disabledText : accentText,
    ),
    side: WidgetStateProperty.resolveWith<BorderSide>(
      (Set<WidgetState> states) => BorderSide(color: states.contains(WidgetState.disabled) ? disabledFill : accent),
    ),
  );
  final ButtonStyle plain = ButtonStyle(
    minimumSize: minimum,
    shape: shape,
    textStyle: buttonText,
    foregroundColor: WidgetStateProperty.resolveWith<Color>(
      (Set<WidgetState> states) => states.contains(WidgetState.disabled) ? disabledText : accentText,
    ),
  );

  final OutlineInputBorder fieldBorder = OutlineInputBorder(
    borderRadius: const BorderRadius.all(Radius.circular(MachvonRadius.control)),
    borderSide: BorderSide(color: scheme.outline),
  );

  return base.copyWith(
    scaffoldBackgroundColor: dark ? n.background : colors['background'],
    colorScheme: scheme,
    textTheme: text,
    primaryTextTheme: text,
    extensions: <ThemeExtension<dynamic>>[const MachvonSemantic(), v2],
    dividerColor: n.border,
    dividerTheme: DividerThemeData(color: n.border, thickness: 1, space: 1),
    appBarTheme: v2AppBarTheme(v2),
    navigationBarTheme: NavigationBarThemeData(
      backgroundColor: n.surface,
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
          color: states.contains(WidgetState.selected) ? accent : n.secondary,
        ),
      ),
      iconTheme: WidgetStateProperty.resolveWith<IconThemeData>(
        (Set<WidgetState> states) => IconThemeData(
          size: 24,
          color: states.contains(WidgetState.selected) ? accent : n.secondary,
        ),
      ),
    ),
    badgeTheme: BadgeThemeData(backgroundColor: n.danger, textColor: n.surface),
    filledButtonTheme: FilledButtonThemeData(style: filled),
    elevatedButtonTheme: ElevatedButtonThemeData(style: filled),
    outlinedButtonTheme: OutlinedButtonThemeData(style: outlined),
    textButtonTheme: TextButtonThemeData(style: plain),
    iconButtonTheme: IconButtonThemeData(style: ButtonStyle(minimumSize: minimum, shape: shape)),
    cardTheme: CardThemeData(
      color: n.surface,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      shape: RoundedRectangleBorder(borderRadius: const BorderRadius.all(Radius.circular(MachvonRadius.card)), side: thinBorder),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: n.surface,
      contentPadding: const EdgeInsets.symmetric(horizontal: MachvonSpace.space16, vertical: MachvonSpace.space12),
      border: fieldBorder,
      enabledBorder: fieldBorder,
      disabledBorder: fieldBorder.copyWith(borderSide: BorderSide(color: n.border)),
      focusedBorder: fieldBorder.copyWith(borderSide: BorderSide(color: accent, width: 2)),
      errorBorder: fieldBorder.copyWith(borderSide: BorderSide(color: n.danger)),
      focusedErrorBorder: fieldBorder.copyWith(borderSide: BorderSide(color: n.danger, width: 2)),
      labelStyle: text.bodyMedium?.copyWith(color: n.secondary),
      floatingLabelStyle: text.bodySmall?.copyWith(color: n.secondary),
      helperStyle: text.bodySmall,
      errorStyle: text.bodySmall?.copyWith(color: n.danger),
      hintStyle: text.bodyMedium?.copyWith(color: n.secondary),
    ),
    chipTheme: ChipThemeData(
      backgroundColor: n.surface,
      selectedColor: primarySoft,
      disabledColor: n.surface2,
      checkmarkColor: accent,
      side: thinBorder,
      shape: const StadiumBorder(),
      labelStyle: text.bodySmall?.copyWith(color: n.ink, fontWeight: FontWeight.w500),
      secondaryLabelStyle: text.bodySmall?.copyWith(color: n.ink, fontWeight: FontWeight.w600),
      padding: const EdgeInsets.symmetric(horizontal: MachvonSpace.space4),
    ),
    listTileTheme: ListTileThemeData(
      contentPadding: const EdgeInsets.symmetric(horizontal: MachvonSpace.space16),
      minTileHeight: 48,
      iconColor: n.secondary,
      textColor: n.ink,
    ),
    snackBarTheme: SnackBarThemeData(
      behavior: SnackBarBehavior.floating,
      backgroundColor: n.snack,
      contentTextStyle: text.bodyMedium?.copyWith(color: n.snackText),
      actionTextColor: n.snackAction,
      shape: controlShape,
    ),
    dialogTheme: DialogThemeData(
      backgroundColor: n.surface,
      surfaceTintColor: Colors.transparent,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.all(Radius.circular(MachvonRadius.card))),
      titleTextStyle: text.headlineSmall,
      contentTextStyle: text.bodyMedium,
    ),
    bottomSheetTheme: v2BottomSheetTheme(v2),
    progressIndicatorTheme: ProgressIndicatorThemeData(color: accent, linearTrackColor: n.border),
  );
}

/// The theme provider of the application in the light mode: the tenant overlay on the tokens, for the platform the app runs on.
final Provider<ThemeData> appThemeProvider = Provider<ThemeData>(
  (Ref ref) => buildAppTheme(tenantOverlay: ref.watch(tenantThemeProvider)),
);

/// The theme provider of the dark mode, the same overlay on the dark palette. The application gives both to the Material app and its
/// `themeMode` (see `themeModeProvider`) picks one.
final Provider<ThemeData> darkAppThemeProvider = Provider<ThemeData>(
  (Ref ref) => buildAppTheme(tenantOverlay: ref.watch(tenantThemeProvider), brightness: Brightness.dark),
);
