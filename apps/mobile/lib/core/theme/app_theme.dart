import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

/// The published theme of the active tenant as the hex colours the server stores (SAS-04), or null for the base theme.
/// ST-MOB-004 sets it after tenant discovery.
class TenantThemeNotifier extends Notifier<Map<String, String>?> {
  @override
  Map<String, String>? build() => null;

  void publish(Map<String, String>? overlay) => state = overlay;
}

final NotifierProvider<TenantThemeNotifier, Map<String, String>?> tenantThemeProvider =
    NotifierProvider<TenantThemeNotifier, Map<String, String>?>(TenantThemeNotifier.new);

/// The theme of the application: the Material theme generated from the design tokens, with the tenant overlay applied
/// when it is accepted whole by the same contrast rules as the web (a rejected overlay is ignored, never half applied).
ThemeData buildAppTheme({TargetPlatform? platform, Map<String, String>? tenantOverlay}) {
  final ThemeData base = machvonTheme(platform: platform);
  if (tenantOverlay == null || !overlayAccepted(tenantOverlay)) return base;
  final Map<String, Color> colors = <String, Color>{...kBaseTenantTheme};
  for (final MapEntry<String, String> entry in tenantOverlay.entries) {
    final Color? parsed = kThemeColorKeys.contains(entry.key) ? parseHexColor(entry.value) : null;
    if (parsed != null) colors[entry.key] = parsed;
  }
  final Color primary = colors['primary']!;
  final Color onPrimary = colors['primaryText']!;
  return base.copyWith(
    scaffoldBackgroundColor: colors['background'],
    colorScheme: base.colorScheme.copyWith(primary: primary, onPrimary: onPrimary),
    appBarTheme: AppBarTheme(
      backgroundColor: colors['headerBg'],
      foregroundColor: colors['headerText'],
      titleTextStyle: TextStyle(
        color: colors['titleColor'],
        fontSize: MachvonFont.title,
        fontWeight: FontWeight.w600,
      ),
    ),
    navigationBarTheme: NavigationBarThemeData(
      backgroundColor: colors['menu'],
      indicatorColor: colors['selected'],
      labelTextStyle: WidgetStatePropertyAll<TextStyle>(
        TextStyle(fontSize: MachvonFont.navSecondary, color: colors['menuText']),
      ),
      iconTheme: WidgetStateProperty.resolveWith<IconThemeData>(
        (Set<WidgetState> states) => IconThemeData(
          color: states.contains(WidgetState.selected) ? colors['selectedText'] : colors['menuText'],
        ),
      ),
    ),
  );
}

/// The theme provider of the application: the tenant overlay on the tokens, for the platform the app runs on.
final Provider<ThemeData> appThemeProvider = Provider<ThemeData>(
  (Ref ref) => buildAppTheme(tenantOverlay: ref.watch(tenantThemeProvider)),
);
