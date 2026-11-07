import 'package:flutter/widgets.dart';

import '../read_support/navigate.dart';

/// The screen ids of the feature (the phone screens of PRC-1, Projects tab).
const String kPrcListScreenId = 'MOB-69';
const String kPrcDetailScreenId = 'MOB-70';
const String kPrcTreeScreenId = 'MOB-71';

/// Where a tap goes. The screens take it as a parameter so that a test (or a host without a router) can say what a tap does; the default opens
/// the screen of the catalogue by its id, pushed on top so the back button returns to where the person was.
final class PrcNavigator {
  const PrcNavigator({this.openPackage = _openPackage, this.openNode = _openNode, this.openTree = _openTree});

  final void Function(BuildContext context, String packageId) openPackage;
  final void Function(BuildContext context, String nodeId) openNode;
  final void Function(BuildContext context) openTree;
}

void _openPackage(BuildContext context, String packageId) => openScreen(context, kPrcDetailScreenId, pathSuffix: '/${Uri.encodeComponent(packageId)}', stacked: true);

void _openNode(BuildContext context, String nodeId) => openScreen(context, kPrcListScreenId, query: <String, String>{'node': nodeId}, stacked: true);

void _openTree(BuildContext context) => openScreen(context, kPrcTreeScreenId, stacked: true);
