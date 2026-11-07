import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

void main() {
  group('machvonTheme', () {
    test('uses the Xanh dầu điều hành primary colour of the design tokens', () {
      final ThemeData theme = machvonTheme();
      expect(theme.colorScheme.primary, const Color(0xFF007D77));
      expect(theme.colorScheme.onSurface, const Color(0xFF122D3B));
      expect(theme.scaffoldBackgroundColor, const Color(0xFFF3F6F5));
      expect(theme.colorScheme.error, const Color(0xFFA63838));
    });

    test('sets the mobile body size of 16 and the title size of 28', () {
      final ThemeData theme = machvonTheme();
      expect(theme.textTheme.bodyMedium!.fontSize, 16);
      expect(theme.textTheme.bodyLarge!.fontSize, 16);
      expect(theme.textTheme.titleLarge!.fontSize, 28);
      expect(theme.textTheme.bodySmall!.fontSize, MachvonFont.navSecondary);
    });

    test('uses the font family of the design with its fallbacks', () {
      final ThemeData theme = machvonTheme();
      expect(theme.textTheme.bodyMedium!.fontFamily, MachvonFont.family);
      expect(MachvonFont.family, 'Be Vietnam Pro');
      expect(MachvonFont.fallbackFamilies, <String>['Segoe UI', 'Arial', 'sans-serif']);
    });

    test('keeps the radii and the spacing steps of the design', () {
      expect(MachvonRadius.control, 8);
      expect(MachvonRadius.card, 14);
      expect(MachvonRadius.pill, 999);
      expect(MachvonSpace.space4, 4);
      expect(MachvonSpace.space48, 48);
    });

    test('asks for 44 points on Apple platforms and 48 dp on the others', () {
      expect(machvonMinimumTouchTarget(TargetPlatform.iOS), 44);
      expect(machvonMinimumTouchTarget(TargetPlatform.macOS), 44);
      expect(machvonMinimumTouchTarget(TargetPlatform.android), 48);
      expect(machvonMinimumTouchTarget(TargetPlatform.fuchsia), 48);
      expect(machvonMinimumTouchTarget(TargetPlatform.linux), 48);
      expect(machvonMinimumTouchTarget(TargetPlatform.windows), 48);
    });

    test('gives buttons the minimum touch target of the platform', () {
      final ThemeData ios = machvonTheme(platform: TargetPlatform.iOS);
      final ThemeData android = machvonTheme(platform: TargetPlatform.android);
      expect(ios.elevatedButtonTheme.style!.minimumSize!.resolve(<WidgetState>{}), const Size(44, 44));
      expect(android.elevatedButtonTheme.style!.minimumSize!.resolve(<WidgetState>{}), const Size(48, 48));
      expect(android.textButtonTheme.style!.minimumSize!.resolve(<WidgetState>{}), const Size(48, 48));
      expect(android.materialTapTargetSize, MaterialTapTargetSize.padded);
    });

    test('passes the same contrast pairs as the web', () {
      expect(kMinTextContrast, 4.5);
      expect(kContrastPairs, hasLength(6));
      for (final ContrastPairSpec pair in kContrastPairs) {
        final double ratio = contrastRatio(kBaseTenantTheme[pair.foreground]!, kBaseTenantTheme[pair.background]!);
        expect(ratio, greaterThanOrEqualTo(kMinTextContrast), reason: pair.id);
      }
    });

    test('has exactly the twelve tenant theme colours the web has', () {
      expect(kThemeColorKeys, hasLength(12));
      expect(kBaseTenantTheme.keys.toSet(), kThemeColorKeys.toSet());
      expect(kBaseTenantTheme['primary'], MachvonColors.primary);
    });
  });
}
