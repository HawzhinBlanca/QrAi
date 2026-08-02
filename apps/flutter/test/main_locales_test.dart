/// A locale is only supported when its strings exist.
library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:qrai/main.dart';
import 'package:qrai/src/api/api_client.dart';

/// The locale list is a property of the widget, not of any request — so the client never answers.
ApiClient throwingClient() => ApiClient(
      baseUrl: Uri.parse('http://127.0.0.1:8080'),
      tokenProvider: () async => null,
      httpClient: MockClient((http.Request _) async => http.Response('[]', 200,
          headers: <String, String>{'content-type': 'application/json'})),
    );

void main() {
  testWidgets('supportedLocales lists only locales the app actually has strings for',
      (WidgetTester tester) async {
    // `ar` and `ckb` were advertised while every string in the app is English. Flutter RESOLVES
    // against this list, so an Arabic device received an RTL layout full of English text.
    //
    // When an ARB bundle lands, add the locale here AND update this test — in that order the
    // failure is a prompt; in the other order it is a false claim shipped to a learner.
    await tester.pumpWidget(QrAiApp(
      client: throwingClient(),
      gatewayBase: Uri.parse('http://127.0.0.1:8081'),
      learnerId: 'learner-1',
    ));

    final MaterialApp app = tester.widget(find.byType(MaterialApp));
    expect(
      app.supportedLocales.map((Locale l) => l.toLanguageTag()).toList(),
      <String>['en'],
      reason: 'a locale is advertised that has no strings; see the comment in main.dart',
    );
  });
}
