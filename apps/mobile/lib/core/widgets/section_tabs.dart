import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';

import '../theme/colors.dart';
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
///
/// The row of tabs STICKS to the top of the list that scrolls it: once the head of the screen has scrolled away the row stays in sight over the
/// groups, so another tab is one tap away and nobody scrolls back up to change it. It never leaves the block of its own tabs: when the last group
/// scrolls out, the row goes with it.
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
    return PinnedHeader(
      // An opaque surface: the groups scroll under the row once it is pinned.
      header: ColoredBox(
        color: context.v2.palette.bg,
        child: UnderlineTabs(
          tabs: <TabOption>[for (final SectionTab tab in widget.tabs) TabOption(label: tab.label, count: tab.count == null || tab.count == 0 ? null : tab.count)],
          index: index,
          onChanged: (int next) => setState(() => _index = next),
        ),
      ),
      body: Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: widget.tabs[index].children),
    );
  }
}

/// A header over a body, in a list that scrolls: the header is laid out above the body and, while the body is on screen, is drawn at the top of
/// the viewport instead of scrolling away with it (at most down to the end of the body). Outside a scrolling list it is a plain column of the two.
/// The header is drawn, hit and read by a screen reader at the place it is seen.
class PinnedHeader extends StatelessWidget {
  const PinnedHeader({required this.header, required this.body, super.key});

  final Widget header;
  final Widget body;

  @override
  Widget build(BuildContext context) => _PinnedHeaderLayout(position: Scrollable.maybeOf(context)?.position, children: <Widget>[body, header]);
}

class _PinnedHeaderLayout extends MultiChildRenderObjectWidget {
  const _PinnedHeaderLayout({required this.position, required super.children});

  final ScrollPosition? position;

  @override
  RenderObject createRenderObject(BuildContext context) => _RenderPinnedHeader(position);

  @override
  void updateRenderObject(BuildContext context, _RenderPinnedHeader renderObject) => renderObject.position = position;
}

class _PinnedParentData extends ContainerBoxParentData<RenderBox> {}

/// Two children: the body (first, drawn first) and the header (last, drawn over it).
class _RenderPinnedHeader extends RenderBox with ContainerRenderObjectMixin<RenderBox, _PinnedParentData>, RenderBoxContainerDefaultsMixin<RenderBox, _PinnedParentData> {
  _RenderPinnedHeader(this._position);

  ScrollPosition? _position;
  set position(ScrollPosition? value) {
    if (identical(value, _position)) return;
    if (attached) _position?.removeListener(markNeedsPaint);
    _position = value;
    if (attached) _position?.addListener(markNeedsPaint);
    markNeedsPaint();
  }

  RenderBox get _body => firstChild!;
  RenderBox get _header => lastChild!;

  @override
  void setupParentData(RenderBox child) {
    if (child.parentData is! _PinnedParentData) child.parentData = _PinnedParentData();
  }

  @override
  void attach(PipelineOwner owner) {
    super.attach(owner);
    _position?.addListener(markNeedsPaint);
  }

  @override
  void detach() {
    _position?.removeListener(markNeedsPaint);
    super.detach();
  }

  @override
  double computeMinIntrinsicWidth(double height) => _body.getMinIntrinsicWidth(height);

  @override
  double computeMaxIntrinsicWidth(double height) => _body.getMaxIntrinsicWidth(height);

  @override
  double computeMinIntrinsicHeight(double width) => _header.getMinIntrinsicHeight(width) + _body.getMinIntrinsicHeight(width);

  @override
  double computeMaxIntrinsicHeight(double width) => _header.getMaxIntrinsicHeight(width) + _body.getMaxIntrinsicHeight(width);

  @override
  Size computeDryLayout(BoxConstraints constraints) {
    final BoxConstraints inner = constraints.loosen().copyWith(minWidth: constraints.hasBoundedWidth ? constraints.maxWidth : 0, maxHeight: double.infinity);
    final Size header = _header.getDryLayout(inner);
    final Size body = _body.getDryLayout(inner);
    return constraints.constrain(Size(constraints.hasBoundedWidth ? constraints.maxWidth : (header.width > body.width ? header.width : body.width), header.height + body.height));
  }

  @override
  void performLayout() {
    final BoxConstraints inner = constraints.loosen().copyWith(minWidth: constraints.hasBoundedWidth ? constraints.maxWidth : 0, maxHeight: double.infinity);
    _header.layout(inner, parentUsesSize: true);
    _body.layout(inner, parentUsesSize: true);
    (_body.parentData! as _PinnedParentData).offset = Offset(0, _header.size.height);
    (_header.parentData! as _PinnedParentData).offset = Offset.zero;
    final double width = constraints.hasBoundedWidth ? constraints.maxWidth : (_header.size.width > _body.size.width ? _header.size.width : _body.size.width);
    size = constraints.constrain(Size(width, _header.size.height + _body.size.height));
  }

  /// How far down from its own place the header is drawn: the distance its place has scrolled above the top of the viewport, never past the end of the body.
  double get _shift {
    if (_position == null || !attached) return 0;
    final RenderAbstractViewport? viewport = RenderAbstractViewport.maybeOf(this);
    if (viewport is! RenderBox) return 0;
    final double top = localToGlobal(Offset.zero, ancestor: viewport).dy;
    if (top >= 0) return 0;
    final double room = size.height - _header.size.height;
    return (-top).clamp(0.0, room < 0 ? 0.0 : room);
  }

  @override
  void paint(PaintingContext context, Offset offset) {
    context.paintChild(_body, offset + (_body.parentData! as _PinnedParentData).offset);
    context.paintChild(_header, offset + Offset(0, _shift));
  }

  @override
  void applyPaintTransform(RenderBox child, Matrix4 transform) {
    if (identical(child, _header)) {
      transform.translateByDouble(0, _shift, 0, 1);
    } else {
      super.applyPaintTransform(child, transform);
    }
  }

  @override
  bool hitTestChildren(BoxHitTestResult result, {required Offset position}) {
    final Offset shift = Offset(0, _shift);
    final bool onHeader = result.addWithPaintOffset(
      offset: shift,
      position: position,
      hitTest: (BoxHitTestResult inner, Offset local) => _header.hitTest(inner, position: local),
    );
    if (onHeader) return true;
    final Offset bodyOffset = (_body.parentData! as _PinnedParentData).offset;
    return result.addWithPaintOffset(
      offset: bodyOffset,
      position: position,
      hitTest: (BoxHitTestResult inner, Offset local) => _body.hitTest(inner, position: local),
    );
  }
}
