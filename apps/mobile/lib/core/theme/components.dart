import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show SystemUiOverlayStyle;
import 'package:machvon_tokens/machvon_tokens.dart';

import 'colors.dart';
import 'typography.dart';

const RoundedRectangleBorder _controlShape = RoundedRectangleBorder(borderRadius: BorderRadius.all(Radius.circular(MachvonV2Radius.control)));

/// The solid primary button of the phone design: 48 high, radius 12, the primary colour with the text colour of the palette, a quiet
/// fill when locked (a locked button is explained by the bar it sits in).
ButtonStyle v2PrimaryButtonStyle(MachvonV2 theme) {
  final MachvonV2Palette p = theme.palette;
  return ButtonStyle(
    minimumSize: const WidgetStatePropertyAll<Size>(Size(MachvonV2Size.touchMin, MachvonV2Size.actionButton)),
    shape: const WidgetStatePropertyAll<OutlinedBorder>(_controlShape),
    padding: const WidgetStatePropertyAll<EdgeInsetsGeometry>(EdgeInsets.symmetric(horizontal: MachvonV2Space.s16)),
    elevation: const WidgetStatePropertyAll<double>(0),
    textStyle: WidgetStatePropertyAll<TextStyle>(MachvonV2Text.of(theme).bodyStrong),
    backgroundColor: WidgetStateProperty.resolveWith<Color>((Set<WidgetState> states) => states.contains(WidgetState.disabled) ? p.sunken : p.primary),
    foregroundColor: WidgetStateProperty.resolveWith<Color>((Set<WidgetState> states) => states.contains(WidgetState.disabled) ? p.ink3 : p.onPrimary),
    overlayColor: WidgetStatePropertyAll<Color>(p.onPrimary.withValues(alpha: 0.12)),
  );
}

/// The quiet button: the surface colour, a 1.5 outline that reaches 3:1 on the surface, the strong primary for the text.
ButtonStyle v2QuietButtonStyle(MachvonV2 theme) {
  final MachvonV2Palette p = theme.palette;
  return ButtonStyle(
    minimumSize: const WidgetStatePropertyAll<Size>(Size(MachvonV2Size.touchMin, MachvonV2Size.actionButton)),
    shape: const WidgetStatePropertyAll<OutlinedBorder>(_controlShape),
    padding: const WidgetStatePropertyAll<EdgeInsetsGeometry>(EdgeInsets.symmetric(horizontal: MachvonV2Space.s16)),
    textStyle: WidgetStatePropertyAll<TextStyle>(MachvonV2Text.of(theme).bodyStrong),
    foregroundColor: WidgetStateProperty.resolveWith<Color>((Set<WidgetState> states) => states.contains(WidgetState.disabled) ? p.ink3 : p.primaryStrong),
    side: WidgetStateProperty.resolveWith<BorderSide>((Set<WidgetState> states) => BorderSide(color: states.contains(WidgetState.disabled) ? p.line : p.outline, width: 1.5)),
    overlayColor: WidgetStatePropertyAll<Color>(p.primary.withValues(alpha: 0.1)),
  );
}

/// The theme of the slim app bar of the phone design: the surface colour, the ink for the title and the icons, no elevation, no tint.
AppBarTheme v2AppBarTheme(MachvonV2 theme) {
  final MachvonV2Palette p = theme.palette;
  return AppBarTheme(
    backgroundColor: p.surface,
    foregroundColor: p.ink,
    surfaceTintColor: Colors.transparent,
    elevation: 0,
    scrolledUnderElevation: 0,
    centerTitle: false,
    titleSpacing: MachvonV2Space.s16,
    iconTheme: IconThemeData(color: p.ink),
    actionsIconTheme: IconThemeData(color: p.ink),
    systemOverlayStyle: theme.isDark ? SystemUiOverlayStyle.light : SystemUiOverlayStyle.dark,
    titleTextStyle: MachvonV2Text.of(theme).heading,
  );
}

/// The theme of the sheets and snack bars: the surface colour and the sheet radius at the top, the ink for the snack bar.
BottomSheetThemeData v2BottomSheetTheme(MachvonV2 theme) => BottomSheetThemeData(
      backgroundColor: theme.palette.surface,
      surfaceTintColor: Colors.transparent,
      modalBarrierColor: theme.palette.scrim.withValues(alpha: MachvonV2Motion.scrimOpacity),
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(MachvonV2Radius.sheet))),
    );

/// The colour scheme of the dark mode, built from the dark palette (the light scheme is the one the app has always had).
ColorScheme v2DarkColorScheme(MachvonV2 theme) {
  final MachvonV2Palette p = theme.palette;
  return ColorScheme.dark(
    primary: p.primary,
    onPrimary: p.onPrimary,
    primaryContainer: p.primarySoft,
    onPrimaryContainer: p.ink,
    secondary: p.primaryStrong,
    onSecondary: p.onPrimary,
    secondaryContainer: p.primarySoft,
    onSecondaryContainer: p.ink,
    error: p.lateMark,
    onError: p.onPrimary,
    errorContainer: p.lateBg,
    onErrorContainer: p.lateFg,
    surface: p.surface,
    onSurface: p.ink,
    onSurfaceVariant: p.ink2,
    outline: p.outline,
    outlineVariant: p.line,
    surfaceTint: Colors.transparent,
    surfaceContainerLowest: p.bg,
    surfaceContainerLow: p.surface,
    surfaceContainer: p.sunken,
    surfaceContainerHigh: p.sunken,
    surfaceContainerHighest: p.line,
  );
}
