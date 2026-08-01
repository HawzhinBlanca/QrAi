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
      if (mounted) setState(() => _message = 'That did not complete: $e');
    } finally {
      if (mounted) setState(() => _action = PrivacyAction.idle);
    }
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
