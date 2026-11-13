import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../support/harness.dart';
import '../support/screen_contract.dart';
import '../support/scripted_server.dart';

/// The screen contract for a screen that has data on it: no layout exception at the three devices and at 200 percent text, every tap target at
/// least 44 by 44 (the touch minimum of the phone design, and the 44 pt of iOS), every control named, and the text readable.
///
/// The Android guideline of 48 dp is kept for the screens without their record (`test/hardening/accessibility_sweep_test.dart` opens MOB-78 to MOB-82
/// that way on both platforms): the shared filter chip and the action of a status strip are 44 high by design (`MachvonV2Size.touchMin`), so a screen
/// with chips or a strip action cannot meet 48 until those two shared widgets do, and that is not a thing a screen of a feature changes.
Future<void> expectScreenContractWithData(WidgetTester tester, {required OpenScreen open, required void Function(ScriptedServer server) healthy}) async {
  const MinimumTapTargetGuideline touchMinimum = MinimumTapTargetGuideline(size: Size(44, 44), link: 'the touch minimum of the phone design');
  for (final Size size in kDeviceSizes) {
    for (final double scale in <double>[1.0, 2.0]) {
      useDevice(tester, size, textScale: scale);
      final SemanticsHandle semantics = tester.ensureSemantics();
      final ScriptedServer server = ScriptedServer();
      healthy(server);
      await open(tester, server);
      final String where = '${size.width.toInt()}x${size.height.toInt()} at $scale';
      expect(tester.takeException(), isNull, reason: where);
      await expectLater(tester, meetsGuideline(touchMinimum), reason: where);
      await expectLater(tester, meetsGuideline(labeledTapTargetGuideline), reason: where);
      await expectLater(tester, meetsGuideline(textContrastGuideline), reason: where);
      semantics.dispose();
    }
  }
}
