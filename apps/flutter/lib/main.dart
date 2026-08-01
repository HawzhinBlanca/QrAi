/// AUD1 — the application. Before this file `apps/flutter` was eight library files with no entry
/// point, no host projects and nothing that could be launched: components, not a client.
///
/// ── There is no sign-in screen, deliberately ────────────────────────────────────────────────────
/// The owner's standing instruction is that login stays removed until they ask for it back. So the
/// bearer token is read from platform secure storage (`TokenStore`) and the learner identity comes
/// from build configuration. Nothing here collects a credential, and adding a screen that did would
/// be reversing a decision that is not this file's to make.
///
/// ── Configuration ───────────────────────────────────────────────────────────────────────────────
///   flutter run --dart-define=QRAI_API_BASE_URL=https://api.example.com \
///               --dart-define=QRAI_GATEWAY_URL=https://rt.example.com \
///               --dart-define=QRAI_LEARNER_ID=learner-1
/// The defaults point at localhost, so a misconfigured build reaches nothing rather than someone
/// else's tenant.
library;

import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';

import 'src/api/api_client.dart';
import 'src/api/models.dart';
import 'src/auth/token_store.dart';
import 'src/practice/practice_screen.dart';
import 'src/privacy/privacy_screen.dart';
import 'src/reader/mushaf_page.dart';
import 'src/shell/load_state.dart';

const String _apiBaseUrl =
    String.fromEnvironment('QRAI_API_BASE_URL', defaultValue: 'http://127.0.0.1:8080');
const String _gatewayUrl =
    String.fromEnvironment('QRAI_GATEWAY_URL', defaultValue: 'http://127.0.0.1:8081');
const String _learnerId = String.fromEnvironment('QRAI_LEARNER_ID', defaultValue: 'learner-1');

/// Out-of-band provisioning. Empty by default, which is the honest default: a build with no token
/// reaches the API unauthenticated and every learner route answers 401 — measured, not assumed.
///
/// This is NOT a sign-in. The device is configured by whoever hands it to the learner, the value
/// never appears in a UI, and it is moved into platform secure storage at first launch so it is not
/// read back out of the build. Whether a pilot should instead redeem an invitation code in-app is
/// an owner decision, not this file's.
const String _bearerToken = String.fromEnvironment('QRAI_BEARER_TOKEN');

Future<void> main() async {
  // Required before touching a platform channel — `TokenStore` reaches Keychain/Keystore.
  WidgetsFlutterBinding.ensureInitialized();

  final TokenStore tokens = TokenStore();
  if (_bearerToken.isNotEmpty) {
    try {
      await tokens.write(_bearerToken);
    } on Object {
      // Secure storage can fail (a locked keychain, an unprovisioned emulator). That must not stop
      // the app from launching: the reader works unauthenticated, and every other screen already
      // says honestly that the device is not set up.
    }
  }

  runApp(
    QrAiApp(
      client: ApiClient(baseUrl: Uri.parse(_apiBaseUrl), tokenProvider: tokens.read),
      gatewayBase: Uri.parse(_gatewayUrl),
      learnerId: _learnerId,
    ),
  );
}

class QrAiApp extends StatelessWidget {
  const QrAiApp({
    super.key,
    required this.client,
    required this.gatewayBase,
    required this.learnerId,
  });

  final ApiClient client;
  final Uri gatewayBase;
  final String learnerId;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'QrAi',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(colorSchemeSeed: const Color(0xFF16643C), useMaterial3: true),
      darkTheme: ThemeData(
        colorSchemeSeed: const Color(0xFF16643C),
        brightness: Brightness.dark,
        useMaterial3: true,
      ),
      localizationsDelegates: GlobalMaterialLocalizations.delegates,
      // Arabic and Sorani Kurdish resolve RTL through these. The reader sets `Directionality` on the
      // canonical text itself regardless, because scripture must not depend on the app locale.
      // The UI strings are still English: this app has no ARB bundle yet, and claiming otherwise by
      // listing locales would be the decoration `FL7` was already too generous about.
      supportedLocales: const <Locale>[Locale('en'), Locale('ar'), Locale('ckb')],
      home: HomeShell(client: client, gatewayBase: gatewayBase, learnerId: learnerId),
    );
  }
}

class HomeShell extends StatefulWidget {
  const HomeShell({
    super.key,
    required this.client,
    required this.gatewayBase,
    required this.learnerId,
  });

  final ApiClient client;
  final Uri gatewayBase;
  final String learnerId;

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  int _tab = 0;

  @override
  Widget build(BuildContext context) {
    final List<Widget> tabs = <Widget>[
      ReadTab(client: widget.client),
      PracticeScreen(
        client: widget.client,
        gatewayBase: widget.gatewayBase,
        learnerId: widget.learnerId,
      ),
      ProgressTab(client: widget.client, learnerId: widget.learnerId),
      PrivacyTab(client: widget.client, learnerId: widget.learnerId),
    ];
    return Scaffold(
      appBar: AppBar(title: const Text('QrAi')),
      body: tabs[_tab],
      bottomNavigationBar: NavigationBar(
        key: const ValueKey<String>('home-nav'),
        selectedIndex: _tab,
        onDestinationSelected: (int i) => setState(() => _tab = i),
        destinations: const <NavigationDestination>[
          NavigationDestination(icon: Icon(Icons.menu_book), label: 'Read'),
          NavigationDestination(icon: Icon(Icons.mic_none), label: 'Practice'),
          NavigationDestination(icon: Icon(Icons.timeline), label: 'Progress'),
          NavigationDestination(icon: Icon(Icons.privacy_tip_outlined), label: 'Privacy'),
        ],
      ),
    );
  }
}

/// Loads once and rebuilds into a `LoadState`, so every screen handles offline and failure the same
/// way instead of each one inventing its own spinner.
class Loader<T> extends StatefulWidget {
  const Loader({super.key, required this.load, required this.builder});

  final Future<T> Function() load;
  final Widget Function(BuildContext, T) builder;

  @override
  State<Loader<T>> createState() => _LoaderState<T>();
}

class _LoaderState<T> extends State<Loader<T>> {
  LoadState<T> _state = Loading<T>();

  @override
  void initState() {
    super.initState();
    _run();
  }

  Future<void> _run() async {
    setState(() => _state = Loading<T>());
    try {
      final T value = await widget.load();
      if (mounted) setState(() => _state = Loaded<T>(value));
    } on ApiException catch (e) {
      if (mounted) setState(() => _state = Failed<T>(e));
    }
  }

  @override
  Widget build(BuildContext context) =>
      LoadStateView<T>(state: _state, builder: widget.builder, onRetry: _run);
}

class ReadTab extends StatelessWidget {
  const ReadTab({super.key, required this.client});

  final ApiClient client;

  @override
  Widget build(BuildContext context) {
    return Loader<List<SurahSummary>>(
      load: client.listSurahs,
      builder: (BuildContext context, List<SurahSummary> surahs) => ListView.builder(
        key: const ValueKey<String>('surah-list'),
        itemCount: surahs.length,
        itemBuilder: (BuildContext context, int i) {
          final SurahSummary s = surahs[i];
          return ListTile(
            leading: CircleAvatar(child: Text('${s.surahNumber}')),
            title: Text(s.name),
            // The Arabic name is canonical-derived, so it carries its own direction rather than
            // inheriting the app's.
            subtitle: Directionality(
              textDirection: TextDirection.rtl,
              child: Text(s.arabicName),
            ),
            trailing: Text('${s.ayahCount}'),
            onTap: () => Navigator.of(context).push(
              MaterialPageRoute<void>(
                builder: (BuildContext _) => SurahScreen(client: client, summary: s),
              ),
            ),
          );
        },
      ),
    );
  }
}

class SurahScreen extends StatelessWidget {
  const SurahScreen({super.key, required this.client, required this.summary});

  final ApiClient client;
  final SurahSummary summary;

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: Text(summary.name)),
        body: Loader<SurahDetail>(
          load: () => client.getSurah(summary.surahNumber),
          builder: (BuildContext _, SurahDetail surah) => MushafPage(surah: surah),
        ),
      );
}

class ProgressTab extends StatelessWidget {
  const ProgressTab({super.key, required this.client, required this.learnerId});

  final ApiClient client;
  final String learnerId;

  @override
  Widget build(BuildContext context) {
    return Loader<LearnerProgress>(
      load: () => client.getProgress(learnerId: learnerId),
      builder: (BuildContext context, LearnerProgress p) => ListView(
        key: const ValueKey<String>('progress-list'),
        children: <Widget>[
          ListTile(title: const Text('Mastery'), trailing: Text(p.mastery.toStringAsFixed(2))),
          ListTile(title: const Text('Streak'), trailing: Text('${p.streak}')),
          ListTile(title: const Text('Sessions'), trailing: Text('${p.totalSessions}')),
          ListTile(
            title: const Text('Next review'),
            // Null means SM-2 has not scheduled one yet — a learner with no reviews behind them.
            // "Not scheduled yet" is the honest rendering; an empty subtitle reads as a bug.
            subtitle: Text(p.nextReviewAt ?? 'Not scheduled yet'),
          ),
        ],
      ),
    );
  }
}

class PrivacyTab extends StatelessWidget {
  const PrivacyTab({super.key, required this.client, required this.learnerId});

  final ApiClient client;
  final String learnerId;

  @override
  Widget build(BuildContext context) => PrivacyScreen(
        onExport: () => client.requestPrivacyExport(learnerId: learnerId),
        onDelete: () => client.requestPrivacyDelete(learnerId: learnerId),
      );
}
