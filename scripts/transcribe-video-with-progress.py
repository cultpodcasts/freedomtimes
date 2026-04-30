from __future__ import annotations

import argparse
import time
from pathlib import Path

import av
from faster_whisper import WhisperModel


def fmt_hms(seconds: float) -> str:
    total = max(0, int(seconds))
    h = total // 3600
    m = (total % 3600) // 60
    s = total % 60
    return f"{h:02d}:{m:02d}:{s:02d}"


def fmt_ts(seconds: float) -> str:
    total_ms = int(round(seconds * 1000))
    hrs = total_ms // 3_600_000
    rem = total_ms % 3_600_000
    mins = rem // 60_000
    rem %= 60_000
    secs = rem // 1000
    ms = rem % 1000
    return f"{hrs:02d}:{mins:02d}:{secs:02d}.{ms:03d}"


def read_duration_seconds(media_path: Path) -> float:
    with av.open(str(media_path)) as container:
        if container.duration:
            # PyAV duration is in microseconds.
            return float(container.duration / 1_000_000)
    return 0.0


def main() -> int:
    parser = argparse.ArgumentParser(description="Transcribe video with live progress updates.")
    parser.add_argument("--input", required=True, help="Input media path")
    parser.add_argument("--output", required=True, help="Output markdown path")
    parser.add_argument("--model", default="medium", help="faster-whisper model size")
    parser.add_argument("--language", default="en", help="Language code")
    args = parser.parse_args()

    input_path = Path(args.input).resolve()
    output_path = Path(args.output).resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)

    total_seconds = read_duration_seconds(input_path)
    model = WhisperModel(args.model, device="cpu", compute_type="int8")

    start_wall = time.time()
    last_percent_bucket = -1

    segments, info = model.transcribe(
        str(input_path),
        language=args.language,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 450},
        beam_size=5,
    )

    lines: list[str] = []
    lines.append("# Transcript (Auto-generated)")
    lines.append("")
    lines.append(f"- Source: {input_path}")
    lines.append(f"- Language detected: {info.language} (p={info.language_probability:.2f})")
    if total_seconds > 0:
        lines.append(f"- Duration: {fmt_hms(total_seconds)}")
    lines.append("")

    for seg in segments:
        text = seg.text.strip()
        if text:
            lines.append(f"[{fmt_ts(seg.start)} - {fmt_ts(seg.end)}] {text}")

        if total_seconds > 0:
            percent = min(100.0, (float(seg.end) / total_seconds) * 100.0)
            bucket = int(percent)
            if bucket > last_percent_bucket:
                elapsed = time.time() - start_wall
                print(
                    f"progress={percent:5.1f}% file={fmt_hms(seg.end)}/{fmt_hms(total_seconds)} elapsed={fmt_hms(elapsed)}"
                    ,
                    flush=True,
                )
                last_percent_bucket = bucket

    output_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    elapsed_total = time.time() - start_wall
    print(
        f"done=100.0% file={fmt_hms(total_seconds)}/{fmt_hms(total_seconds)} elapsed={fmt_hms(elapsed_total)}",
        flush=True,
    )
    print(f"wrote={output_path}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
