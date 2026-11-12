import 'package:flutter/material.dart' show ThemeMode;
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Where the choice of light, dark or system is kept between runs: a text port, so the application writes it to the platform store and a
/// test to memory.
abstract interface class ThemePreferenceStore {
  Future<String?> read();

  Future<void> write(String value);
}

/// A store that forgets at exit; the default until the application installs the platform one.
final class MemoryThemePreferenceStore implements ThemePreferenceStore {
  MemoryThemePreferenceStore([this._value]);

  String? _value;

  @override
  Future<String?> read() async => _value;

  @override
  Future<void> write(String value) async => _value = value;
}

final Provider<ThemePreferenceStore> themePreferenceStoreProvider = Provider<ThemePreferenceStore>((Ref ref) => MemoryThemePreferenceStore());

/// The mode of a person who has not chosen. Light until the screens of the redesign waves (MUX-3 B to D) have all moved to the theme
/// colours: a screen that still names a light token would be unreadable on the dark surface, so the dark mode is offered as a choice, not
/// followed from the system by default.
const ThemeMode kDefaultThemeMode = ThemeMode.light;

/// The text that stands for a mode in the store; reading anything else gives the default.
String themeModeToText(ThemeMode mode) => mode.name;

ThemeMode themeModeFromText(String? text) {
  for (final ThemeMode mode in ThemeMode.values) {
    if (mode.name == text) return mode;
  }
  return kDefaultThemeMode;
}

/// The mode the application is drawn in: system, light or dark. [restore] reads the saved choice at start; [select] changes it at once and
/// saves it, so it survives a restart. A store that fails leaves the choice in memory: a person is never told off for a failed save.
class ThemeModeNotifier extends Notifier<ThemeMode> {
  @override
  ThemeMode build() => kDefaultThemeMode;

  Future<void> restore() async {
    try {
      state = themeModeFromText(await ref.read(themePreferenceStoreProvider).read());
    } on Object {
      state = kDefaultThemeMode;
    }
  }

  Future<void> select(ThemeMode mode) async {
    state = mode;
    try {
      await ref.read(themePreferenceStoreProvider).write(themeModeToText(mode));
    } on Object {
      // The choice stays for this run.
    }
  }
}

final NotifierProvider<ThemeModeNotifier, ThemeMode> themeModeProvider = NotifierProvider<ThemeModeNotifier, ThemeMode>(ThemeModeNotifier.new);
