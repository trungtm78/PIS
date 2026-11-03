import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/l10n/string_table.dart';
import 'package:machvon_mobile/features/personal_bi/bi_query_service.dart';
import 'package:machvon_mobile/features/personal_bi/personal_bi_labels.dart';
import 'package:machvon_mobile/features/personal_bi/personal_bi_strings.dart';
import 'package:machvon_mobile/features/personal_bi/query_models.dart';

import '../../support/widget_host.dart';

Future<BuildContext> _context(WidgetTester tester, Locale locale) async {
  late BuildContext captured;
  await tester.pumpWidget(hostWidget(Builder(builder: (BuildContext context) {
    captured = context;
    return const SizedBox();
  }), locale: locale, tables: <StringTable>[personalBiStrings]));
  return captured;
}

void _allWords(List<String> words) {
  for (final String word in words) {
    expect(word, isNotEmpty);
    expect(word.startsWith('mob.'), isFalse, reason: 'a key shows where words should: $word');
  }
  expect(words.toSet(), hasLength(words.length), reason: 'two different cases read the same');
}

void main() {
  for (final Locale locale in const <Locale>[Locale('vi'), Locale('en')]) {
    testWidgets('AC-ST-MOB-027-1 AC-ST-MOB-027-4 UI-MOB-40 every badge, dimension, refusal and drill check is in words (${locale.languageCode})', (WidgetTester tester) async {
      final BuildContext context = await _context(tester, locale);
      _allWords(<String>[for (final QualityBadge b in QualityBadge.values) badgeLabel(context, b)]);
      _allWords(<String>[for (final String d in drillDimensions) dimensionLabel(context, d)]);
      expect(dimensionLabel(context, 'region'), 'region', reason: 'a dimension the application does not know is shown by its code');
      _allWords(<String>[for (final QueryProblem p in QueryProblem.values) queryProblemText(context, p)]);
      _allWords(<String>[for (final DrillCheck c in DrillCheck.values) drillCheckText(context, c, cell: '1', total: '2')]);
      expect(drillCheckText(context, DrillCheck.differs, cell: '300', total: '250'), allOf(contains('300'), contains('250')));
    });
  }
}
