"""Minimal OpenRouter client (chat completions, embeddings, transcription) using only the stdlib."""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request

from .config import Settings


class OpenRouterError(RuntimeError):
    pass


def post_json(settings: Settings, path: str, payload: dict, timeout: float = 180.0, retries: int = 3) -> dict:
    if not settings.openrouter_api_key:
        raise OpenRouterError("OPENROUTER_API_KEY is not set")
    url = settings.openrouter_base_url.rstrip("/") + path
    body = json.dumps(payload).encode("utf-8")
    headers = {
        "Authorization": f"Bearer {settings.openrouter_api_key}",
        "Content-Type": "application/json",
        "X-Title": "claudesynchro",
    }
    last_error: Exception | None = None
    for attempt in range(retries):
        request = urllib.request.Request(url, data=body, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as err:
            detail = err.read().decode("utf-8", errors="replace")[:500]
            last_error = OpenRouterError(f"HTTP {err.code} from {path}: {detail}")
            if err.code not in (408, 429, 500, 502, 503, 504):
                break
        except (urllib.error.URLError, TimeoutError) as err:
            last_error = OpenRouterError(f"{path}: {err}")
        time.sleep(2 ** attempt * 2)
    raise last_error or OpenRouterError(f"{path}: request failed")


def chat(settings: Settings, messages: list[dict], temperature: float = 0.2) -> str:
    data = post_json(
        settings,
        "/chat/completions",
        {"model": settings.openrouter_model, "messages": messages, "temperature": temperature},
    )
    try:
        return data["choices"][0]["message"]["content"] or ""
    except (KeyError, IndexError) as err:
        raise OpenRouterError(f"Unexpected chat response: {str(data)[:300]}") from err
