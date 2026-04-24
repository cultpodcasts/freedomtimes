import argparse
import json
import re
import shutil
from pathlib import Path

import fitz

DEFAULT_INPUT_DIR = Path(r"C:\Users\jonbr\source\repos\freedom-times-content\original-freedom-times-pdf\split")
DEFAULT_OUTPUT_DIR = Path(".generated/archive-import")
DEFAULT_COVERS_DIR = "covers"
DEFAULT_TEXT_DIR = "text"
ABSTRACT_MIN = 80
ABSTRACT_MAX = 320


def slug_to_title(slug: str) -> str:
    parts = slug.split("-")
    return " ".join(part.upper() if part.isupper() else part.capitalize() for part in parts)


def date_from_filename(filename: str) -> str:
    match = re.match(r"^(\d{4}-\d{2}-\d{2})", filename)
    if not match:
        raise ValueError(f"Could not extract date from filename: {filename}")
    return f"{match.group(1)}T00:00:00.000Z"


def sanitize_segment(value: str) -> str:
    cleaned = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return cleaned or "unknown"


def derive_edition_metadata(slug: str) -> tuple[str, str]:
    tokens = slug.split("-")
    body_tokens = tokens[3:]

    freedom_times_idx = -1
    for idx in range(len(body_tokens) - 1):
        if body_tokens[idx] == "freedom" and body_tokens[idx + 1] == "times":
            freedom_times_idx = idx
            break

    prefix = body_tokens[:freedom_times_idx] if freedom_times_idx >= 0 else body_tokens
    volume_name = "main-edition"
    regional_variant = "default"

    volume_idx = -1
    for idx, token in enumerate(prefix):
        if re.match(r"^vol(?:ume)?(?:-?\d+)?$", token, flags=re.IGNORECASE):
            volume_idx = idx
            break

    if volume_idx >= 0:
        second = prefix[volume_idx + 1] if volume_idx + 1 < len(prefix) else ""
        volume_name = f"{prefix[volume_idx]}-{second}" if second else prefix[volume_idx]

    regional_tokens = [
        token
        for idx, token in enumerate(prefix)
        if idx not in (volume_idx, volume_idx + 1)
    ]
    if regional_tokens:
        regional_variant = "-".join(regional_tokens)

    return sanitize_segment(volume_name), sanitize_segment(regional_variant)


def sanitize_text(value: str) -> str:
    value = value.replace("\r", "\n").replace("\x00", " ")
    value = re.sub(r"[ \t]+", " ", value)
    value = re.sub(r"\n{3,}", "\n\n", value)
    return value.strip()


def build_draft_abstract(text: str, fallback_date: str) -> str:
    lines = [line.strip() for line in sanitize_text(text).splitlines()]
    lines = [line for line in lines if len(line) > 30]
    lines = [line for line in lines if not re.match(r"^page\s+\d+$", line, flags=re.IGNORECASE)]
    lines = [line for line in lines if line.lower() != "freedom times"]

    joined = re.sub(r"\s+", " ", " ".join(lines)).strip()
    if not joined:
        return f"Archive issue for {fallback_date}."

    sentence_match = re.search(r"(.{80,320}?[.!?])(?=\s|$)", joined)
    candidate = sentence_match.group(1) if sentence_match else joined[:ABSTRACT_MAX]
    return candidate.strip()


def extract_pdf_text(document: fitz.Document) -> str:
    chunks: list[str] = []
    for page in document:
        chunks.append(page.get_text("text"))
    return sanitize_text("\n\n".join(chunks))


def render_all_pages(document: fitz.Document, output_dir: Path, base_name: str) -> list[Path]:
    page_paths: list[Path] = []
    for idx, page in enumerate(document, start=1):
        filename = f"{base_name}--page-{idx:03d}.png"
        output_path = output_dir / filename
        pix = page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False)
        pix.save(output_path)
        page_paths.append(output_path)
    return page_paths


def process_pdf(pdf_path: Path, covers_dir: Path, text_dir: Path) -> dict:
    slug = pdf_path.stem
    date_iso = date_from_filename(pdf_path.name)
    date_only = date_iso[:10]
    title = slug_to_title(slug)
    volume_name, regional_variant = derive_edition_metadata(slug)
    image_base_name = f"{slug}--vol-{volume_name}--region-{regional_variant}"

    cover_path = covers_dir / f"{image_base_name}--page-001.png"
    text_path = text_dir / f"{slug}.txt"

    with fitz.open(pdf_path) as document:
        text = extract_pdf_text(document)
        page_paths = render_all_pages(document, covers_dir, image_base_name)

    text_path.write_text(text, encoding="utf-8")

    if not page_paths:
        raise ValueError(f"PDF has no pages to render: {pdf_path}")

    return {
        "title": title,
        "slug": slug,
        "date": date_iso,
        "volumeName": volume_name,
        "regionalVariant": regional_variant,
        "sourcePdf": str(pdf_path),
        "coverImage": str(cover_path),
        "pageImages": [str(path) for path in page_paths],
        "extractedText": str(text_path),
        "draftAbstract": build_draft_abstract(text, date_only),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", default=str(DEFAULT_INPUT_DIR))
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT_DIR))
    args = parser.parse_args()

    input_dir = Path(args.input).resolve()
    output_dir = Path(args.output).resolve()
    covers_dir = output_dir / DEFAULT_COVERS_DIR
    text_dir = output_dir / DEFAULT_TEXT_DIR

    if not input_dir.is_dir():
        raise ValueError(f"Input path is not a directory: {input_dir}")

    if output_dir.exists():
        shutil.rmtree(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    covers_dir.mkdir(parents=True, exist_ok=True)
    text_dir.mkdir(parents=True, exist_ok=True)

    pdf_files = sorted(input_dir.glob("*.pdf"))
    if not pdf_files:
        raise ValueError(f"No PDFs found in {input_dir}")

    records = []
    for pdf_file in pdf_files:
        record = process_pdf(pdf_file, covers_dir, text_dir)
        records.append(record)
        print(f"Prepared {pdf_file.name}")

    manifest_path = output_dir / "manifest.json"
    manifest_path.write_text(json.dumps(records, indent=2), encoding="utf-8")
    print(f"Prepared {len(records)} archive PDFs into {output_dir}")


if __name__ == "__main__":
    main()
