import 'package:flutter/material.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

/// A box for words (or a number that is not an amount of dong, such as a percent) whose text is kept by the draft: 48 high at least, the
/// label on the box, the helper and the error under it (the error is shown the moment it is known), a number pad when [keyboardType] says so.
/// A value that comes from elsewhere replaces the text; what the person is typing never does.
class DraftTextField extends StatefulWidget {
  const DraftTextField({
    required this.label,
    required this.value,
    required this.onChanged,
    this.enabled = true,
    this.error,
    this.helper,
    this.maxLines = 1,
    this.keyboardType,
    this.suffix,
    super.key,
  });

  final String label;
  final String value;
  final ValueChanged<String> onChanged;
  final bool enabled;
  final String? error;
  final String? helper;
  final int maxLines;
  final TextInputType? keyboardType;
  final String? suffix;

  @override
  State<DraftTextField> createState() => _DraftTextFieldState();
}

class _DraftTextFieldState extends State<DraftTextField> {
  late final TextEditingController _controller = TextEditingController(text: widget.value);

  @override
  void didUpdateWidget(DraftTextField oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.value != oldWidget.value && widget.value != _controller.text) _controller.text = widget.value;
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final bool multiline = widget.maxLines > 1;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: MachvonV2Space.s8),
      child: TextField(
        controller: _controller,
        enabled: widget.enabled,
        minLines: multiline ? (widget.maxLines < 3 ? widget.maxLines : 3) : 1,
        maxLines: widget.maxLines,
        keyboardType: widget.keyboardType ?? (multiline ? TextInputType.multiline : TextInputType.text),
        textInputAction: multiline ? TextInputAction.newline : TextInputAction.next,
        onChanged: widget.onChanged,
        decoration: InputDecoration(
          labelText: widget.label,
          suffixText: widget.suffix,
          errorText: widget.error,
          errorMaxLines: 3,
          helperText: widget.helper,
          helperMaxLines: 4,
          alignLabelWithHint: multiline,
          constraints: const BoxConstraints(minHeight: MachvonV2Size.actionButton),
        ),
      ),
    );
  }
}
