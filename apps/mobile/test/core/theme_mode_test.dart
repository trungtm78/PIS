import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/app/theme_preference_store.dart';
import 'package:machvon_mobile/core/theme/app_theme.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../features/session/support/world.dart' show MemorySecureStore;
import '../support/harness.dart';
import '../support/list_feature.dart';

/// A store that always fails, for a platform whose secure storage is not available.
class _BrokenStore implements ThemePreferenceStore {
  @override
  Future<String?> read() => throw StateError('no storage');

  @override
  Future<void> write(String value) => throw StateError('no storage');
}

void main() {
  group('the choice of light, dark or system', () {
    test('what a person has not chosen is the default, and unknown or empty text reads as the default', () {
      expect(kDefaultThemeMode, ThemeMode.light);
      expect(themeModeFromText(null), kDefaultThemeMode);
      expect(themeModeFromText(''), kDefaultThemeMode);
      expect(themeModeFromText('purple'), kDefaultThemeMode);
      for (final ThemeMode mode in ThemeMode.values) {
        expect(themeModeFromText(themeModeToText(mode)), mode);
      }
    });

    test('a choice is kept at once, saved, and read back at the next start', () async {
      final MemoryThemePreferenceStore store = MemoryThemePreferenceStore();
      final ProviderContainer first = ProviderContainer(overrides: [themePreferenceStoreProvider.overrideWithValue(store)]);
      addTearDown(first.dispose);
      expect(first.read(themeModeProvider), ThemeMode.light);
      await first.read(themeModeProvider.notifier).select(ThemeMode.dark);
      expect(first.read(themeModeProvider), ThemeMode.dark);
      expect(await store.read(), 'dark');

      final ProviderContainer restarted = ProviderContainer(overrides: [themePreferenceStoreProvider.overrideWithValue(store)]);
      addTearDown(restarted.dispose);
      expect(restarted.read(themeModeProvider), ThemeMode.light, reason: 'before restore the first frame is the default');
      await restarted.read(themeModeProvider.notifier).restore();
      expect(restarted.read(themeModeProvider), ThemeMode.dark);
      await restarted.read(themeModeProvider.notifier).select(ThemeMode.system);
      expect(await store.read(), 'system');
    });

    test('a store that fails never fails the person: the choice stays for the run and a failed read is the default', () async {
      final ProviderContainer container = ProviderContainer(overrides: [themePreferenceStoreProvider.overrideWithValue(_BrokenStore())]);
      addTearDown(container.dispose);
      await container.read(themeModeProvider.notifier).restore();
      expect(container.read(themeModeProvider), kDefaultThemeMode);
      await container.read(themeModeProvider.notifier).select(ThemeMode.dark);
      expect(container.read(themeModeProvider), ThemeMode.dark);
    });

    test('the application stores it under one key of the platform store', () async {
      final MemorySecureStore secure = MemorySecureStore();
      final SecureThemePreferenceStore store = SecureThemePreferenceStore(secure);
      expect(await store.read(), isNull);
      await store.write('dark');
      expect(await secure.read(SecureThemePreferenceStore.key), 'dark');
      expect(await store.read(), 'dark');
      expect(SecureThemePreferenceStore.key, 'ui.themeMode');
    });

    test('the default store keeps the value in memory', () async {
      final MemoryThemePreferenceStore store = MemoryThemePreferenceStore('light');
      expect(await store.read(), 'light');
      final ProviderContainer container = ProviderContainer();
      addTearDown(container.dispose);
      await container.read(themePreferenceStoreProvider).write('dark');
      expect(await container.read(themePreferenceStoreProvider).read(), 'dark');
    });
  });

  group('the dark theme', () {
    test('is the dark palette on the stock controls, with the extension, and keeps the minimum touch size', () {
      final ThemeData dark = buildAppTheme(platform: TargetPlatform.android, brightness: Brightness.dark);
      expect(dark.brightness, Brightness.dark);
      expect(dark.scaffoldBackgroundColor, MachvonV2Colors.dark.bg);
      expect(dark.colorScheme.surface, MachvonV2Colors.dark.surface);
      expect(dark.colorScheme.primary, MachvonV2Colors.dark.primary);
      expect(dark.textTheme.bodyMedium!.color, MachvonV2Colors.dark.ink);
      expect(dark.extension<MachvonV2>()!.isDark, isTrue);
      expect(dark.filledButtonTheme.style!.minimumSize!.resolve(<WidgetState>{}), const Size(48, 48));
      expect(dark.filledButtonTheme.style!.backgroundColor!.resolve(<WidgetState>{}), MachvonV2Colors.dark.primary);
      expect(dark.appBarTheme.backgroundColor, MachvonV2Colors.dark.surface);
    });

    test('a tenant overlay never recolours the dark mode but the light mode takes it', () {
      const Map<String, String> overlay = <String, String>{'primary': '#0a4d8c', 'menu': '#0a2540'};
      final ThemeData dark = buildAppTheme(tenantOverlay: overlay, brightness: Brightness.dark);
      final ThemeData light = buildAppTheme(tenantOverlay: overlay);
      expect(dark.colorScheme.primary, MachvonV2Colors.dark.primary);
      expect(light.colorScheme.primary, const Color(0xFF0A4D8C));
    });

    test('the light theme is the one the application has always had for the stock controls', () {
      final ThemeData light = buildAppTheme(platform: TargetPlatform.android);
      expect(light.scaffoldBackgroundColor, MachvonColors.background);
      expect(light.colorScheme.primary, MachvonColors.primary);
      expect(light.textTheme.bodySmall!.color, MachvonColors.textSecondary);
      expect(light.cardTheme.color, MachvonColors.surface);
      expect(light.inputDecorationTheme.fillColor, MachvonColors.surface);
    });
  });

  group('the application follows the choice', () {
    testWidgets('the Material app gets both themes and the mode of the provider; choosing dark redraws it in the dark palette at once', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      final ProviderContainer container = await pumpApp(tester, features: const [listFeature]);
      MaterialApp app() => tester.widget<MaterialApp>(find.byType(MaterialApp));
      expect(app().themeMode, ThemeMode.light);
      expect(app().darkTheme!.brightness, Brightness.dark);
      expect(app().theme!.brightness, Brightness.light);

      await container.read(themeModeProvider.notifier).select(ThemeMode.dark);
      await tester.pumpAndSettle();
      expect(app().themeMode, ThemeMode.dark);
      expect(Theme.of(tester.element(find.byType(Scaffold).first)).brightness, Brightness.dark);
      expect(Theme.of(tester.element(find.byType(Scaffold).first)).scaffoldBackgroundColor, MachvonV2Colors.dark.bg);
    });
  });
}
