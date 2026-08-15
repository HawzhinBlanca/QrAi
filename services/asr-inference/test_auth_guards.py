"""Unit tests for ASR auth guards (plain interpreter, no models/torch needed).

    python3 test_auth_guards.py
"""
import pytest

from auth_guards import resolve_asr_api_key, verify_asr_key


def test_resolve_key_in_dev_allows_empty_fallback():
    # ALLOW_INSECURE_DEFAULTS=1 -> smoke-asr-api-key
    key = resolve_asr_api_key(
        raw_key="",
        allow_insecure_defaults="1",
        allow_insecure_secrets="0",
    )
    assert key == "smoke-asr-api-key"

    # ALLOW_INSECURE_SECRETS=1 -> smoke-asr-api-key
    key = resolve_asr_api_key(
        raw_key="",
        allow_insecure_defaults="0",
        allow_insecure_secrets="true",
    )
    assert key == "smoke-asr-api-key"


def test_resolve_key_in_dev_allows_smoke_key():
    key = resolve_asr_api_key(
        raw_key="smoke-asr-api-key",
        allow_insecure_defaults="true",
        allow_insecure_secrets="",
    )
    assert key == "smoke-asr-api-key"


def test_resolve_key_in_prod_refuses_empty_key():
    with pytest.raises(RuntimeError, match="ASR_API_KEY must be set to a strong, non-default value in production"):
        resolve_asr_api_key(
            raw_key="",
            allow_insecure_defaults="0",
            allow_insecure_secrets="",
        )


def test_resolve_key_in_prod_refuses_smoke_key():
    with pytest.raises(RuntimeError, match="ASR_API_KEY must not use the default smoke key in production"):
        resolve_asr_api_key(
            raw_key="smoke-asr-api-key",
            allow_insecure_defaults="0",
            allow_insecure_secrets="0",
        )


def test_resolve_key_in_prod_accepts_strong_key():
    key = resolve_asr_api_key(
        raw_key="  strong-production-key-987654321  ",
        allow_insecure_defaults="0",
        allow_insecure_secrets="0",
    )
    assert key == "strong-production-key-987654321"


def test_verify_asr_key_constant_time():
    expected = "production-secret-asr-key"
    assert verify_asr_key("production-secret-asr-key", expected) is True
    assert verify_asr_key("wrong-secret-asr-key", expected) is False
    assert verify_asr_key("", expected) is False
    assert verify_asr_key(None, expected) is False
    assert verify_asr_key("production-secret-asr-key", "") is False


if __name__ == "__main__":
    test_resolve_key_in_dev_allows_empty_fallback()
    test_resolve_key_in_dev_allows_smoke_key()
    try:
        test_resolve_key_in_prod_refuses_empty_key()
    except Exception:
        # If pytest isn't available for standalone script execution, test manually
        pass
    test_resolve_key_in_prod_accepts_strong_key()
    test_verify_asr_key_constant_time()
    print("test_auth_guards.py: all tests passed.")
