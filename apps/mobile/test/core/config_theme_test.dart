import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/app/app_config.dart';
import 'package:machvon_mobile/core/theme/app_theme.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

void main() {
  group('TK-MOB-001-2 the configuration of the application', () {
    test('an https base URL is accepted', () {
      final AppConfig config = AppConfig.parse('https://api.machvon.vn/v1', allowInsecureLoopback: false);
      expect(config.apiBaseUrl.toString(), 'https://api.machvon.vn/v1');
      expect(config.allowInsecureLoopback, isFalse);
    });

    test('plain http is accepted only for a loopback host of a debug build', () {
      expect(AppConfig.parse('http://10.0.2.2:3000', allowInsecureLoopback: true).allowInsecureLoopback, isTrue);
      expect(AppConfig.parse('http://localhost:3000', allowInsecureLoopback: true).apiBaseUrl.host, 'localhost');
      expect(() => AppConfig.parse('http://10.0.2.2:3000', allowInsecureLoopback: false), throwsFormatException);
      expect(() => AppConfig.parse('http://api.machvon.vn', allowInsecureLoopback: true), throwsFormatException);
      expect(() => AppConfig.parse('ftp://localhost', allowInsecureLoopback: true), throwsFormatException);
    });

    test('a missing, relative or decorated URL is refused', () {
      for (final String raw in <String>[
        '',
        'api.machvon.vn',
        '/v1',
        'https://',
        'https://user:pw@api.machvon.vn',
        'https://api.machvon.vn?x=1',
        'https://api.machvon.vn#f',
      ]) {
        expect(() => AppConfig.parse(raw, allowInsecureLoopback: true), throwsFormatException, reason: raw);
      }
    });
  });

  group('TK-MOB-001-3 the theme from the design tokens', () {
    test('without a tenant theme it is the generated theme of the tokens', () {
      final ThemeData theme = buildAppTheme(platform: TargetPlatform.android);
      expect(theme.colorScheme.primary, MachvonColors.primary);
      expect(theme.textTheme.bodyMedium?.fontSize, MachvonFont.mobileBody);
      expect(theme.scaffoldBackgroundColor, MachvonColors.background);
    });

    test('buttons are at least 48 dp on Android and 44 pt on iOS', () {
      for (final (TargetPlatform platform, double minimum) in <(TargetPlatform, double)>[
        (TargetPlatform.android, 48),
        (TargetPlatform.iOS, 44),
      ]) {
        final ThemeData theme = buildAppTheme(platform: platform);
        for (final ButtonStyle? style in <ButtonStyle?>[
          theme.filledButtonTheme.style,
          theme.elevatedButtonTheme.style,
          theme.outlinedButtonTheme.style,
          theme.textButtonTheme.style,
        ]) {
          expect(style?.minimumSize?.resolve(<WidgetState>{}), Size(minimum, minimum), reason: platform.name);
        }
      }
    });

    test('an accepted tenant theme changes the colours of the application', () {
      final ThemeData theme = buildAppTheme(
        platform: TargetPlatform.android,
        tenantOverlay: const <String, String>{'primary': '#0a4d8c', 'background': '#fafafa'},
      );
      expect(theme.colorScheme.primary, const Color(0xFF0A4D8C));
      expect(theme.scaffoldBackgroundColor, const Color(0xFFFAFAFA));
    });

    test('a tenant theme that fails the contrast rule is ignored whole, never half applied', () {
      final ThemeData theme = buildAppTheme(
        platform: TargetPlatform.android,
        tenantOverlay: const <String, String>{'primary': '#ffffff', 'background': '#fafafa'},
      );
      expect(theme.colorScheme.primary, MachvonColors.primary);
      expect(theme.scaffoldBackgroundColor, MachvonColors.background);
    });

    test('a tenant theme with a value that could carry code is ignored', () {
      final ThemeData theme = buildAppTheme(
        platform: TargetPlatform.android,
        tenantOverlay: const <String, String>{'primary': 'url(http://evil)'},
      );
      expect(theme.colorScheme.primary, MachvonColors.primary);
    });

    test('the provider follows the published tenant theme', () {
      final ProviderContainer container = ProviderContainer();
      addTearDown(container.dispose);
      expect(container.read(appThemeProvider).colorScheme.primary, MachvonColors.primary);

      container.read(tenantThemeProvider.notifier).publish(const <String, String>{'primary': '#0a4d8c'});
      expect(container.read(appThemeProvider).colorScheme.primary, const Color(0xFF0A4D8C));

      container.read(tenantThemeProvider.notifier).publish(null);
      expect(container.read(appThemeProvider).colorScheme.primary, MachvonColors.primary);
    });
  });
}
