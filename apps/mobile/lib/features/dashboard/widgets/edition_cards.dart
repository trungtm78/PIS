import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/di/providers.dart';

/// The cards the edition of this build adds to the home screens (the enterprise period, HPM and EBS status). The public edition has none, so
/// this draws nothing there. Each card reads for itself and never takes the home screen down with it.
class EditionHomeCards extends ConsumerWidget {
  const EditionHomeCards({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final List<WidgetBuilder> cards = ref.watch(editionProfileProvider).homeCards;
    if (cards.isEmpty) return const SizedBox.shrink();
    return Column(children: <Widget>[for (final WidgetBuilder card in cards) Builder(builder: card)]);
  }
}
