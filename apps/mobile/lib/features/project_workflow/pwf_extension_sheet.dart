import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../core/l10n/app_strings.dart';
import '../../core/theme/colors.dart';
import '../../core/theme/components.dart';
import '../../core/theme/typography.dart';
import '../../core/widgets/sheets.dart';
import 'pwf_commands.dart';
import 'pwf_models.dart';
import 'pwf_step_words.dart';

/// The most the server accepts in one line of a request for more time (`add_value`, 1 to 1095).
const int kPwfMaxExtensionValue = 1095;

/// What the person asks for: how much more time for the step, in the unit of its extension, and why.
final class PwfExtensionForm {
  const PwfExtensionForm({required this.value, required this.reason});

  final int value;
  final String reason;
}

/// The most that can be asked for now: what is left of the limit of the step (the server's count), and never more than one line of a request holds.
int pwfExtensionMax(PwfExtension extension) {
  final int? left = extension.valueLeft;
  return left == null ? kPwfMaxExtensionValue : left.clamp(0, kPwfMaxExtensionValue);
}

/// Opens the form of "Xin gia hạn" for one step. It says what the request is (a proposal: the deadline changes only when someone who may approve agrees), how much of the
/// limit is left, and asks for the amount in the unit of the extension and for a reason of at least [kPwfMinReasonLength] characters. It returns what the person decided,
/// or null when they left. It sends nothing: the screen does, with the result.
Future<PwfExtensionForm?> showPwfExtensionSheet(BuildContext context, {required String stepName, required PwfExtension extension}) {
  return showActionSheet<PwfExtensionForm>(
    context,
    title: context.t('mob.pwfs.extForm.title'),
    builder: (BuildContext sheet) => PwfExtensionFormContent(stepName: stepName, extension: extension),
  );
}

class PwfExtensionFormContent extends StatefulWidget {
  const PwfExtensionFormContent({required this.stepName, required this.extension, super.key});

  final String stepName;
  final PwfExtension extension;

  @override
  State<PwfExtensionFormContent> createState() => _PwfExtensionFormContentState();
}

class _PwfExtensionFormContentState extends State<PwfExtensionFormContent> {
  final TextEditingController _value = TextEditingController();
  final TextEditingController _reason = TextEditingController();
  bool _tried = false;

  @override
  void dispose() {
    _value.dispose();
    _reason.dispose();
    super.dispose();
  }

  int get _max => pwfExtensionMax(widget.extension);

  int? get _amount {
    final int? parsed = int.tryParse(_value.text.trim());
    return parsed != null && parsed >= 1 && parsed <= _max ? parsed : null;
  }

  bool get _reasonOk => pwfReasonIsLongEnough(_reason.text);

  @override
  Widget build(BuildContext context) {
    final MachvonV2 v2 = context.v2;
    final MachvonV2Text text = context.v2text;
    final String unit = pwfDurationUnitWord(context, widget.extension.unit);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Text(context.t('mob.pwfs.extForm.what', <String, Object>{'name': widget.stepName}), style: text.body),
        const SizedBox(height: MachvonV2Space.s4),
        Text(pwfExtensionUsed(context, widget.extension), style: text.caption),
        if (widget.extension.valueLeft != null) Text(context.t('mob.pwfs.extForm.left', <String, Object>{'value': widget.extension.valueLeft!, 'unit': unit}), style: text.caption),
        const SizedBox(height: MachvonV2Space.s12),
        TextField(
          controller: _value,
          keyboardType: TextInputType.number,
          inputFormatters: <TextInputFormatter>[FilteringTextInputFormatter.digitsOnly],
          maxLength: 4,
          onChanged: (String _) => setState(() {}),
          decoration: InputDecoration(labelText: context.t('mob.pwfs.extForm.value', <String, Object>{'unit': unit}), counterText: '', errorText: _tried && _amount == null ? context.t('mob.pwfs.extForm.value.invalid', <String, Object>{'max': _max}) : null),
        ),
        const SizedBox(height: MachvonV2Space.s8),
        TextField(
          controller: _reason,
          maxLines: 3,
          maxLength: 1000,
          onChanged: (String _) => setState(() {}),
          decoration: InputDecoration(labelText: context.t('mob.pwfs.extForm.reason'), errorText: _tried && !_reasonOk ? context.t('mob.pwf.sheet.note.short', <String, Object>{'min': kPwfMinReasonLength}) : null),
        ),
        const SizedBox(height: MachvonV2Space.s8),
        FilledButton(
          onPressed: () {
            setState(() => _tried = true);
            final int? amount = _amount;
            if (amount != null && _reasonOk) Navigator.pop(context, PwfExtensionForm(value: amount, reason: _reason.text.trim()));
          },
          style: v2PrimaryButtonStyle(v2),
          child: Text(context.t('mob.pwfs.extForm.send'), textAlign: TextAlign.center),
        ),
        const SizedBox(height: MachvonV2Space.s8),
        OutlinedButton(onPressed: () => Navigator.pop(context), style: v2QuietButtonStyle(v2), child: Text(context.t('mob.pwfs.extForm.cancel'), textAlign: TextAlign.center)),
      ],
    );
  }
}
