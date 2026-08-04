#!/usr/bin/env python3
"""
Minimal Irodori-TTS HTTP server compatible with minecraft-bot local TTS.

Endpoints:
  - GET /health
  - GET /unload
  - GET /voice?text=...&caption=...&hf_checkpoint=...
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import wave
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse


logger = logging.getLogger("irodori-http")
FIXED_SECONDS = 30.0


def first_or_default(values: dict[str, list[str]], key: str, default: str) -> str:
    found = values.get(key)
    if not found:
        return default
    value = found[0].strip()
    return value if value else default


def to_int_or_none(raw: str | None) -> int | None:
    if raw is None:
        return None
    text = str(raw).strip()
    if text == "":
        return None
    return int(text)


def to_float_or_none(raw: str | None) -> float | None:
    if raw is None:
        return None
    text = str(raw).strip()
    if text == "":
        return None
    return float(text)


def resolve_repo_dir(value: str | None) -> Path | None:
    candidate = (value or os.environ.get("IRODORI_TTS_REPO", "")).strip()
    if candidate != "":
        path = Path(candidate).expanduser().resolve()
        if not path.exists():
            raise FileNotFoundError(f"Irodori-TTS repo dir not found: {path}")
        return path

    repo_candidates = [
        Path(__file__).resolve().parents[1] / ".cache" / "Irodori-TTS-inspect",
        Path(__file__).resolve().parent / "Irodori-TTS",
        Path.cwd() / ".cache" / "Irodori-TTS-inspect",
    ]
    for path in repo_candidates:
        if path.exists():
            return path.resolve()

    return None


def load_irodori_symbols(repo_dir: Path | None) -> dict[str, Any]:
    if repo_dir is not None:
        sys.path.insert(0, str(repo_dir))

    try:
        from huggingface_hub import hf_hub_download
        from irodori_tts.inference_runtime import (
            RuntimeKey,
            SamplingRequest,
            clear_cached_runtime,
            default_runtime_device,
            get_cached_runtime,
        )
    except ImportError as exc:
        repo_hint = f" or set --repo-dir to a local Irodori-TTS checkout" if repo_dir is None else ""
        raise RuntimeError(
            "Failed to import Irodori-TTS runtime dependencies. "
            "Install the package/dependencies in this Python environment"
            f"{repo_hint}."
        ) from exc

    return {
        "hf_hub_download": hf_hub_download,
        "RuntimeKey": RuntimeKey,
        "SamplingRequest": SamplingRequest,
        "clear_cached_runtime": clear_cached_runtime,
        "default_runtime_device": default_runtime_device,
        "get_cached_runtime": get_cached_runtime,
    }


def resolve_default_device(value: str, default_runtime_device: Any) -> str:
    normalized = value.strip().lower()
    if normalized == "auto":
        return str(default_runtime_device())
    return value


def wav_bytes_from_audio(audio: Any, sample_rate: int) -> bytes:
    import torch

    pcm = (
        audio.squeeze(0)
        .detach()
        .cpu()
        .clamp(-1.0, 1.0)
        .mul(32767.0)
        .round()
        .to(dtype=torch.int16)
    )

    with BytesIO() as buffer:
        with wave.open(buffer, "wb") as wav_writer:
            wav_writer.setnchannels(1)
            wav_writer.setsampwidth(2)
            wav_writer.setframerate(sample_rate)
            wav_writer.writeframes(pcm.numpy().tobytes())
        return buffer.getvalue()


def resolve_checkpoint_path(config: "ServerConfig", values: dict[str, list[str]]) -> str:
    local_checkpoint = first_or_default(values, "checkpoint", config.checkpoint or "")
    if local_checkpoint:
        path = Path(local_checkpoint).expanduser().resolve()
        if not path.is_file():
            raise FileNotFoundError(f"checkpoint not found: {path}")
        return str(path)

    hf_checkpoint = first_or_default(values, "hf_checkpoint", config.hf_checkpoint or "")
    if not hf_checkpoint:
        raise ValueError("Either checkpoint or hf_checkpoint must be configured.")

    return str(config.hf_hub_download(repo_id=hf_checkpoint, filename="model.safetensors"))


@dataclass(frozen=True)
class ServerConfig:
    host: str
    port: int
    checkpoint: str | None
    hf_checkpoint: str | None
    codec_repo: str
    model_device: str
    codec_device: str
    model_precision: str
    codec_precision: str
    enable_watermark: bool
    default_caption: str
    num_steps: int
    cfg_guidance_mode: str
    cfg_scale_text: float
    cfg_scale_caption: float
    cfg_min_t: float
    cfg_max_t: float
    context_kv_cache: bool
    truncation_factor: float | None
    rescale_k: float | None
    rescale_sigma: float | None
    seed: int | None
    RuntimeKey: Any
    SamplingRequest: Any
    clear_cached_runtime: Any
    get_cached_runtime: Any
    hf_hub_download: Any
    unload_after_request: bool


def make_handler(config: ServerConfig):
    class Handler(BaseHTTPRequestHandler):
        def _send_json(self, status: int, payload: dict[str, Any]) -> None:
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
                            "provider": "irodori-tts",
                            "hf_checkpoint": config.hf_checkpoint,
                            "checkpoint": config.checkpoint,
                            "model_device": config.model_device,
                            "codec_device": config.codec_device,
                            "unload_after_request": config.unload_after_request,
                        },
                    )
                    return

                if parsed.path == "/unload":
                    config.clear_cached_runtime()
                    self._send_json(200, {"ok": True, "unloaded": True})
                    return

                if parsed.path != "/voice":
                    self._send_json(404, {"error": "not found"})
                    return

                values = parse_qs(parsed.query)
                text = first_or_default(values, "text", "")
                if text == "":
                    self._send_json(400, {"error": "text is required"})
                    return

                checkpoint_path = resolve_checkpoint_path(config, values)
                caption = first_or_default(values, "caption", config.default_caption)
                request_seed = to_int_or_none(first_or_default(values, "seed", ""))
                runtime_key = config.RuntimeKey(
                    checkpoint=checkpoint_path,
                    model_device=config.model_device,
                    codec_repo=config.codec_repo,
                    model_precision=config.model_precision,
                    codec_device=config.codec_device,
                    codec_precision=config.codec_precision,
                    enable_watermark=config.enable_watermark,
                    compile_model=False,
                    compile_dynamic=False,
                )
                runtime, reloaded = config.get_cached_runtime(runtime_key)
                logger.info(
                    "voice request checkpoint=%s reloaded=%s caption=%s",
                    checkpoint_path,
                    reloaded,
                    "on" if caption else "off",
                )

                try:
                    result = runtime.synthesize(
                        config.SamplingRequest(
                            text=text,
                            caption=caption or None,
                            ref_wav=None,
                            ref_latent=None,
                            no_ref=True,
                            ref_normalize_db=-16.0,
                            ref_ensure_max=True,
                            num_candidates=1,
                            decode_mode="sequential",
                            seconds=FIXED_SECONDS,
                            max_ref_seconds=30.0,
                            max_text_len=None,
                            max_caption_len=None,
                            num_steps=config.num_steps,
                            cfg_scale_text=config.cfg_scale_text,
                            cfg_scale_caption=config.cfg_scale_caption,
                            cfg_scale_speaker=0.0,
                            cfg_guidance_mode=config.cfg_guidance_mode,
                            cfg_scale=None,
                            cfg_min_t=config.cfg_min_t,
                            cfg_max_t=config.cfg_max_t,
                            truncation_factor=config.truncation_factor,
                            rescale_k=config.rescale_k,
                            rescale_sigma=config.rescale_sigma,
                            context_kv_cache=config.context_kv_cache,
                            speaker_kv_scale=None,
                            speaker_kv_min_t=None,
                            speaker_kv_max_layers=None,
                            seed=request_seed if request_seed is not None else config.seed,
                            trim_tail=True,
                        ),
                        log_fn=logger.info,
                    )

                    self._send_wav(wav_bytes_from_audio(result.audio, result.sample_rate))
                finally:
                    if config.unload_after_request:
                        logger.info("unloading cached runtime after voice request")
                        config.clear_cached_runtime()
            except Exception as exc:  # noqa: BLE001
                logger.exception("voice generation failed")
                self._send_json(500, {"error": str(exc)})

        def log_message(self, format: str, *args) -> None:  # noqa: A003
            logger.info("%s - %s", self.address_string(), format % args)

    return Handler


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=5000)
    parser.add_argument("--repo-dir", default="")
    parser.add_argument("--checkpoint", default="")
    parser.add_argument(
        "--hf-checkpoint",
        default="Aratako/Irodori-TTS-500M-v2-VoiceDesign",
    )
    parser.add_argument("--codec-repo", default="Aratako/Semantic-DACVAE-Japanese-32dim")
    parser.add_argument("--model-device", default="auto")
    parser.add_argument("--codec-device", default="auto")
    parser.add_argument("--model-precision", choices=["fp32", "bf16"], default="fp32")
    parser.add_argument("--codec-precision", choices=["fp32", "bf16"], default="fp32")
    parser.add_argument("--enable-watermark", action=argparse.BooleanOptionalAction, default=False)
    parser.add_argument("--default-caption", default="")
    parser.add_argument("--num-steps", type=int, default=24)
    parser.add_argument(
        "--cfg-guidance-mode",
        choices=["independent", "joint", "alternating"],
        default="independent",
    )
    parser.add_argument("--cfg-scale-text", type=float, default=2.0)
    parser.add_argument("--cfg-scale-caption", type=float, default=4.0)
    parser.add_argument("--cfg-min-t", type=float, default=0.5)
    parser.add_argument("--cfg-max-t", type=float, default=1.0)
    parser.add_argument("--context-kv-cache", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--unload-after-request", action=argparse.BooleanOptionalAction, default=False)
    parser.add_argument("--truncation-factor", type=float, default=None)
    parser.add_argument("--rescale-k", type=float, default=None)
    parser.add_argument("--rescale-sigma", type=float, default=None)
    parser.add_argument("--seed", type=int, default=None)
    parser.add_argument("--log-level", default="INFO")
    args = parser.parse_args()

    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s [%(levelname)s] %(message)s",
    )

    repo_dir = resolve_repo_dir(args.repo_dir)
    symbols = load_irodori_symbols(repo_dir)
    default_runtime_device = symbols["default_runtime_device"]

    config = ServerConfig(
        host=args.host,
        port=int(args.port),
        checkpoint=args.checkpoint.strip() or None,
        hf_checkpoint=args.hf_checkpoint.strip() or None,
        codec_repo=args.codec_repo.strip(),
        model_device=resolve_default_device(args.model_device, default_runtime_device),
        codec_device=resolve_default_device(args.codec_device, default_runtime_device),
        model_precision=args.model_precision,
        codec_precision=args.codec_precision,
        enable_watermark=bool(args.enable_watermark),
        default_caption=args.default_caption,
        num_steps=int(args.num_steps),
        cfg_guidance_mode=args.cfg_guidance_mode,
        cfg_scale_text=float(args.cfg_scale_text),
        cfg_scale_caption=float(args.cfg_scale_caption),
        cfg_min_t=float(args.cfg_min_t),
        cfg_max_t=float(args.cfg_max_t),
        context_kv_cache=bool(args.context_kv_cache),
        truncation_factor=to_float_or_none(args.truncation_factor),
        rescale_k=to_float_or_none(args.rescale_k),
        rescale_sigma=to_float_or_none(args.rescale_sigma),
        seed=to_int_or_none(args.seed),
        RuntimeKey=symbols["RuntimeKey"],
        SamplingRequest=symbols["SamplingRequest"],
        clear_cached_runtime=symbols["clear_cached_runtime"],
        get_cached_runtime=symbols["get_cached_runtime"],
        hf_hub_download=symbols["hf_hub_download"],
        unload_after_request=bool(args.unload_after_request),
    )

    logger.info(
        "starting irodori server on http://%s:%s (model_device=%s codec_device=%s)",
        config.host,
        config.port,
        config.model_device,
        config.codec_device,
    )
    if repo_dir is not None:
        logger.info("repo_dir=%s", repo_dir)
    if config.checkpoint:
        logger.info("checkpoint=%s", config.checkpoint)
    else:
        logger.info("hf_checkpoint=%s", config.hf_checkpoint)

    server = ThreadingHTTPServer((config.host, config.port), make_handler(config))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
