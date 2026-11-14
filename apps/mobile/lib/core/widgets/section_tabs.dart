import 'package:flutter/material.dart';

import 'underline_tabs.dart';

/// One tab of [SectionTabs]: its name, the number it counts (left out when zero) and the short groups it shows.
class SectionTab {
  const SectionTab({required this.label, required this.children, this.count});

  final String label;
  final int? count;
  final List<Widget> children;
}

/// A detail screen in tabs, one purpose a tab, so that a person reads a few short groups instead of one long list. The tabs sit in the list they
/// belong to (the head of the screen stays above them) and the chosen tab shows its groups under the row; the tab is kept while the screen is open
/// and through a refresh of its data.
class SectionTabs extends StatefulWidget {
  const SectionTabs({required this.tabs, this.initial = 0, super.key});

  final List<SectionTab> tabs;
  final int initial;

  @override
  State<SectionTabs> createState() => _SectionTabsState();
}

class _SectionTabsState extends State<SectionTabs> {
  late int _index = widget.initial;

  @override
  Widget build(BuildContext context) {
    final int index = _index < widget.tabs.length ? _index : 0;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        UnderlineTabs(
          tabs: <TabOption>[for (final SectionTab tab in widget.tabs) TabOption(label: tab.label, count: tab.count == null || tab.count == 0 ? null : tab.count)],
          index: index,
          onChanged: (int next) => setState(() => _index = next),
        ),
        ...widget.tabs[index].children,
      ],
    );
  }
}
