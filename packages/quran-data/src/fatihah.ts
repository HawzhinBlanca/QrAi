export interface SeedAyah {
  surahNumber: number;
  ayahNumber: number;
  text: string;
  words: string[];
}

export const FATIHAH_SEED: SeedAyah[] = [
  {
    surahNumber: 1,
    ayahNumber: 1,
    text: "بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ",
    words: ["بِسْمِ", "اللَّهِ", "الرَّحْمَٰنِ", "الرَّحِيمِ"],
  },
  {
    surahNumber: 1,
    ayahNumber: 2,
    text: "الْحَمْدُ لِلَّهِ رَبِّ الْعَالَمِينَ",
    words: ["الْحَمْدُ", "لِلَّهِ", "رَبِّ", "الْعَالَمِينَ"],
  },
  {
    surahNumber: 1,
    ayahNumber: 3,
    text: "الرَّحْمَٰنِ الرَّحِيمِ",
    words: ["الرَّحْمَٰنِ", "الرَّحِيمِ"],
  },
  {
    surahNumber: 1,
    ayahNumber: 4,
    text: "مَالِكِ يَوْمِ الدِّينِ",
    words: ["مَالِكِ", "يَوْمِ", "الدِّينِ"],
  },
  {
    surahNumber: 1,
    ayahNumber: 5,
    text: "إِيَّاكَ نَعْبُدُ وَإِيَّاكَ نَسْتَعِينُ",
    words: ["إِيَّاكَ", "نَعْبُدُ", "وَإِيَّاكَ", "نَسْتَعِينُ"],
  },
  {
    surahNumber: 1,
    ayahNumber: 6,
    text: "اهْدِنَا الصِّرَاطَ الْمُسْتَقِيمَ",
    words: ["اهْدِنَا", "الصِّرَاطَ", "الْمُسْتَقِيمَ"],
  },
  {
    surahNumber: 1,
    ayahNumber: 7,
    text: "صِرَاطَ الَّذِينَ أَنْعَمْتَ عَلَيْهِمْ غَيْرِ الْمَغْضُوبِ عَلَيْهِمْ وَلَا الضَّالِّينَ",
    words: [
      "صِرَاطَ",
      "الَّذِينَ",
      "أَنْعَمْتَ",
      "عَلَيْهِمْ",
      "غَيْرِ",
      "الْمَغْضُوبِ",
      "عَلَيْهِمْ",
      "وَلَا",
      "الضَّالِّينَ",
    ],
  },
] as const;
