import ssl

import pytest

from claudesynchro import downloads
from claudesynchro.downloads import SetupError, hf_file, root_cause
from claudesynchro.sync import Outcome


def _chained() -> Exception:
    try:
        try:
            raise ssl.SSLCertVerificationError(
                "[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed: unable to get local issuer certificate"
            )
        except ssl.SSLError as inner:
            raise ConnectionError("connect failed") from inner
    except ConnectionError as outer:
        try:
            raise LookupError("cannot find the requested files in the local cache") from outer
        except LookupError as err:
            return err


def test_root_cause_follows_the_chain():
    assert isinstance(root_cause(_chained()), ssl.SSLCertVerificationError)


def test_failed_download_is_a_setup_error_with_a_hint(monkeypatch):
    import huggingface_hub

    def fail(*args, **kwargs):
        raise _chained()

    monkeypatch.setattr(huggingface_hub, "hf_hub_download", fail)
    with pytest.raises(SetupError) as info:
        hf_file("Xenova/some-model", "tokenizer.json", downloads.Path("/tmp"))
    message = str(info.value)
    assert "Xenova/some-model/tokenizer.json" in message
    assert "CERTIFICATE_VERIFY_FAILED" in message
    assert "CA certificates" in message


def test_setup_error_has_its_own_exit_code():
    assert Outcome("setup_error", "x").exit_code == 4
    assert Outcome("error", "x").exit_code == 1
