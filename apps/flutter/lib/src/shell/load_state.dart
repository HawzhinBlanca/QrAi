/// FL8 — offline and error states.
///
/// ── The rule ────────────────────────────────────────────────────────────────────────────────────
/// Never present stale data as live. A screen that shows yesterday's progress with no indication
/// that the network is down is worse than one that shows nothing: the learner acts on it.
///
/// So `LoadState` has a `stale` variant that carries BOTH the cached value and the failure, and the
/// widget below is required to render an indicator alongside it. There is no way to hold cached
/// data in this type without also holding the reason it is cached.
library;

import 'package:flutter/material.dart';

import '../api/api_client.dart';

/// The state of a thing being loaded. Sealed, so `switch` is exhaustive and adding a variant breaks
/// every consumer at compile time rather than falling through to a blank screen.
sealed class LoadState<T> {
  const LoadState();
}

class Loading<T> extends LoadState<T> {
  const Loading();
}

class Loaded<T> extends LoadState<T> {
  const Loaded(this.value);
  final T value;
}

/// Cached data that could NOT be refreshed.
///
/// It carries the failure with it deliberately: a `Loaded` that silently held stale data would be
/// indistinguishable from fresh data at every call site, which is exactly the bug this type exists
/// to make unrepresentable.
class Stale<T> extends LoadState<T> {
  const Stale(this.value, this.failure);
  final T value;
  final ApiException failure;
}

class Failed<T> extends LoadState<T> {
  const Failed(this.failure);
  final ApiException failure;
}

/// Human-readable, and honest about what the user can do next.
///
/// `unauthorized` deliberately does NOT say "sign in again". There is no sign-in screen — the owner
/// removed it and it stays removed — so a device reaches this state only when its provisioned token
/// is missing, wrong or expired, and nothing the learner can do in this app will fix it. Telling
/// them to sign in would send them looking for a screen that does not exist. Measured against the
/// running service: `GET /v1/learner/progress` with no credential returns
/// `401 {"error":"missing or invalid authorization"}`.
String messageFor(ApiException e) => switch (e.kind) {
      ApiErrorKind.offline => "You're offline. This may not be up to date.",
      ApiErrorKind.unauthorized => "This device isn't set up for a learner yet. Ask your teacher.",
      ApiErrorKind.forbidden => "You don't have access to this.",
      ApiErrorKind.notFound => "That isn't available.",
      ApiErrorKind.badRequest => 'Something about that request was wrong.',
      ApiErrorKind.server => 'Something went wrong on our side.',
    };

/// Renders a `LoadState`, and REFUSES to render stale data without saying it is stale.
class LoadStateView<T> extends StatelessWidget {
  const LoadStateView({
    super.key,
    required this.state,
    required this.builder,
    this.onRetry,
  });

  final LoadState<T> state;
  final Widget Function(BuildContext, T) builder;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    return switch (state) {
      Loading<T>() => const Center(
          key: ValueKey<String>('load-loading'),
          child: CircularProgressIndicator(),
        ),
      Loaded<T>(value: final T v) => builder(context, v),
      // The banner is not optional and not a caller's choice: this branch always renders it above
      // the content. A `Stale` that looked like a `Loaded` is the bug.
      Stale<T>(value: final T v, failure: final ApiException f) => Column(
          key: const ValueKey<String>('load-stale'),
          children: <Widget>[
            _Banner(message: messageFor(f), onRetry: onRetry),
            Expanded(child: builder(context, v)),
          ],
        ),
      Failed<T>(failure: final ApiException f) => Center(
          key: const ValueKey<String>('load-failed'),
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                Text(messageFor(f), textAlign: TextAlign.center),
                // Retry is offered ONLY when one could plausibly help. Offering it on a 403 invites
                // a learner to press it forever.
                if (onRetry != null && f.isRetryable)
                  TextButton(
                    key: const ValueKey<String>('load-retry'),
                    onPressed: onRetry,
                    child: const Text('Try again'),
                  ),
              ],
            ),
          ),
        ),
    };
  }
}

class _Banner extends StatelessWidget {
  const _Banner({required this.message, this.onRetry});

  final String message;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    return Container(
      key: const ValueKey<String>('stale-banner'),
      width: double.infinity,
      color: theme.colorScheme.errorContainer,
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      child: Row(
        children: <Widget>[
          Expanded(
            child: Text(message, style: TextStyle(color: theme.colorScheme.onErrorContainer)),
          ),
          if (onRetry != null)
            TextButton(
              key: const ValueKey<String>('stale-retry'),
              onPressed: onRetry,
              child: const Text('Retry'),
            ),
        ],
      ),
    );
  }
}
