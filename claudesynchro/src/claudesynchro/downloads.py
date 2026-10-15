"""Model downloads from the Hugging Face Hub.

A failed download is a problem with the container (network, CA certificates, disk), not with
the file being synced, so it raises SetupError: the caller stops using claudesynchro for the
rest of the run instead of failing every file in the library the same way.
"""

from __future__ import annotations

import os
import ssl
import time
from pathlib import Path


class SetupError(RuntimeError):
    """claudesynchro cannot work in this environment; other files would fail the same way."""


def root_cause(err: BaseException) -> BaseException:
    seen = set()
    while id(err) not in seen:
        seen.add(id(err))
        nxt = err.__cause__ or err.__context__
        if nxt is None:
            break
        err = nxt
    return err


def _hint(text: str) -> str:
    if any(s in text for s in ("CERTIFICATE_VERIFY_FAILED", "NO_CERTIFICATE_OR_CRL_FOUND", "certificate verify failed")):
        return "The container does not trust huggingface.co's certificate: update to the latest image (it ships CA certificates) or set SSL_CERT_FILE."
    if any(s in text for s in ("Name or service not known", "Temporary failure in name resolution", "getaddrinfo")):
        return "DNS lookup failed: check the container's network and DNS settings."
    if any(s in text.lower() for s in ("timed out", "connection refused", "network is unreachable")):
        return "Check that the container can reach huggingface.co (proxy, firewall)."
    if "No space left" in text:
        return "The data volume is full."
    return "Check the container's internet access; once downloaded the model is cached in the data volume."


def download_error(what: str, err: BaseException) -> SetupError:
    cause = root_cause(err)
    text = f"{type(cause).__name__}: {cause}"
    return SetupError(f"Could not download {what} ({text}). {_hint(text)}")


def hf_file(repo: str, filename: str, cache_dir: Path) -> str:
    from huggingface_hub import hf_hub_download

    try:
        return hf_hub_download(repo, filename, cache_dir=str(cache_dir))
    except Exception as err:  # noqa: BLE001 - network, TLS, disk: all mean "cannot run here"
        raise download_error(f"{repo}/{filename} from huggingface.co", err) from err


def whisper_model(name: str, cache_dir: Path) -> str:
    """Local folder of a faster-whisper model (a size like 'base', a repo id, or a path)."""
    if os.path.isdir(name):
        return name
    from faster_whisper.utils import download_model

    try:
        return download_model(name, cache_dir=str(cache_dir))
    except Exception as err:  # noqa: BLE001
        raise download_error(f"Whisper model '{name}' from huggingface.co", err) from err


def check_https(url: str = "https://huggingface.co", timeout: float = 8.0) -> str:
    """'ok …' or the error, for the Diagnostics page. Uses the Hub client the downloads use, without retries."""
    from huggingface_hub.utils import get_session

    started = time.monotonic()
    try:
        response = get_session().head(url, timeout=timeout)
        return f"ok (HTTP {response.status_code}, {time.monotonic() - started:.1f}s)"
    except Exception as err:  # noqa: BLE001 - reported, not fatal
        cause = root_cause(err)
        text = f"{type(cause).__name__}: {cause}"
        return f"error: {text}. {_hint(text)}"


def tls_info() -> dict:
    paths = ssl.get_default_verify_paths()
    return {
        "openssl_cafile": paths.cafile,
        "openssl_capath": paths.capath,
        "debian_bundle": os.path.isfile("/etc/ssl/certs/ca-certificates.crt"),
        "SSL_CERT_FILE": os.environ.get("SSL_CERT_FILE"),
    }
