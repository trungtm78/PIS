import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'app/app.dart';
import 'app/bootstrap.dart';
import 'features/release/telemetry.dart';

Future<void> main() async {
  final Stopwatch started = Stopwatch()..start();
  final WidgetsBinding binding = WidgetsFlutterBinding.ensureInitialized();
  final ProviderContainer container = await bootstrap();
  runApp(UncontrolledProviderScope(container: container, child: const MachvonApp()));
  reportColdStartAfterFirstFrame(binding, container.read(telemetryProvider), started);
}
