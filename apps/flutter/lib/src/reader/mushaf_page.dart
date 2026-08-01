/// FL4 — the mushaf reader.
///
/// ── Two rules that are not styling ──────────────────────────────────────────────────────────────
/// 1. The ayah text is rendered EXACTLY as it arrived. No `trim()`, no `normalize`, no
///    `replaceAll`, no `toUpperCase`. This corpus stores ayah 1:1 with a leading U+FEFF and is
///    NFC-unstable, so any of those is a silent mutation of scripture.
/// 2. `Directionality(TextDirection.rtl)` is set on the Arabic text SPECIFICALLY, not inherited
///    from the app locale. A learner reading Arabic with an English UI must still get RTL for the
///    ayah, and an English translation inside an RTL app must still get LTR.
library;

import 'package:flutter/material.dart';

import '../api/models.dart';

/// A single ayah, rendered right-to-left with its number.
class AyahView extends StatelessWidget {
  const AyahView({super.key, required this.ayah, this.isPlaying = false});

  final Ayah ayah;
  final bool isPlaying;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    return Semantics(
      // `container: true` is required, not decoration: without it this Semantics MERGES into the
      // parent node instead of forming one of its own, and the label is never emitted. Measured —
      // the accessibility test found zero nodes until it was added.
      //
      // The label carries the REFERENCE; the ayah text is merged in after it as content, so a
      // screen reader announces "Ayah 1:5" and then the verse.
      container: true,
      label: 'Ayah ${ayah.surahNumber}:${ayah.ayahNumber}',
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 16),
        decoration: BoxDecoration(
          color: isPlaying ? theme.colorScheme.primaryContainer : null,
          borderRadius: BorderRadius.circular(8),
        ),
        // Explicit, not inherited. See rule 2 in the library comment.
        child: Directionality(
          textDirection: TextDirection.rtl,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text(
                // VERBATIM. If you are tempted to add `.trim()` here, read rule 1.
                ayah.text,
                key: ValueKey<String>('ayah-text-${ayah.id}'),
                textAlign: TextAlign.right,
                style: theme.textTheme.headlineSmall?.copyWith(height: 2.0),
              ),
              const SizedBox(height: 4),
              Text(
                '${ayah.ayahNumber}',
                style: theme.textTheme.labelSmall?.copyWith(color: theme.hintColor),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// The reader for one surah.
class MushafPage extends StatelessWidget {
  const MushafPage({super.key, required this.surah, this.playingAyahNumber});

  final SurahDetail surah;
  final int? playingAyahNumber;

  @override
  Widget build(BuildContext context) {
    if (surah.ayahs.isEmpty) {
      // An empty surah is a data problem, not a blank page. Saying so beats rendering nothing.
      return const Center(
        key: ValueKey<String>('mushaf-empty'),
        child: Padding(
          padding: EdgeInsets.all(24),
          child: Text('This surah has no verses to show yet.'),
        ),
      );
    }

    return ListView.separated(
      key: const ValueKey<String>('mushaf-list'),
      padding: const EdgeInsets.all(16),
      itemCount: surah.ayahs.length,
      separatorBuilder: (_, __) => const Divider(height: 1),
      itemBuilder: (BuildContext context, int i) {
        final Ayah ayah = surah.ayahs[i];
        return AyahView(ayah: ayah, isPlaying: ayah.ayahNumber == playingAyahNumber);
      },
    );
  }
}
