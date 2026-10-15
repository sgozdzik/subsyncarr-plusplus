"""Multilingual sentence embeddings: a small local ONNX model, or OpenRouter."""

from __future__ import annotations

from typing import Callable, Protocol

import numpy as np

from .config import Settings
from .openrouter import OpenRouterError, post_json

Log = Callable[[str], None]


class Embedder(Protocol):
    name: str

    def embed(self, texts: list[str]) -> np.ndarray: ...


def _normalize(vectors: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return (vectors / norms).astype(np.float32)


def _embed_unique(texts: list[str], embed_fn: Callable[[list[str]], np.ndarray]) -> np.ndarray:
    unique = sorted({t for t in texts if t})
    if not unique:
        return np.zeros((len(texts), 1), dtype=np.float32)
    vectors = embed_fn(unique)
    lookup = {t: i for i, t in enumerate(unique)}
    out = np.zeros((len(texts), vectors.shape[1]), dtype=np.float32)
    for i, t in enumerate(texts):
        if t:
            out[i] = vectors[lookup[t]]
    return out


class LocalEmbedder:
    """paraphrase-multilingual-MiniLM-L12-v2 (int8 ONNX) with mean pooling. ~120 MB, no AVX needed."""

    def __init__(self, settings: Settings, log: Log):
        import onnxruntime as ort
        from tokenizers import Tokenizer

        from .downloads import hf_file

        cache = settings.models_dir / "embeddings"
        repo = settings.embed_model_repo
        log(f"Loading embedding model {repo} ({settings.embed_model_file})")
        tokenizer_path = hf_file(repo, "tokenizer.json", cache)
        model_path = hf_file(repo, settings.embed_model_file, cache)
        fallback = lambda: hf_file(repo, "onnx/model.onnx", cache)

        self.tokenizer = Tokenizer.from_file(tokenizer_path)
        self.tokenizer.enable_truncation(max_length=128)
        pad_token = "<pad>" if self.tokenizer.token_to_id("<pad>") is not None else "[PAD]"
        self.tokenizer.enable_padding(pad_id=self.tokenizer.token_to_id(pad_token) or 0, pad_token=pad_token)

        options = ort.SessionOptions()
        options.intra_op_num_threads = settings.cpu_threads
        options.inter_op_num_threads = 1
        self.session = ort.InferenceSession(model_path, options, providers=["CPUExecutionProvider"])
        self.input_names = {i.name for i in self.session.get_inputs()}
        self.name = f"local:{repo}"
        try:
            self._embed_batch(["test"])
        except Exception as err:  # noqa: BLE001 - int8 kernels missing on this CPU
            log(f"Quantized embedding model failed ({err}); falling back to the full-precision model")
            self.session = ort.InferenceSession(fallback(), options, providers=["CPUExecutionProvider"])
            self.input_names = {i.name for i in self.session.get_inputs()}

    def _embed_batch(self, texts: list[str]) -> np.ndarray:
        encodings = self.tokenizer.encode_batch(texts)
        ids = np.array([e.ids for e in encodings], dtype=np.int64)
        mask = np.array([e.attention_mask for e in encodings], dtype=np.int64)
        feed = {"input_ids": ids, "attention_mask": mask}
        if "token_type_ids" in self.input_names:
            feed["token_type_ids"] = np.zeros_like(ids)
        hidden = self.session.run(None, feed)[0]
        weights = mask[..., None].astype(np.float32)
        pooled = (hidden * weights).sum(axis=1) / np.clip(weights.sum(axis=1), 1e-6, None)
        return pooled

    def _embed_all(self, texts: list[str]) -> np.ndarray:
        # Length-sorted batches keep padding (and CPU time) small.
        order = sorted(range(len(texts)), key=lambda i: len(texts[i]))
        chunks = []
        batch = 32
        for start in range(0, len(order), batch):
            idx = order[start : start + batch]
            chunks.append((idx, self._embed_batch([texts[i] for i in idx])))
        dim = chunks[0][1].shape[1]
        out = np.zeros((len(texts), dim), dtype=np.float32)
        for idx, vecs in chunks:
            out[idx] = vecs
        return _normalize(out)

    def embed(self, texts: list[str]) -> np.ndarray:
        return _embed_unique(texts, self._embed_all)


class OpenRouterEmbedder:
    def __init__(self, settings: Settings, log: Log):
        self.settings = settings
        self.name = f"openrouter:{settings.openrouter_embed_model}"
        log(f"Using OpenRouter embeddings ({settings.openrouter_embed_model})")

    def _embed_all(self, texts: list[str]) -> np.ndarray:
        vectors: list[list[float]] = []
        for start in range(0, len(texts), 128):
            batch = texts[start : start + 128]
            data = post_json(
                self.settings, "/embeddings", {"model": self.settings.openrouter_embed_model, "input": batch}
            )
            items = sorted(data.get("data", []), key=lambda d: d.get("index", 0))
            if len(items) != len(batch):
                raise OpenRouterError(f"Embeddings response has {len(items)} vectors for {len(batch)} inputs")
            vectors.extend(item["embedding"] for item in items)
        return _normalize(np.array(vectors, dtype=np.float32))

    def embed(self, texts: list[str]) -> np.ndarray:
        return _embed_unique(texts, self._embed_all)


def make_embedder(settings: Settings, log: Log) -> Embedder:
    if settings.embeddings == "openrouter":
        return OpenRouterEmbedder(settings, log)
    return LocalEmbedder(settings, log)
