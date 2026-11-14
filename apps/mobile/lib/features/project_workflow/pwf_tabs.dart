import 'package:flutter/material.dart';

import '../../core/widgets/underline_tabs.dart';

/// One tab of a workflow screen: its name, the number it counts (left out when zero) and the short groups it shows.
class PwfTab {
  const PwfTab({required this.label, required this.children, this.count});

  final String label;
  final int? count;
  final List<Widget> children;
}

/// A screen of the workflow in tabs, one purpose a tab, so that a person reads a few short groups instead of one long list. The tabs sit in the list they belong to
/// (the head of the screen stays above them) and the chosen tab shows its groups under the row; the tab is kept while the screen is open and through a refresh.
class PwfTabs extends StatefulWidget {
  const PwfTabs({required this.tabs, this.initial = 0, super.key});

  final List<PwfTab> tabs;
  final int initial;

  @override
  State<PwfTabs> createState() => _PwfTabsState();
}

class _PwfTabsState extends State<PwfTabs> {
  late int _index = widget.initial;

  @override
  Widget build(BuildContext context) {
    final int index = _index < widget.tabs.length ? _index : 0;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        UnderlineTabs(
          tabs: <TabOption>[for (final PwfTab tab in widget.tabs) TabOption(label: tab.label, count: tab.count == null || tab.count == 0 ? null : tab.count)],
          index: index,
          onChanged: (int next) => setState(() => _index = next),
        ),
        ...widget.tabs[index].children,
      ],
    );
  }
}
