import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

void main() {
  group('mobile.v2 tokens', () {
    const List<MachvonV2Palette> palettes = <MachvonV2Palette>[MachvonV2Colors.light, MachvonV2Colors.dark];

    test('the web token values are the ones of before: primary, background and the 28 point title', () {
      expect(MachvonColors.primary, const Color(0xFF007D77));
      expect(MachvonColors.background, const Color(0xFFF3F6F5));
      expect(MachvonFont.title, 28);
      expect(MachvonSpace.space20, 20);
    });

    test('every text pair of both modes reaches 4.5:1 and the band text on its fill 6.4:1', () {
      for (final MachvonV2Palette p in palettes) {
        for (final (Color, Color) pair in <(Color, Color)>[
          (p.ink, p.bg), (p.ink, p.surface), (p.ink2, p.bg), (p.ink2, p.surface), (p.ink3, p.surface), (p.onHeader, p.header),
          (p.onPrimary, p.primary), (p.primaryStrong, p.primarySoft), (p.infoFg, p.infoBg),
        ]) {
          expect(contrastRatio(pair.$1, pair.$2), greaterThanOrEqualTo(4.5));
        }
        for (final (Color, Color) pair in <(Color, Color)>[(p.lateFg, p.lateBg), (p.soonFg, p.soonBg), (p.okFg, p.okBg)]) {
          expect(contrastRatio(pair.$1, pair.$2), greaterThanOrEqualTo(6.4));
        }
        for (final Color mark in <Color>[p.lateMark, p.soonMark, p.okMark, p.outline]) {
          expect(contrastRatio(mark, p.surface), greaterThanOrEqualTo(3));
        }
      }
    });

    test('the type scale has six steps from 32 down to 12 with line heights of at least 1.25', () {
      const List<MachvonV2TypeStep> steps = <MachvonV2TypeStep>[
        MachvonV2Type.display, MachvonV2Type.title, MachvonV2Type.heading, MachvonV2Type.body, MachvonV2Type.label, MachvonV2Type.caption,
      ];
      expect(steps.map((MachvonV2TypeStep s) => s.size), <double>[32, 22, 16, 15, 13, 12]);
      for (final MachvonV2TypeStep s in steps) {
        expect(s.height, greaterThanOrEqualTo(1.25));
        expect(s.weight == FontWeight.w400 || s.weight == FontWeight.w600, isTrue);
      }
      expect(MachvonV2Type.displayScaleCap, 1.3);
      expect(MachvonV2Type.clampFreeFrom, 1.5);
    });

    test('spacing, radii, sizes, motion and elevation', () {
      expect(<double>[MachvonV2Space.s4, MachvonV2Space.s8, MachvonV2Space.s12, MachvonV2Space.s16, MachvonV2Space.s24, MachvonV2Space.s32], <double>[4, 8, 12, 16, 24, 32]);
      expect(MachvonV2Radius.sheet, 20);
      expect(MachvonV2Size.touchMin, 44);
      expect(MachvonV2Size.navBarHeight, 64);
      expect(MachvonV2Motion.fast, const Duration(milliseconds: 150));
      expect(MachvonV2Elevation.e2Light.single.offset, const Offset(0, -8));
      expect(MachvonV2Elevation.e1Dark.single.spreadRadius, 1);
    });
  });
}
