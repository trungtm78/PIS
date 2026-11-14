import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/state/state_card.dart';

import '../../support/harness.dart';
import 'scripted_server.dart';

/// A phone as tall as the longest screen, so that a list built lazily is built whole and a test can read all of it.
const Size kTallDevice = Size(390, 2600);

/// Opens the screen under test on a server (the harness starts the application on it).
typedef OpenScreen = Future<void> Function(WidgetTester tester, ScriptedServer server);

/// What the contract of a screen needs to be driven: how the server answers when all is well, what the screen shows then,
/// and (when the screen has an empty state) how the server answers when there is nothing.
class StateScript {
  const StateScript({required this.healthy, required this.content, this.empty});

  final void Function(ScriptedServer server) healthy;
  final Finder content;
  final void Function(ScriptedServer server)? empty;
}

/// The states every screen of the application draws (UI contract, `docs/mobile-foundation.md`): the content, loading,
/// empty, error, denied, expired licence, ended session and no connection. Each is driven through the server, as a user
/// meets it, and each shows its own words and its stable error code.
Future<void> expectEveryState(WidgetTester tester, {required OpenScreen open, required StateScript script}) async {
  useDevice(tester, kDeviceSizes[1]);

  ScriptedServer server = ScriptedServer();
  script.healthy(server);
  await open(tester, server);
  expect(script.content, findsWidgets, reason: 'default state');
  expect(tester.takeException(), isNull);

  final Completer<void> never = Completer<void>();
  server = ScriptedServer()..answerAll((_) async {
        await never.future;
        throw StateError('never answered');
      });
  await open(tester, server);
  expect(find.byType(LoadingView), findsOneWidget, reason: 'loading state');
  never.complete();
  await tester.pumpAndSettle();

  final void Function(ScriptedServer)? empty = script.empty;
  if (empty != null) {
    server = ScriptedServer();
    script.healthy(server);
    empty(server);
    await open(tester, server);
    expect(find.text('Chưa có dữ liệu'), findsOneWidget, reason: 'empty state');
  }

  final List<({String name, int status, String code, String title})> refusals = <({String name, int status, String code, String title})>[
    (name: 'error', status: 500, code: 'INTERNAL_ERROR', title: 'Chưa thể tải dữ liệu'),
    (name: 'denied', status: 403, code: 'SCOPE_DENIED', title: 'Bạn chưa có quyền truy cập'),
    (name: 'expired licence', status: 403, code: 'LICENSE_EXPIRED', title: 'License đã hết hạn'),
    (name: 'ended session', status: 401, code: 'SESSION_EXPIRED', title: 'Phiên làm việc đã hết hạn'),
  ];
  for (final ({String name, int status, String code, String title}) refusal in refusals) {
    server = ScriptedServer()..refuseAll(refusal.status, refusal.code);
    await open(tester, server);
    expect(find.text(refusal.title), findsOneWidget, reason: refusal.name);
    expect(find.text(refusal.code), findsOneWidget, reason: '${refusal.name}: the stable code is shown');
  }

  server = ScriptedServer()..offline = true;
  await open(tester, server);
  expect(find.text('Bạn đang ngoại tuyến'), findsWidgets, reason: 'offline state');
  expect(find.text('NETWORK_ERROR'), findsOneWidget);
  expect(tester.takeException(), isNull);
}

/// The screen contract checks: no layout exception at the three devices and at 200 percent text, every tap target large
/// enough on both platforms and labelled, and the text readable.
///
/// [contrastOnWholeScreen]: the contrast is read on the screen laid out three device heights tall, so that no line of text is cut by the bottom edge. The
/// guideline reads the pixels of what is visible of a text: a heading of which only the top few pixels show above the bar of actions has no ink in them and
/// reads as "no contrast", which says nothing of its colours. A screen whose fold happens to cut a line of text asks for this.
Future<void> expectScreenContract(WidgetTester tester, {required OpenScreen open, required void Function(ScriptedServer server) healthy, bool contrastOnWholeScreen = false}) async {
  for (final Size size in kDeviceSizes) {
    for (final double scale in <double>[1.0, 2.0]) {
      useDevice(tester, size, textScale: scale);
      final SemanticsHandle semantics = tester.ensureSemantics();
      final ScriptedServer server = ScriptedServer();
      healthy(server);
      await open(tester, server);
      final String where = '${size.width.toInt()}x${size.height.toInt()} at $scale';
      expect(tester.takeException(), isNull, reason: where);
      try {
        debugDefaultTargetPlatformOverride = TargetPlatform.android;
        await expectLater(tester, meetsGuideline(androidTapTargetGuideline), reason: where);
        debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
        await expectLater(tester, meetsGuideline(iOSTapTargetGuideline), reason: where);
      } finally {
        debugDefaultTargetPlatformOverride = null;
      }
      await expectLater(tester, meetsGuideline(labeledTapTargetGuideline), reason: where);
      if (contrastOnWholeScreen) {
        useDevice(tester, Size(size.width, size.height * 3), textScale: scale);
        final ScriptedServer whole = ScriptedServer();
        healthy(whole);
        await open(tester, whole);
      }
      await expectLater(tester, meetsGuideline(textContrastGuideline), reason: where);
      semantics.dispose();
    }
  }
}
