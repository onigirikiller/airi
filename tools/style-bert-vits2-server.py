#!/usr/bin/env python3
"""
Minimal Style-Bert-VITS2 HTTP server compatible with minecraft-bot local TTS.

Endpoints:
  - GET /health
  - GET /voice?text=...&model_id=0&speaker_id=0&style=Neutral&style_weight=1.0&sdp_ratio=0.2&noise=0.6&noise_w=0.8&length=1.0&language=JP
"""

from __future__ import annotations

import argparse
import io
import json
import logging
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import numpy as np
import torch
from style_bert_vits2.constants import DEFAULT_BERT_TOKENIZER_PATHS, Languages
import style_bert_vits2.models.infer as infer_module
from style_bert_vits2.nlp import bert_models
from style_bert_vits2.tts_model import TTSModel, TTSModelHolder


logger = logging.getLogger("sbv2-http")


def install_fp32_guard() -> None:
    if getattr(infer_module, "_airi_fp32_guard_installed", False):
        return

    original_extract_bert_feature = infer_module.extract_bert_feature

    def extract_bert_feature_fp32(*args, **kwargs):
        feature = original_extract_bert_feature(*args, **kwargs)
        if torch.is_tensor(feature):
            return feature.float()
        if isinstance(feature, np.ndarray):
            if feature.dtype != np.float32:
                return feature.astype(np.float32, copy=False)
            return feature
        return feature

    infer_module.extract_bert_feature = extract_bert_feature_fp32
    infer_module._airi_fp32_guard_installed = True
    logger.info("installed fp32 guard for style_bert_vits2 inference")


def clamp(value: float, low: float, high: float) -> float:
    return min(high, max(low, value))


def first_or_default(values: dict[str, list[str]], key: str, default: str) -> str:
    v = values.get(key)
    if not v:
        return default
    value = v[0].strip()
    return value if value else default


def to_int(values: dict[str, list[str]], key: str, default: int, min_value: int = 0) -> int:
    raw = first_or_default(values, key, str(default))
    try:
        parsed = int(raw)
    except Exception:
        parsed = default
    return max(min_value, parsed)


def to_float(values: dict[str, list[str]], key: str, default: float, low: float, high: float) -> float:
    raw = first_or_default(values, key, str(default))
    try:
        parsed = float(raw)
    except Exception:
        parsed = default
    return clamp(parsed, low, high)


def resolve_language(language: str) -> Languages:
    normalized = (language or "JP").upper()
    if normalized == "EN":
        return Languages.EN
    if normalized == "ZH":
        return Languages.ZH
    return Languages.JP


def wav_bytes_from_pcm16(sample_rate: int, audio: np.ndarray) -> bytes:
    pcm = audio.astype(np.int16, copy=False)
    with io.BytesIO() as buf:
        with wave.open(buf, "wb") as wav_writer:
            wav_writer.setnchannels(1)
            wav_writer.setsampwidth(2)
            wav_writer.setframerate(sample_rate)
            wav_writer.writeframes(pcm.tobytes())
        return buf.getvalue()


class Sbv2Runtime:
    def __init__(
        self,
        model_root: Path,
        device: str,
        model_name: str | None,
        model_file: str | None,
        jp_bert_repo: str,
    ) -> None:
        if not model_root.exists():
            raise FileNotFoundError(f"model root not found: {model_root}")

        self.jp_bert_repo = jp_bert_repo
        self._ensure_jp_bert_assets()

        self.holder = TTSModelHolder(model_root_dir=model_root, device=device)
        if not self.holder.model_names:
            raise RuntimeError(f"no models found under: {model_root}")

        self.model_name = model_name if model_name in self.holder.model_names else self.holder.model_names[0]
        if model_name and model_name not in self.holder.model_names:
            logger.warning("requested model_name '%s' not found, fallback to '%s'", model_name, self.model_name)

        self.model_file = self._resolve_model_file(self.model_name, model_file)
        self.current_model = self.holder.get_model(self.model_name, str(self.model_file))
        self.current_model.load()
        logger.info("loaded model: %s (%s)", self.model_name, self.model_file.name)

    def _ensure_jp_bert_assets(self) -> None:
        jp_default = DEFAULT_BERT_TOKENIZER_PATHS[Languages.JP]
        if jp_default.exists():
            return
        logger.info(
            "JP BERT assets not found at %s, preloading from %s",
            jp_default,
            self.jp_bert_repo,
        )
        # Preload with an explicit HF repo path to avoid default-path assertion.
        # Once loaded, style_bert_vits2 reuses in-memory caches for inference.
        bert_models.load_tokenizer(
            Languages.JP, pretrained_model_name_or_path=self.jp_bert_repo
        )
        bert_models.load_model(
            Languages.JP, pretrained_model_name_or_path=self.jp_bert_repo
        )
        logger.info("JP BERT assets are ready")

    def _resolve_model_file(self, model_name: str, model_file: str | None) -> Path:
        files = self.holder.model_files_dict[model_name]
        if model_file:
            candidate = Path(model_file)
            for f in files:
                if f.name == candidate.name or str(f) == str(candidate):
                    return f
            logger.warning("requested model_file '%s' not found in '%s', fallback to first file", model_file, model_name)
        return files[0]

    def get_model_by_id(self, model_id: int) -> tuple[str, TTSModel]:
        model_index = clamp(model_id, 0, max(0, len(self.holder.model_names) - 1))
        model_name = self.holder.model_names[int(model_index)]
        if model_name == self.model_name:
            return model_name, self.current_model

        model_file = self._resolve_model_file(model_name, None)
        model = self.holder.get_model(model_name, str(model_file))
        model.load()
        self.model_name = model_name
        self.model_file = model_file
        self.current_model = model
        logger.info("switched model: %s (%s)", model_name, model_file.name)
        return model_name, model


def make_handler(runtime: Sbv2Runtime):
    class Handler(BaseHTTPRequestHandler):
        def _send_json(self, status: int, payload: dict) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("content-type", "application/json; charset=utf-8")
            self.send_header("content-length", str(len(body)))
            self.send_header("access-control-allow-origin", "*")
            self.end_headers()
            self.wfile.write(body)

        def _send_wav(self, wav_data: bytes) -> None:
            self.send_response(200)
            self.send_header("content-type", "audio/wav")
            self.send_header("content-length", str(len(wav_data)))
            self.send_header("access-control-allow-origin", "*")
            self.end_headers()
            self.wfile.write(wav_data)

        def do_OPTIONS(self) -> None:
            self.send_response(204)
            self.send_header("access-control-allow-origin", "*")
            self.send_header("access-control-allow-methods", "GET, OPTIONS")
            self.send_header("access-control-allow-headers", "*")
            self.end_headers()

        def do_GET(self) -> None:
            try:
                parsed = urlparse(self.path)
                if parsed.path == "/health":
                    self._send_json(
                        200,
                        {
                            "ok": True,
                            "provider": "style-bert-vits2",
                            "model_name": runtime.model_name,
                            "model_file": runtime.model_file.name,
                        },
                    )
                    return

                if parsed.path != "/voice":
                    self._send_json(404, {"error": "not found"})
                    return

                query = parse_qs(parsed.query)
                text = first_or_default(query, "text", "")
                if not text:
                    self._send_json(400, {"error": "text is required"})
                    return

                model_id = to_int(query, "model_id", 0, min_value=0)
                speaker_id = to_int(query, "speaker_id", 0, min_value=0)
                style = first_or_default(query, "style", "Neutral")
                style_weight = to_float(query, "style_weight", 1.0, 0.1, 10.0)
                sdp_ratio = to_float(query, "sdp_ratio", 0.2, 0.0, 1.0)
                noise = to_float(query, "noise", 0.6, 0.0, 2.0)
                noise_w = to_float(query, "noise_w", 0.8, 0.0, 2.0)
                length = to_float(query, "length", 1.0, 0.1, 3.0)
                language = resolve_language(first_or_default(query, "language", "JP"))

                _, model = runtime.get_model_by_id(model_id)
                available_styles = list(model.style2id.keys())
                if style not in model.style2id:
                    style = available_styles[0]

                sample_rate, audio = model.infer(
                    text=text,
                    language=language,
                    speaker_id=speaker_id,
                    sdp_ratio=sdp_ratio,
                    noise=noise,
                    noise_w=noise_w,
                    length=length,
                    style=style,
                    style_weight=style_weight,
                )
                wav_data = wav_bytes_from_pcm16(sample_rate, audio)
                self._send_wav(wav_data)
            except Exception as exc:
                logger.exception("voice generation failed")
                self._send_json(500, {"error": str(exc)})

        def log_message(self, format: str, *args) -> None:  # noqa: A003
            logger.info("%s - %s", self.address_string(), format % args)

    return Handler


def detect_device(prefer: str) -> str:
    p = prefer.strip().lower()
    if p in {"cpu", "cuda"}:
        if p == "cuda" and not torch.cuda.is_available():
            logger.warning("cuda requested but unavailable, fallback to cpu")
            return "cpu"
        return p
    return "cuda" if torch.cuda.is_available() else "cpu"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=5000)
    parser.add_argument("--model-root", default=str(Path(__file__).resolve().parent / "sbv2-models"))
    parser.add_argument("--model-name", default="")
    parser.add_argument("--model-file", default="")
    parser.add_argument("--jp-bert-repo", default="ku-nlp/deberta-v2-large-japanese-char-wwm")
    parser.add_argument("--device", default="auto")
    parser.add_argument("--log-level", default="INFO")
    args = parser.parse_args()

    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s [%(levelname)s] %(message)s",
    )
    install_fp32_guard()

    model_root = Path(args.model_root)
    model_name = args.model_name.strip() or None
    model_file = args.model_file.strip() or None
    device = detect_device(args.device)
    logger.info("starting sbv2 server on http://%s:%s (device=%s)", args.host, args.port, device)
    logger.info("model_root=%s", model_root)

    runtime = Sbv2Runtime(
        model_root=model_root,
        device=device,
        model_name=model_name,
        model_file=model_file,
        jp_bert_repo=args.jp_bert_repo.strip(),
    )
    server = ThreadingHTTPServer((args.host, args.port), make_handler(runtime))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
