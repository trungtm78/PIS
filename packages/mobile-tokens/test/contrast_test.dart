import 'dart:convert';
import 'dart:io';

import 'package:flutter/painting.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

/// The vectors are written by the TypeScript implementation of the web (packages/design-tokens).
const String _vectorsPath = '../design-tokens/test/vectors/contrast-vectors.json';

Map<String, dynamic> _vectors() {
  return jsonDecode(File(_vectorsPath).readAsStringSync()) as Map<String, dynamic>;
}

Color _color(String hex) {
  final Color? parsed = parseHexColor(hex);
  if (parsed == null) {
    throw ArgumentError('vector colour $hex is not hex');
  }
  return parsed;
}

void main() {
  final Map<String, dynamic> vectors = _vectors();

  group('contrastRatio', () {
    test('matches every contrast vector of the TypeScript implementation within 0.01', () {
      final List<dynamic> rows = vectors['contrast'] as List<dynamic>;
      expect(rows.length, greaterThanOrEqualTo(10));
      for (final dynamic row in rows) {
        final Map<String, dynamic> vector = row as Map<String, dynamic>;
        final double ratio = contrastRatio(_color(vector['foreground'] as String), _color(vector['background'] as String));
        expect(ratio, closeTo((vector['ratio'] as num).toDouble(), 0.01), reason: '$vector');
      }
    });

    test('is 21 for black on white and 1 for equal colours, in either order', () {
      expect(contrastRatio(const Color(0xFF000000), const Color(0xFFFFFFFF)), closeTo(21, 0.001));
      expect(contrastRatio(const Color(0xFFFFFFFF), const Color(0xFF000000)), closeTo(21, 0.001));
      expect(contrastRatio(const Color(0xFF123456), const Color(0xFF123456)), 1);
    });
  });

  group('parseHexColor', () {
    test('reads three and six digit hex in any letter case', () {
      expect(parseHexColor('#b4233d'), const Color(0xFFB4233D));
      expect(parseHexColor('#444'), const Color(0xFF444444));
    });

    test('returns null for anything else', () {
      for (final String value in <String>['red', 'rgb(0,0,0)', '#12', '#1234567', '', 'B4233D']) {
        expect(parseHexColor(value), isNull, reason: value);
      }
    });
  });

  group('overlayAccepted', () {
    test('gives the verdict and the finding codes of the TypeScript validator for every overlay vector', () {
      final List<dynamic> rows = vectors['overlays'] as List<dynamic>;
      expect(rows.length, greaterThanOrEqualTo(12));
      for (final dynamic row in rows) {
        final Map<String, dynamic> vector = row as Map<String, dynamic>;
        final Map<String, String> overlay = (vector['overlay'] as Map<String, dynamic>).map(
          (String key, dynamic value) => MapEntry<String, String>(key, value as String),
        );
        expect(overlayAccepted(overlay), vector['accepted'], reason: vector['name'] as String);
        expect(overlayFindingCodes(overlay), (vector['codes'] as List<dynamic>).cast<String>(), reason: vector['name'] as String);
      }
    });

    test('rejects the 3.2:1 theme and accepts 4.5:1 or better', () {
      expect(overlayAccepted(<String, String>{'menu': '#FFFFFF', 'menuText': '#909090'}), isFalse);
      expect(overlayAccepted(<String, String>{'menu': '#FFFFFF', 'menuText': '#777777'}), isFalse);
      expect(overlayAccepted(<String, String>{'menu': '#FFFFFF', 'menuText': '#767676'}), isTrue);
    });

    test('rejects url, javascript and named colours', () {
      expect(overlayFindingCodes(<String, String>{'primary': 'url(https://example.com/x.png)'}), <String>[kFindingForbiddenValue]);
      expect(overlayFindingCodes(<String, String>{'primary': 'javascript:alert(1)'}), <String>[kFindingForbiddenValue]);
      expect(overlayFindingCodes(<String, String>{'primary': 'red'}), <String>[kFindingBadColor]);
    });

    test('accepts the empty overlay and a logo asset id, and refuses a logo URL and an unknown token', () {
      expect(overlayAccepted(<String, String>{}), isTrue);
      expect(overlayAccepted(<String, String>{kLogoAssetKey: '123e4567-e89b-42d3-a456-426614174000'}), isTrue);
      expect(overlayFindingCodes(<String, String>{kLogoAssetKey: 'https://example.com/logo.png'}), <String>[kFindingLogo]);
      expect(overlayFindingCodes(<String, String>{'sidebarWidth': '#FFFFFF'}), <String>[kFindingUnknownToken]);
    });
  });
}
