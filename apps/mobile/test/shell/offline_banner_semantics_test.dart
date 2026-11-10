import 'package:flutter/semantics.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/connectivity/reachability.dart';

import '../support/harness.dart';
import '../support/list_feature.dart';

// Every route sits on a modal barrier, and a barrier blocks the semantics painted before it. The banners above the tabs were painted
// before the navigator, so on a tab whose screen has no boundary of its own they were drawn but missing from the semantics tree: a
// screen reader (and a Maestro `assertVisible`) never met "you are offline".
const String _offline = 'Bạn đang ngoại tuyến';

void main() {
  const List<String> locations = <String>['/home', '/projects', '/projects/mob-10/p3', '/approval', '/inbox', '/account'];
  for (final String location in locations) {
    testWidgets('UI-MOB-52 the offline banner is a live region in the semantics tree on $location', (WidgetTester tester) async {
      final SemanticsHandle semantics = tester.ensureSemantics();
      useDevice(tester, kDeviceSizes[1]);
      final container = await pumpApp(tester, features: const [listFeature], location: location);
      expect(find.bySemanticsLabel(RegExp(_offline)), findsNothing);

      container.read(reachabilityProvider.notifier).report(Reachability.offline);
      await tester.pumpAndSettle();

      expect(find.bySemanticsLabel(RegExp(_offline)), findsOneWidget, reason: 'the banner is in the semantics tree');
      final SemanticsNode node = tester.getSemantics(find.bySemanticsLabel(RegExp(_offline)));
      expect(node.getSemanticsData().flagsCollection.isLiveRegion, isTrue);
      expect(node.label, contains('Phê duyệt cần kết nối'));

      container.read(reachabilityProvider.notifier).report(Reachability.online);
      await tester.pumpAndSettle();
      expect(find.bySemanticsLabel(RegExp(_offline)), findsNothing);
      semantics.dispose();
    });
  }
}
