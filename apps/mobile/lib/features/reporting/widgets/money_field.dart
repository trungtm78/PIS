import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/format/format.dart';
import '../../../core/l10n/app_strings.dart';
import '../model/report_cells.dart';

/// A box for an amount of whole dong (design B form field): 48 high, the unit written beside it, a number pad, and the same amount below it in
/// the unit that fits it, exact, so that nobody has to count zeros (TK-MOB-011-5; `core/format`, never a digit hidden). The text is kept as it was
/// typed; the keyboard accepts only digits and the separators of thousands, and a pasted text that is not an amount is told under the box at
/// once, in words, before the review sees it (the review still decides what blocks the sending).
class MoneyField extends StatefulWidget {
  const MoneyField({required this.label, required this.value, required this.onChanged, this.enabled = true, this.error, this.hint, super.key});

  final String label;
  final String value;
  final ValueChanged<String> onChanged;
  final bool enabled;

  /// What is wrong with the entry, in words, or null.
  final String? error;

  /// A line under the box, shown in place of the amount (for example what the plan allocated).
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
    final String typed = _controller.text;
    final String? digits = digitsOf(typed);
    final String? amount = digits == null ? null : moneyLabel(context, digits);
    final String? error = widget.error ?? (typed.trim().isNotEmpty && digits == null ? context.t('mob.rep.field.invalid.body') : null);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: MachvonV2Space.s8),
      child: TextField(
        controller: _controller,
        enabled: widget.enabled,
        keyboardType: TextInputType.number,
        textInputAction: TextInputAction.next,
        inputFormatters: <TextInputFormatter>[FilteringTextInputFormatter.allow(RegExp(r'[0-9.,\s]'))],
        onTap: () => _controller.selection = TextSelection(baseOffset: 0, extentOffset: _controller.text.length),
        onChanged: (String value) {
          setState(() {});
          widget.onChanged(value);
        },
        decoration: InputDecoration(
          labelText: widget.label,
          suffixText: context.t('mob.rep.unit.dong.label'),
          errorText: error,
          errorMaxLines: 3,
          helperText: widget.hint ?? amount,
          helperMaxLines: 3,
          constraints: const BoxConstraints(minHeight: MachvonV2Size.actionButton),
        ),
      ),
    );
  }
}
