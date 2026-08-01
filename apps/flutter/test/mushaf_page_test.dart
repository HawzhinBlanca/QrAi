/// FL4 — the mushaf reader.
///
/// Two properties, and neither is styling: the ayah text reaches the screen VERBATIM, and the
/// Arabic is rendered right-to-left regardless of the surrounding app locale.
library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:qrai/src/api/models.dart';
import 'package:qrai/src/reader/mushaf_page.dart';

/// Ayah 1:1 as the corpus stores it — U+FEFF first. Code points, never a literal: a literal with
/// combining marks reorders itself in transit through editors and tooling.
const List<int> bismillahCodePoints = <int>[
  0xFEFF, 0x0628, 0x0650, 0x0633, 0x0652, 0x0645, 0x0650, 0x0020,
  0x0671, 0x0644, 0x0644, 0x064E, 0x0651, 0x0647, 0x0650,
];

Ayah ayah(String text, {int number = 1}) => Ayah(
      id: '1:$number',
      surahNumber: 1,
      ayahNumber: number,
      text: text,
      sourceChecksum: 'sha256:x',
    );

Future<void> pumpReader(
  WidgetTester tester,
  SurahDetail surah, {
  Locale locale = const Locale('en'),
  int? playing,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      locale: locale,
      home: Scaffold(body: MushafPage(surah: surah, playingAyahNumber: playing)),
    ),
  );
}

void main() {
  final String bismillah = String.fromCharCodes(bismillahCodePoints);

  testWidgets('the ayah text reaches the screen VERBATIM, U+FEFF included', (tester) async {
    await pumpReader(tester, SurahDetail(surahNumber: 1, ayahs: <Ayah>[ayah(bismillah)]));

    final Text rendered = tester.widget<Text>(find.byKey(const ValueKey<String>('ayah-text-1:1')));
    expect(rendered.data!.codeUnits, equals(bismillah.codeUnits));
    expect(
      rendered.data!.runes.first,
      equals(0xFEFF),
      reason: 'a trim() here removes the first character of the first ayah and nobody sees the loss',
    );
  });

  testWidgets('Arabic is RTL even when the app locale is English', (tester) async {
    // The direction is set on the TEXT, not inherited. A learner reading Arabic with an English UI
    // must still get RTL.
    await pumpReader(
      tester,
      SurahDetail(surahNumber: 1, ayahs: <Ayah>[ayah(bismillah)]),
      locale: const Locale('en'),
    );

    final Directionality dir = tester.widget<Directionality>(
      find
          .ancestor(
            of: find.byKey(const ValueKey<String>('ayah-text-1:1')),
            matching: find.byType(Directionality),
          )
          .first,
    );
    expect(dir.textDirection, TextDirection.rtl);
  });

  testWidgets('Arabic is still RTL under a Kurdish locale', (tester) async {
    await pumpReader(
      tester,
      SurahDetail(surahNumber: 1, ayahs: <Ayah>[ayah(bismillah)]),
      locale: const Locale('ckb'),
    );
    final Directionality dir = tester.widget<Directionality>(
      find
          .ancestor(
            of: find.byKey(const ValueKey<String>('ayah-text-1:1')),
            matching: find.byType(Directionality),
          )
          .first,
    );
    expect(dir.textDirection, TextDirection.rtl);
  });

  testWidgets('every ayah renders, in order', (tester) async {
    await pumpReader(
      tester,
      SurahDetail(
        surahNumber: 1,
        ayahs: <Ayah>[ayah('one', number: 1), ayah('two', number: 2), ayah('three', number: 3)],
      ),
    );
    expect(find.byType(AyahView), findsNWidgets(3));
    expect(find.text('one'), findsOneWidget);
    expect(find.text('three'), findsOneWidget);
  });

  testWidgets('the playing ayah is highlighted, and only that one', (tester) async {
    await pumpReader(
      tester,
      SurahDetail(surahNumber: 1, ayahs: <Ayah>[ayah('a', number: 1), ayah('b', number: 2)]),
      playing: 2,
    );
    final List<AyahView> views = tester.widgetList<AyahView>(find.byType(AyahView)).toList();
    expect(views[0].isPlaying, isFalse);
    expect(views[1].isPlaying, isTrue);
  });

  testWidgets('an empty surah SAYS so rather than rendering a blank page', (tester) async {
    await pumpReader(tester, const SurahDetail(surahNumber: 1, ayahs: <Ayah>[]));
    expect(find.byKey(const ValueKey<String>('mushaf-empty')), findsOneWidget);
    expect(find.byType(AyahView), findsNothing);
  });

  testWidgets('a screen reader announces the REFERENCE first, then the verse', (tester) async {
    final SemanticsHandle handle = tester.ensureSemantics();
    await pumpReader(tester, SurahDetail(surahNumber: 1, ayahs: <Ayah>[ayah(bismillah, number: 5)]));

    // `container: true` merges the child text INTO the label after the reference, so the node's
    // label is "Ayah 1:5\n<verse>\n5". A String matcher is exact and finds nothing; the prefix is
    // what matters, because it is what a screen reader speaks first.
    expect(find.bySemanticsLabel(RegExp(r'^Ayah 1:5')), findsOneWidget);

    // …and the verse is in there VERBATIM, so the reader is not announcing a mangled ayah.
    expect(find.bySemanticsLabel(RegExp(RegExp.escape(bismillah))), findsOneWidget);
    handle.dispose();
  });
}
