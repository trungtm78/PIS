// Audits a UI hierarchy dump taken on a real Android device for touch areas below 48 dp and for controls with no name
// (AC-ST-MOB-040-1, UAT-NFR-ACCESSIBILITY-02). The host tests of the application check the same two rules on the widget tree; this
// tool applies them to what the device really draws, with its real density and its real font scale.
//
//   adb shell settings put system font_scale 2.0
//   adb shell uiautomator dump /sdcard/screen.xml && adb pull /sdcard/screen.xml
//   adb shell wm density            # "Physical density: 420"
//   dart run tool/device/touch_target_audit.dart screen.xml 420 [more.xml ...]
//
// Exit code 0: every control of every dump is at least 48 dp in both directions and has a name. 1: at least one is not.
// 64: the arguments are wrong. 65: an input is not a whole hierarchy dump (empty, not XML, cut short, no node, or a file that cannot be
// read): nothing was audited there, so it is neither a pass nor a finding, and it is reported even when the other dumps are clean.
import 'dart:io';

/// The smallest touch area, in dp, that Material and WCAG 2.2 (2.5.8, with the Android guideline) accept.
const double kMinimumTouchDp = 48;

/// One control of the dump.
final class UiNode {
  const UiNode({required this.className, required this.left, required this.top, required this.right, required this.bottom, required this.name, required this.resourceId});

  final String className;
  final int left;
  final int top;
  final int right;
  final int bottom;

  /// The text or the content description a screen reader reads; empty when there is none.
  final String name;
  final String resourceId;

  int get widthPx => right - left;
  int get heightPx => bottom - top;
}

/// A rule a control breaks.
final class TouchFinding {
  const TouchFinding({required this.rule, required this.node, required this.widthDp, required this.heightDp});

  /// `TOUCH_TARGET_TOO_SMALL` or `NO_ACCESSIBLE_NAME`.
  final String rule;
  final UiNode node;
  final double widthDp;
  final double heightDp;

  @override
  String toString() =>
      '$rule ${node.className} ${node.resourceId.isEmpty ? '' : '${node.resourceId} '}[${node.left},${node.top}][${node.right},${node.bottom}] ${widthDp.toStringAsFixed(1)}x${heightDp.toStringAsFixed(1)} dp';
}

final RegExp _nodeTag = RegExp(r'<node\b([^>]*?)/?>');
final RegExp _attribute = RegExp(r'([\w:-]+)="([^"]*)"');
final RegExp _bounds = RegExp(r'^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$');

String _unescape(String value) => value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&#10;', '\n')
    .replaceAll('&amp;', '&');

final RegExp _nodeStart = RegExp(r'<node\b');
final RegExp _hierarchyStart = RegExp(r'<hierarchy\b');

/// Throws a [FormatException] unless [xml] is a whole `uiautomator dump`: a hierarchy that is opened and closed and holds at least
/// one node, each of them closed. A capture that failed (empty, an error text, cut short) holds no control, and "no control" must
/// never read as "no finding".
void _requireWholeDump(String xml) {
  final int open = xml.indexOf(_hierarchyStart);
  if (open < 0) throw const FormatException('not a uiautomator hierarchy dump: no <hierarchy> element');
  if (xml.indexOf('</hierarchy>', open) < 0) throw const FormatException('the hierarchy dump is cut short: <hierarchy> is not closed');
  final int started = _nodeStart.allMatches(xml).length;
  if (started == 0) throw const FormatException('the hierarchy dump holds no node');
  if (_nodeTag.allMatches(xml).length != started) throw const FormatException('the hierarchy dump holds a node that is cut short');
}

/// The controls (clickable, long-clickable or checkable) of a `uiautomator dump`, in document order. A dump that is not whole
/// ([FormatException]) and a node with a bounds attribute that cannot be read are errors: a dump that is half understood must not pass.
List<UiNode> parseControls(String xml) {
  _requireWholeDump(xml);
  final List<UiNode> controls = <UiNode>[];
  for (final RegExpMatch tag in _nodeTag.allMatches(xml)) {
    final Map<String, String> attributes = <String, String>{
      for (final RegExpMatch attribute in _attribute.allMatches(tag.group(1)!)) attribute.group(1)!: _unescape(attribute.group(2)!),
    };
    final bool control = attributes['clickable'] == 'true' || attributes['long-clickable'] == 'true' || attributes['checkable'] == 'true';
    if (!control) continue;
    final RegExpMatch? bounds = _bounds.firstMatch(attributes['bounds'] ?? '');
    if (bounds == null) throw FormatException('a control has no readable bounds', tag.group(0));
    final String text = (attributes['text'] ?? '').trim();
    final String description = (attributes['content-desc'] ?? '').trim();
    controls.add(
      UiNode(
        className: attributes['class'] ?? '',
        left: int.parse(bounds.group(1)!),
        top: int.parse(bounds.group(2)!),
        right: int.parse(bounds.group(3)!),
        bottom: int.parse(bounds.group(4)!),
        name: description.isNotEmpty ? description : text,
        resourceId: attributes['resource-id'] ?? '',
      ),
    );
  }
  return controls;
}

/// The findings for [xml] on a screen of [densityDpi] (the "physical density" of `wm density`). A control without area is
/// skipped (it is not on screen).
List<TouchFinding> auditDump(String xml, {required int densityDpi}) {
  if (densityDpi < 100 || densityDpi > 800) throw ArgumentError.value(densityDpi, 'densityDpi', 'is not a plausible screen density');
  final double scale = densityDpi / 160;
  final List<TouchFinding> findings = <TouchFinding>[];
  for (final UiNode node in parseControls(xml)) {
    if (node.widthPx <= 0 || node.heightPx <= 0) continue;
    final double width = node.widthPx / scale;
    final double height = node.heightPx / scale;
    if (width < kMinimumTouchDp || height < kMinimumTouchDp) {
      findings.add(TouchFinding(rule: 'TOUCH_TARGET_TOO_SMALL', node: node, widthDp: width, heightDp: height));
    }
    if (node.name.isEmpty) {
      findings.add(TouchFinding(rule: 'NO_ACCESSIBLE_NAME', node: node, widthDp: width, heightDp: height));
    }
  }
  return findings;
}

/// Runs the audit for the command line and returns the exit code.
int run(List<String> arguments) {
  final int? density = arguments.length >= 2 ? int.tryParse(arguments[1]) : null;
  if (arguments.length < 2 || density == null) {
    stderr.writeln('usage: dart run tool/device/touch_target_audit.dart <dump.xml> <density dpi> [more dumps...]');
    return 64;
  }
  final List<String> files = <String>[arguments[0], ...arguments.skip(2)];
  int total = 0;
  int unusable = 0;
  for (final String file in files) {
    final List<TouchFinding> findings;
    try {
      findings = auditDump(File(file).readAsStringSync(), densityDpi: density);
    } on FormatException catch (error) {
      stdout.writeln('$file: UNUSABLE INPUT: ${error.message}');
      unusable += 1;
      continue;
    } on FileSystemException catch (error) {
      stdout.writeln('$file: UNUSABLE INPUT: ${error.message}');
      unusable += 1;
      continue;
    }
    for (final TouchFinding finding in findings) {
      stdout.writeln('$file: $finding');
    }
    total += findings.length;
  }
  if (unusable > 0) {
    stdout.writeln('UNUSABLE INPUT: $unusable of ${files.length} dump(s) could not be audited, so nothing is certified');
    return 65;
  }
  stdout.writeln(total == 0 ? 'PASS: 0 findings in ${files.length} dump(s)' : 'FAIL: $total finding(s) in ${files.length} dump(s)');
  return total == 0 ? 0 : 1;
}

void main(List<String> arguments) => exit(run(arguments));
