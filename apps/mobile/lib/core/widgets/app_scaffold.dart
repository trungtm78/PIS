import 'package:flutter/material.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../theme/colors.dart';
import '../theme/typography.dart';

/// The slim bar at the top of a screen (design B): a back button when there is somewhere to go back to, a small title or the code of
/// what is open, and the actions at the end. Every control is 48 by 48. On the command band of a leader home it is drawn on the dark
/// header ([onHeader]).
class AppTopBar extends StatelessWidget {
  const AppTopBar({this.title, this.actions = const <Widget>[], this.showBack, this.onHeader = false, super.key});

  /// What is open: a project code, the name of a section. Null on a root screen, whose large title says it.
  final String? title;

  /// Icon buttons at the end; each must be at least 48 by 48 (use [AppBarAction]).
  final List<Widget> actions;

  /// Null shows the back button exactly when the navigator can pop.
  final bool? showBack;

  /// Drawn on the dark header: light icons and text.
  final bool onHeader;

  @override
  Widget build(BuildContext context) {
    final MachvonV2 v2 = context.v2;
    final Color color = onHeader ? v2.palette.onHeader : v2.palette.ink;
    final bool back = showBack ?? (ModalRoute.of(context)?.canPop ?? false);
    return ConstrainedBox(
      constraints: const BoxConstraints(minHeight: 48),
      child: Row(
        children: <Widget>[
          if (back)
            SizedBox(
              width: 48,
              height: 48,
              child: IconButton(
                onPressed: () => Navigator.maybePop(context),
                tooltip: MaterialLocalizations.of(context).backButtonTooltip,
                icon: Icon(Icons.chevron_left, size: 28, color: color),
              ),
            )
          else
            const SizedBox(width: MachvonV2Space.s16),
          if (title != null)
            Expanded(
              child: Semantics(
                container: true,
                header: true,
                child: Text(title!, style: context.v2text.label.copyWith(color: onHeader ? v2.palette.onHeader2 : v2.palette.ink2), maxLines: 1, overflow: TextOverflow.ellipsis),
              ),
            )
          else
            const Spacer(),
          ...actions,
        ],
      ),
    );
  }
}

/// An icon button of the top bar: 48 by 48 with a name for a screen reader (an icon alone has none).
class AppBarAction extends StatelessWidget {
  const AppBarAction({required this.icon, required this.label, required this.onPressed, this.onHeader = false, super.key});

  final IconData icon;

  /// What it does, for a screen reader and the long press.
  final String label;
  final VoidCallback? onPressed;
  final bool onHeader;

  @override
  Widget build(BuildContext context) {
    final MachvonV2 v2 = context.v2;
    return SizedBox(
      width: 48,
      height: 48,
      child: IconButton(onPressed: onPressed, tooltip: label, icon: Icon(icon, size: 24, color: onHeader ? v2.palette.onHeader : v2.palette.ink)),
    );
  }
}

/// The large title of a root screen (Display, 32/40) with an optional line under it. The title stops growing at 1.3 times the system text
/// scale, so it never takes the screen at 200 percent; it is a heading for a screen reader.
class LargeTitleHeader extends StatelessWidget {
  const LargeTitleHeader({required this.title, this.subtitle, this.onHeader = false, super.key});

  final String title;
  final String? subtitle;
  final bool onHeader;

  @override
  Widget build(BuildContext context) {
    final MachvonV2 v2 = context.v2;
    final MachvonV2Text text = context.v2text;
    return Padding(
      padding: const EdgeInsets.fromLTRB(MachvonV2Space.s16, 0, MachvonV2Space.s16, MachvonV2Space.s8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          // A node of its own: without it the heading flag and the line under it merge into one heading (UAT 2026-11-13).
          Semantics(
            container: true,
            header: true,
            child: Text(
              title,
              style: text.display.copyWith(color: onHeader ? v2.palette.onHeader : v2.palette.ink),
              textScaler: cappedScaler(context, MachvonV2Type.displayScaleCap),
            ),
          ),
          if (subtitle != null)
            Padding(
              padding: const EdgeInsets.only(top: 2),
              child: Semantics(container: true, child: Text(subtitle!, style: text.caption.copyWith(color: onHeader ? v2.palette.onHeader2 : v2.palette.ink2))),
            ),
        ],
      ),
    );
  }
}

/// The frame of a screen: the top bar, the large title of a root screen, an optional line of context, the body, and at the bottom an
/// action bar. The only place a screen of `lib/features` gets its `Scaffold` from (`test/static/design_rules_test.dart`).
class AppScaffold extends StatelessWidget {
  const AppScaffold({
    required this.body,
    this.title,
    this.largeTitle,
    this.subtitle,
    this.actions = const <Widget>[],
    this.contextLine,
    this.bottomBar,
    this.floatingAction,
    this.showBack,
    this.safeTop = true,
    this.showTopBar = true,
    super.key,
  });

  final Widget body;

  /// The small title of a child screen.
  final String? title;

  /// The large title of a root screen (and its [subtitle]).
  final String? largeTitle;
  final String? subtitle;
  final List<Widget> actions;

  /// The line of context under the titles (see `ContextLine`).
  final Widget? contextLine;

  /// The sticky bottom bar (see `ActionBar`).
  final Widget? bottomBar;

  /// The floating button (see `FloatingReportButton`).
  final Widget? floatingAction;
  final bool? showBack;

  /// Whether to keep clear of the system status bar; false inside the shell, which does it once for every tab.
  final bool safeTop;

  /// Whether to draw the slim top bar and the large title. A screen whose body brings its own top (the command band of a leader home) turns
  /// them off.
  final bool showTopBar;

  @override
  Widget build(BuildContext context) {
    final MachvonV2 v2 = context.v2;
    return Scaffold(
      backgroundColor: v2.palette.surface,
      body: SafeArea(
        top: safeTop,
        bottom: false,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            if (showTopBar) AppTopBar(title: title, actions: actions, showBack: showBack),
            if (showTopBar && largeTitle != null) LargeTitleHeader(title: largeTitle!, subtitle: subtitle),
            ?contextLine,
            Expanded(child: body),
          ],
        ),
      ),
      floatingActionButton: floatingAction,
      bottomNavigationBar: bottomBar,
    );
  }
}
