import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/api/dart_io_transport.dart';
import 'package:machvon_mobile/core/connectivity/reachability.dart';
import 'package:machvon_mobile/core/di/providers.dart';
import 'package:machvon_mobile/core/l10n/app_strings.dart';
import 'package:machvon_mobile/core/l10n/core_strings.dart';
import 'package:machvon_mobile/core/l10n/string_table.dart';
import 'package:machvon_mobile/core/session/session.dart';
import 'package:machvon_mobile/core/theme/app_theme.dart';
import 'package:machvon_mobile/features/procurement_workflow/procurement_workflow_strings.dart';
import 'package:machvon_mobile/features/read_support/clock.dart';
import 'package:machvon_mobile/features/read_support/read_support_strings.dart';

import '../../support/harness.dart';
import '../support/scripted_server.dart';

/// Opens one screen of the feature on a scripted server, the way the application hosts it (theme, both languages, the strings of the core,
/// of the read support and of the feature, a signed-in session), without the router: the screens take their navigation as a parameter.
Future<ProviderContainer> openPrcScreen(WidgetTester tester, ScriptedServer server, Widget screen, {Locale locale = const Locale('vi'), DateTime Function()? now, FakeSession? session}) async {
  final ProviderContainer container = ProviderContainer(
    overrides: <Override>[
      appConfigProvider.overrideWithValue(testConfig),
      sessionProvider.overrideWith(() => session ?? FakeSession()),
      httpTransportProvider.overrideWith((Ref ref) => ObservingTransport(server, ref.read(reachabilityProvider.notifier).report)),
      clockProvider.overrideWithValue(now ?? () => kNow),
    ],
  );
  addTearDown(container.dispose);
  await tester.pumpWidget(
    UncontrolledProviderScope(
      key: UniqueKey(),
      container: container,
      child: MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: buildAppTheme(),
        locale: locale,
        supportedLocales: const <Locale>[Locale('vi'), Locale('en')],
        localizationsDelegates: <LocalizationsDelegate<Object?>>[
          AppStringsDelegate(StringCatalogue(<StringTable>[kCoreStrings, readSupportStrings, procurementWorkflowStrings])),
          GlobalMaterialLocalizations.delegate,
          GlobalWidgetsLocalizations.delegate,
          GlobalCupertinoLocalizations.delegate,
        ],
        home: screen,
      ),
    ),
  );
  await tester.pumpAndSettle();
  return container;
}

