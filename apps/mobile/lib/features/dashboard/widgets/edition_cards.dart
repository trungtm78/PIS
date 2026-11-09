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

/// The head of the home screens of the edition: the product and the organisation the person is signed in to. The public edition has none,
/// so this draws nothing there.
class EditionHomeHeader extends ConsumerWidget {
  const EditionHomeHeader({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final WidgetBuilder? header = ref.watch(editionProfileProvider).homeHeader;
    if (header == null) return const SizedBox.shrink();
    return Builder(builder: header);
  }
}
