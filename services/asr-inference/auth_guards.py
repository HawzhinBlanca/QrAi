"""Authentication and credential guards for the ASR inference service.

Enforces fail-closed configuration in production environments, matching the platform-api
security posture. In local dev and CI (ALLOW_INSECURE_SECRETS=1 or ALLOW_INSECURE_DEFAULTS=1),
the default smoke key is accepted.
"""
import hmac
import os
from typing import Optional


def resolve_asr_api_key(
    raw_key: Optional[str] = None,
    allow_insecure_defaults: Optional[str] = None,
    allow_insecure_secrets: Optional[str] = None,
) -> str:
    """Resolve ASR_API_KEY with fail-closed production verification.

    In dev/CI (ALLOW_INSECURE_SECRETS=1 or ALLOW_INSECURE_DEFAULTS=1), fallback key
    'smoke-asr-api-key' is accepted. In production, missing or weak keys raise RuntimeError.
    """
    if raw_key is None:
        raw_key = os.environ.get("ASR_API_KEY", "")
    if allow_insecure_defaults is None:
        allow_insecure_defaults = os.environ.get("ALLOW_INSECURE_DEFAULTS", "0")
    if allow_insecure_secrets is None:
        allow_insecure_secrets = os.environ.get("ALLOW_INSECURE_SECRETS", "")

    allow_insecure = (
        allow_insecure_secrets.strip().lower() in ("1", "true")
        or allow_insecure_defaults.strip().lower() in ("1", "true")
    )
    trimmed_key = raw_key.strip()
    if not trimmed_key:
        if allow_insecure:
            return "smoke-asr-api-key"
        raise RuntimeError(
            "ASR_API_KEY must be set to a strong, non-default value in production. "
            "Set ALLOW_INSECURE_SECRETS=1 or ALLOW_INSECURE_DEFAULTS=1 for local dev/CI only."
        )
    if trimmed_key == "smoke-asr-api-key" and not allow_insecure:
        raise RuntimeError(
            "ASR_API_KEY must not use the default smoke key in production. "
            "Set ALLOW_INSECURE_SECRETS=1 or ALLOW_INSECURE_DEFAULTS=1 for local dev/CI only."
        )
    return trimmed_key


def verify_asr_key(provided_key: Optional[str], expected_key: str) -> bool:
    """Constant-time comparison for ASR API keys."""
    if not provided_key or not expected_key:
        return False
    return hmac.compare_digest(provided_key, expected_key)
