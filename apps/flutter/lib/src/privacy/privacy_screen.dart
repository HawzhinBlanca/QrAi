/// FL7 — learner privacy self-service.
///
/// ── Delete is irreversible, so the confirmation is not a formality ──────────────────────────────
/// A single "Delete my data" button behind a yes/no dialog is a mis-tap away from erasing a
/// learner's entire history — including recordings a teacher has reviewed. So the destructive
/// action is gated on an explicit, typed confirmation, and the dialog SAYS what will be destroyed
/// rather than asking "are you sure?".
///
/// Export is not destructive and needs no such gate.
library;

import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../shell/load_state.dart';

/// What the screen is currently doing. Kept explicit so the UI can disable both buttons during a
/// request — a second delete fired while the first is in flight is not something to find out about
/// from the server.
enum PrivacyAction { idle, exporting, deleting }

class PrivacyScreen extends StatefulWidget {
  const PrivacyScreen({
    super.key,
    required this.onExport,
    required this.onDelete,
    this.confirmationWord = 'DELETE',
  });

  final Future<void> Function() onExport;
  final Future<void> Function() onDelete;

  /// The word the learner must type. A parameter so a localized build can require a word in the
  /// learner's own language — asking a Kurdish speaker to type an English word to protect
  /// themselves is a barrier, not a safeguard.
  final String confirmationWord;

  @override
  State<PrivacyScreen> createState() => _PrivacyScreenState();
}

class _PrivacyScreenState extends State<PrivacyScreen> {
  PrivacyAction _action = PrivacyAction.idle;
  String? _message;

  bool get _busy => _action != PrivacyAction.idle;

  Future<void> _run(PrivacyAction action, Future<void> Function() op, String done) async {
    if (_busy) return;
    setState(() {
      _action = action;
      _message = null;
    });
    try {
      await op();
      if (mounted) setState(() => _message = done);
    } on Object catch (e) {
      // The failure is SHOWN. A privacy request that silently failed is the worst outcome here:
      // the learner believes their data is gone.
      //
      // It used to interpolate the exception, which put
      //   "That did not complete: ApiException(ApiErrorKind.server, 502): audio erasure service
      //    unavailable"
      // in front of a learner — measured against the running service with the ML service down.
      // On a DELETE that is worse than jargon: it leaves them unable to tell whether their
      // recordings are gone. So the message states the OUTCOME first, and it is a claim this
      // codebase can actually back: platform-api erases audio BEFORE the database cascade and
      // fails fast, so a failure means nothing was deleted. Verified by querying the tables after
      // a real 502 — sessions, progress and tickets were all still there.
      if (mounted) {
        setState(() => _message = _failureMessage(action, e));
      }
    } finally {
      if (mounted) setState(() => _action = PrivacyAction.idle);
    }
  }

  /// What went wrong, in the learner's terms, leading with what it means for their data.
  static String _failureMessage(PrivacyAction action, Object error) {
    final String why = error is ApiException ? messageFor(error) : 'Something went wrong.';
    return switch (action) {
      // The strong, verified claim. Erasure is attempted before any database change, so a failure
      // leaves everything in place — the learner can retry without wondering what half-happened.
      PrivacyAction.deleting => 'Nothing was deleted — your data is still here. $why',
      PrivacyAction.exporting => 'The export did not finish. $why',
      PrivacyAction.idle => why,
    };
  }

  Future<void> _confirmDelete() async {
    final bool confirmed = await showDialog<bool>(
          context: context,
          builder: (BuildContext ctx) => _DeleteConfirmDialog(word: widget.confirmationWord),
        ) ??
        false;
    if (!confirmed || !mounted) return;
    await _run(PrivacyAction.deleting, widget.onDelete, 'Your data has been deleted.');
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        ListTile(
          title: const Text('Download my data'),
          subtitle: const Text('A copy of your sessions, progress and consent records.'),
          trailing: FilledButton(
            key: const ValueKey<String>('privacy-export'),
            onPressed: _busy
                ? null
                : () => _run(PrivacyAction.exporting, widget.onExport, 'Your export is ready.'),
            child: const Text('Export'),
          ),
        ),
        ListTile(
          title: const Text('Delete my data'),
          // Says WHAT is destroyed. "Are you sure?" tells a learner nothing they can weigh.
          subtitle: const Text(
            'Permanently removes your recordings, sessions and progress. This cannot be undone.',
          ),
          trailing: FilledButton(
            key: const ValueKey<String>('privacy-delete'),
            style: FilledButton.styleFrom(
              backgroundColor: Theme.of(context).colorScheme.error,
            ),
            onPressed: _busy ? null : _confirmDelete,
            child: const Text('Delete'),
          ),
        ),
        if (_message != null)
          Padding(
            padding: const EdgeInsets.all(16),
            child: Text(_message!, key: const ValueKey<String>('privacy-message')),
          ),
      ],
    );
  }
}

class _DeleteConfirmDialog extends StatefulWidget {
  const _DeleteConfirmDialog({required this.word});
  final String word;

  @override
  State<_DeleteConfirmDialog> createState() => _DeleteConfirmDialogState();
}

class _DeleteConfirmDialogState extends State<_DeleteConfirmDialog> {
  final TextEditingController _controller = TextEditingController();
  bool _matches = false;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      key: const ValueKey<String>('privacy-delete-dialog'),
      title: const Text('Delete everything?'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(
            'This removes your recordings, your sessions, your progress and your consent records. '
            'It cannot be undone.',
          ),
          const SizedBox(height: 12),
          Text('Type ${widget.word} to confirm.'),
          TextField(
            key: const ValueKey<String>('privacy-delete-input'),
            controller: _controller,
            onChanged: (String v) => setState(() => _matches = v.trim() == widget.word),
          ),
        ],
      ),
      actions: <Widget>[
        TextButton(
          key: const ValueKey<String>('privacy-delete-cancel'),
          onPressed: () => Navigator.of(context).pop(false),
          child: const Text('Cancel'),
        ),
        FilledButton(
          key: const ValueKey<String>('privacy-delete-confirm'),
          // Disabled until the word matches. A mis-tap must not be able to reach this.
          onPressed: _matches ? () => Navigator.of(context).pop(true) : null,
          child: const Text('Delete everything'),
        ),
      ],
    );
  }
}
