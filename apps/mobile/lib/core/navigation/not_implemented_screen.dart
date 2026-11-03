import 'package:flutter/material.dart';

import '../l10n/app_strings.dart';
import '../state/state_card.dart';
import 'route_catalogue.dart';

/// What a screen of the catalogue shows until a story implements it, so that every route of the table can be opened and
/// every tab has a root from the first day.
class NotImplementedScreen extends StatelessWidget {
  const NotImplementedScreen({required this.route, super.key});

  final MobileRoute route;

  @override
  Widget build(BuildContext context) {
    final String title = context.t('mob.route.pending.title');
    final String body = context.t('mob.route.pending.body', <String, Object>{'screen': route.id});
    return Scaffold(
      body: SafeArea(
        child: StateCard(
          icon: Icons.construction_outlined,
          title: title,
          body: body,
          announcement: '$title. $body',
        ),
      ),
    );
  }
}
