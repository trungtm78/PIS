import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../../core/l10n/app_strings.dart';
import '../../read_support/amounts.dart';
import '../model/report_cells.dart';

/// A box for an amount of whole dong, with the unit written beside it and the same amount in millions of dong below it, so that
/// nobody has to count zeros (TK-MOB-011-5). The text is kept as it was typed; a number pad is shown, and anything but digits and
/// the separators of thousands is not accepted by the keyboard (the review still checks what arrives, for a pasted text).
class MoneyField extends StatefulWidget {
  const MoneyField({required this.label, required this.value, required this.onChanged, this.enabled = true, this.error, this.hint, super.key});

  final String label;
  final String value;
  final ValueChanged<String> onChanged;
  final bool enabled;

  /// What is wrong with the entry, in words, or null.
  final String? error;

  /// A line under the box, shown in place of the amount in millions (for example what the plan allocated).
  final String? hint;

  @override
  State<MoneyField> createState() => _MoneyFieldState();
}

class _MoneyFieldState extends State<MoneyField> {
  late final TextEditingController _controller = TextEditingController(text: widget.value);

  @override
  void didUpdateWidget(MoneyField oldWidget) {
    super.didUpdateWidget(oldWidget);
    // A value that came from elsewhere (the draft was reloaded) replaces the text; what the person is typing never does.
    if (widget.value != oldWidget.value && widget.value != _controller.text) _controller.text = widget.value;
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final String? digits = digitsOf(_controller.text);
    final String? millions = digits == null ? null : millionsLabel(context, digits);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: TextField(
        controller: _controller,
        enabled: widget.enabled,
        keyboardType: TextInputType.number,
        textInputAction: TextInputAction.next,
        inputFormatters: <TextInputFormatter>[FilteringTextInputFormatter.allow(RegExp(r'[0-9.,\s]'))],
        onTap: () => _controller.selection = TextSelection(baseOffset: 0, extentOffset: _controller.text.length),
        onChanged: (String typed) {
          setState(() {});
          widget.onChanged(typed);
        },
        decoration: InputDecoration(
          labelText: widget.label,
          suffixText: context.t('mob.rep.unit.dong.label'),
          errorText: widget.error,
          errorMaxLines: 3,
          helperText: widget.hint ?? millions,
          helperMaxLines: 3,
        ),
      ),
    );
  }
}
