/// FL7 — learner privacy self-service.
///
/// Delete is irreversible, so the confirmation is not a formality. A single button behind a yes/no
/// dialog is a mis-tap away from erasing a learner's entire history, including recordings a teacher
/// has reviewed.
library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:qrai/src/api/api_client.dart';
import 'package:qrai/src/privacy/privacy_screen.dart';

void main() {
  late int exports;
  late int deletes;
  late Object? deleteError;

  Future<void> pump(WidgetTester tester, {String word = 'DELETE'}) {
    exports = 0;
    deletes = 0;
    return tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: PrivacyScreen(
            confirmationWord: word,
            onExport: () async => exports += 1,
            onDelete: () async {
              deletes += 1;
              if (deleteError != null) throw deleteError!;
            },
          ),
        ),
      ),
    );
  }

  setUp(() => deleteError = null);

  testWidgets('export runs immediately — it is not destructive', (tester) async {
    await pump(tester);
    await tester.tap(find.byKey(const ValueKey<String>('privacy-export')));
    await tester.pumpAndSettle();
    expect(exports, 1);
    expect(find.byKey(const ValueKey<String>('privacy-message')), findsOneWidget);
  });

  testWidgets('delete does NOT fire on the first tap — it opens a confirmation', (tester) async {
    await pump(tester);
    await tester.tap(find.byKey(const ValueKey<String>('privacy-delete')));
    await tester.pumpAndSettle();
    expect(deletes, 0, reason: 'a single tap must never erase a learner history');
    expect(find.byKey(const ValueKey<String>('privacy-delete-dialog')), findsOneWidget);
  });

  testWidgets('the confirm button is DISABLED until the word is typed exactly', (tester) async {
    await pump(tester);
    await tester.tap(find.byKey(const ValueKey<String>('privacy-delete')));
    await tester.pumpAndSettle();

    FilledButton confirm() => tester.widget<FilledButton>(
          find.byKey(const ValueKey<String>('privacy-delete-confirm')),
        );
    expect(confirm().onPressed, isNull, reason: 'a mis-tap must not be able to reach this');

    await tester.enterText(find.byKey(const ValueKey<String>('privacy-delete-input')), 'delete');
    await tester.pumpAndSettle();
    expect(confirm().onPressed, isNull, reason: 'the match is exact, not case-insensitive');

    await tester.enterText(find.byKey(const ValueKey<String>('privacy-delete-input')), 'DELETE');
    await tester.pumpAndSettle();
    expect(confirm().onPressed, isNotNull);
  });

  testWidgets('cancelling deletes nothing', (tester) async {
    await pump(tester);
    await tester.tap(find.byKey(const ValueKey<String>('privacy-delete')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey<String>('privacy-delete-cancel')));
    await tester.pumpAndSettle();
    expect(deletes, 0);
  });

  testWidgets('the full confirmed flow deletes exactly once', (tester) async {
    await pump(tester);
    await tester.tap(find.byKey(const ValueKey<String>('privacy-delete')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const ValueKey<String>('privacy-delete-input')), 'DELETE');
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey<String>('privacy-delete-confirm')));
    await tester.pumpAndSettle();
    expect(deletes, 1);
  });

  testWidgets('the confirmation word is LOCALIZABLE', (tester) async {
    // Asking a Kurdish speaker to type an English word to protect themselves is a barrier, not a
    // safeguard.
    await pump(tester, word: 'سڕینەوە');
    await tester.tap(find.byKey(const ValueKey<String>('privacy-delete')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const ValueKey<String>('privacy-delete-input')), 'سڕینەوە');
    await tester.pumpAndSettle();
    final FilledButton confirm = tester.widget<FilledButton>(
      find.byKey(const ValueKey<String>('privacy-delete-confirm')),
    );
    expect(confirm.onPressed, isNotNull);
  });

  testWidgets('a FAILED delete is shown, never silently swallowed', (tester) async {
    // A privacy request that silently failed is the worst outcome here: the learner believes their
    // data is gone.
    deleteError = StateError('server said no');
    await pump(tester);
    await tester.tap(find.byKey(const ValueKey<String>('privacy-delete')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const ValueKey<String>('privacy-delete-input')), 'DELETE');
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey<String>('privacy-delete-confirm')));
    await tester.pumpAndSettle();

    // A non-ApiException still produces a learner-facing message rather than a dumped object, and
    // still leads with the outcome. The success claim must NOT appear — that is the assertion this
    // case has always existed for, and it is unchanged.
    expect(find.textContaining('Nothing was deleted'), findsOneWidget);
    expect(find.textContaining('has been deleted'), findsNothing);
    expect(find.textContaining('StateError'), findsNothing, reason: 'the exception reached the UI');
  });

  testWidgets('the dialog SAYS what will be destroyed, not merely "are you sure?"', (tester) async {
    await pump(tester);
    await tester.tap(find.byKey(const ValueKey<String>('privacy-delete')));
    await tester.pumpAndSettle();
    // Scoped to the DIALOG. The list subtitle behind it also names what is destroyed — which is
    // correct, and is why an unscoped finder matches twice.
    final Finder dialog = find.byKey(const ValueKey<String>('privacy-delete-dialog'));
    expect(
      find.descendant(of: dialog, matching: find.textContaining('recordings')),
      findsOneWidget,
    );
    expect(
      find.descendant(of: dialog, matching: find.textContaining('cannot be undone')),
      findsOneWidget,
    );
    // And it is NOT merely asking whether the learner is sure.
    expect(find.descendant(of: dialog, matching: find.textContaining('consent records')), findsOneWidget);
  });

  testWidgets('a FAILED delete says nothing was deleted, and leaks no exception',
      (WidgetTester tester) async {
    // Measured against the running service with the ML service down: platform-api answers
    // 502 {"error":"audio erasure service unavailable"} and — verified by querying the tables —
    // leaves sessions, progress and tickets untouched, because erasure is attempted BEFORE the
    // database cascade. So "nothing was deleted" is a claim we can actually make, and it is the
    // only thing a learner staring at a failed erasure needs to know.
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: PrivacyScreen(
          onExport: () async {},
          onDelete: () async =>
              throw ApiException(ApiErrorKind.server, 'audio erasure service unavailable',
                  statusCode: 502),
        ),
      ),
    ));

    await tester.tap(find.byKey(const ValueKey<String>('privacy-delete')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const ValueKey<String>('privacy-delete-input')), 'DELETE');
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey<String>('privacy-delete-confirm')));
    await tester.pumpAndSettle();

    final String shown = (tester.widget(find.byKey(const ValueKey<String>('privacy-message'))) as Text)
        .data!;
    expect(shown, contains('Nothing was deleted'));
    expect(shown, contains('still here'));
    // The regression: it used to interpolate the exception object straight into the screen.
    expect(shown, isNot(contains('ApiException')));
    expect(shown, isNot(contains('502')));
  });
}

