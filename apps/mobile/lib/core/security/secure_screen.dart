import 'package:flutter/material.dart' show MaterialPageRoute;
import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'secure_window.dart';

/// Wraps a screen that shows money or a decision so that the window is protected for as long as the screen is the one being
/// looked at: from the moment it is shown until it is closed, covered by another screen, or left by switching to another tab.
class SecureScreen extends ConsumerStatefulWidget {
  const SecureScreen({required this.child, super.key});

  final Widget child;

  @override
  ConsumerState<SecureScreen> createState() => _SecureScreenState();
}

class _SecureScreenState extends ConsumerState<SecureScreen> {
  late final SecureWindowController _controller;
  void Function()? _release;

  @override
  void initState() {
    super.initState();
    _controller = ref.read(secureWindowControllerProvider);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // A screen of a tab that is not shown, or one covered by another screen, is built but not ticking.
    if (TickerMode.valuesOf(context).enabled) {
      _release ??= _controller.acquire();
    } else {
      _release?.call();
      _release = null;
    }
  }

  @override
  void dispose() {
    _release?.call();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => widget.child;
}

/// The route of a screen that is pushed by hand (not through the router) over a protected screen. A route that covers the protected
/// screen releases the protection of that screen (it is no longer the one being looked at), and a route pushed by hand does not pass
/// through the router's [SecureScreen] wrapper, so the screen it shows (a document, a page of it) would be capturable exactly while
/// its content is on display. Every such route is built with this function.
Route<T> secureRoute<T>(WidgetBuilder builder) => MaterialPageRoute<T>(builder: (BuildContext context) => SecureScreen(child: builder(context)));
