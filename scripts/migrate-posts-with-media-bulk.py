#!/usr/bin/env python3
import argparse
import json
import mimetypes
import re
import subprocess
from pathlib import Path
from urllib.request import Request, urlopen


MEDIA_PATH_RE = re.compile(r"(/_emdash/api/media/file/([A-Za-z0-9]+)\.([A-Za-z0-9]+))")


def run_cmd(args: list[str]) -> str:
    proc = subprocess.run(args, capture_output=True, text=True, encoding="utf-8")
    if proc.returncode != 0:
        raise RuntimeError(
            f"Command failed ({proc.returncode}): {' '.join(args)}\n{proc.stdout}\n{proc.stderr}"
        )
    return proc.stdout.strip()


def run_cmd_json(args: list[str]) -> dict:
    out = run_cmd(args)
    if not out:
        return {}
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        start = out.find("{")
        end = out.rfind("}")
        if start != -1 and end != -1 and end > start:
            return json.loads(out[start : end + 1])
        raise


def emdash_json(base_args: list[str]) -> dict:
    return run_cmd_json(["npx", "--prefix", "web", "emdash"] + base_args)


def read_emdash_token(url: str) -> str:
    auth_path = Path.home() / ".config" / "emdash" / "auth.json"
    auth = json.loads(auth_path.read_text(encoding="utf-8"))
    token = auth.get(url, {}).get("accessToken")
    if not token:
        raise RuntimeError(f"No stored EmDash token for {url}")
    return token


def download_media_file(url: str, token: str, destination: Path) -> None:
    escaped_dest = str(destination).replace("'", "''")
    ps_cmd = (
        "$ProgressPreference='SilentlyContinue'; "
        f"Invoke-WebRequest -Uri '{url}' -OutFile '{escaped_dest}' -TimeoutSec 120"
    )
    proc = subprocess.run(["pwsh", "-NoProfile", "-Command", ps_cmd], capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"Download failed for {url}: {proc.stdout}\n{proc.stderr}")


def collect_media_refs(post: dict) -> tuple[set[tuple[str, str, str]], str | None]:
    refs: set[tuple[str, str, str]] = set()
    featured_id: str | None = None
    featured_image = post.get("data", {}).get("featured_image")
    if isinstance(featured_image, dict):
        maybe_id = featured_image.get("id")
        provider = featured_image.get("provider")
        if provider == "local" and isinstance(maybe_id, str) and maybe_id:
            featured_id = maybe_id

    content = post.get("data", {}).get("content", "")
    if isinstance(content, str):
        for full_path, file_key, ext in MEDIA_PATH_RE.findall(content):
            refs.add((full_path, file_key, ext))
    return refs, featured_id


def ensure_ext(filename: str, mime_type: str | None) -> str:
    ext = Path(filename).suffix
    if ext:
        return ext.lower()
    guessed = mimetypes.guess_extension(mime_type or "")
    return (guessed or ".bin").lower()


def migrate_one_post(slug: str, staging_url: str, production_url: str, workdir: Path) -> dict:
    staging_token = read_emdash_token(staging_url)
    staging_post = emdash_json(
        ["content", "get", "posts", slug, "--published", "-u", staging_url, "--json"]
    )
    content_media_refs, featured_id = collect_media_refs(staging_post)

    media_map: dict[str, str] = {}
    media_dir = workdir / slug / "media"
    media_dir.mkdir(parents=True, exist_ok=True)

    # Migrate featured image via media record when available.
    featured_media_upload = None
    if featured_id:
        staging_media = emdash_json(["media", "get", featured_id, "-u", staging_url, "--json"])
        filename = staging_media.get("filename", featured_id)
        ext = ensure_ext(filename, staging_media.get("mimeType"))
        storage_key = staging_media.get("storageKey") or f"{featured_id}{ext}"
        source_url = f"{staging_url}/_emdash/api/media/file/{storage_key}"
        local_file = media_dir / filename
        try:
            download_media_file(source_url, staging_token, local_file)
        except Exception:
            if featured_id == "01KQFR66Y8FMBE3XR23TCZGTKQ":
                local_file = Path(".tmp/crewe-story/cult-compound.png")
            else:
                raise
        upload_args = ["media", "upload", str(local_file), "-u", production_url, "--json"]
        alt = staging_media.get("alt")
        caption = staging_media.get("caption")
        if isinstance(alt, str) and alt.strip():
            upload_args += ["--alt", alt]
        if isinstance(caption, str) and caption.strip():
            upload_args += ["--caption", caption]
        featured_media_upload = emdash_json(upload_args)

    # Migrate all content-embedded media references by direct file URL.
    for full_path, file_key, ext in sorted(content_media_refs):
        source_url = f"{staging_url}/_emdash/api/media/file/{file_key}.{ext}"
        local_file = media_dir / f"{file_key}.{ext}"
        try:
            download_media_file(source_url, staging_token, local_file)
        except Exception:
            if file_key == "01KQFN5YQYKPMNBBAZKEF7FCPZ":
                local_file = Path(".tmp/crewe-story/channel4-embed.mp4")
            else:
                raise
        prod_media = emdash_json(["media", "upload", str(local_file), "-u", production_url, "--json"])
        media_map[full_path] = prod_media["url"]

    data = staging_post.get("data", {})
    content = data.get("content", "")
    if isinstance(content, str):
        for old_path, new_url in media_map.items():
            content = content.replace(old_path, new_url)

    payload = {
        "title": data.get("title", ""),
        "excerpt": data.get("excerpt", ""),
        "content": content,
    }
    if "subjects" in data:
        payload["subjects"] = data.get("subjects", [])
    if featured_media_upload:
        payload["featured_image"] = {"id": featured_media_upload["id"]}
    elif "featured_image" in data:
        payload["featured_image"] = data.get("featured_image")

    payload_path = workdir / slug / "payload.json"
    payload_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    try:
        prod_current = emdash_json(
            ["content", "get", "posts", slug, "-u", production_url, "--json"]
        )
        emdash_json(
            [
                "content",
                "update",
                "posts",
                slug,
                "--file",
                str(payload_path),
                "--rev",
                prod_current["_rev"],
                "-u",
                production_url,
                "--json",
            ]
        )
    except RuntimeError as err:
        if "Content item not found" not in str(err):
            raise
        emdash_json(
            [
                "content",
                "create",
                "posts",
                "--slug",
                slug,
                "--file",
                str(payload_path),
                "-u",
                production_url,
                "--json",
            ]
        )

    run_cmd(["npx", "--prefix", "web", "emdash", "content", "publish", "posts", slug, "-u", production_url])
    final_post = emdash_json(
        ["content", "get", "posts", slug, "--published", "-u", production_url, "--json"]
    )
    return {
        "slug": slug,
        "title": final_post.get("data", {}).get("title"),
        "media_migrated": len(media_map) + (1 if featured_media_upload else 0),
        "featured_image_id": final_post.get("data", {}).get("featured_image", {}).get("id"),
        "primaryBylineId_staging": staging_post.get("primaryBylineId"),
        "primaryBylineId_production": final_post.get("primaryBylineId"),
        "byline_display_staging": (staging_post.get("byline") or {}).get("displayName"),
        "byline_display_production": (final_post.get("byline") or {}).get("displayName"),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Bulk migrate posts with media remapping.")
    parser.add_argument("--staging-url", default="https://staging.freedomtimes.news")
    parser.add_argument("--production-url", default="https://freedomtimes.news")
    parser.add_argument("--workdir", default=".tmp/post-migration")
    parser.add_argument("--slugs", nargs="+", required=True)
    args = parser.parse_args()

    workdir = Path(args.workdir)
    workdir.mkdir(parents=True, exist_ok=True)
    summaries: list[dict] = []
    for slug in args.slugs:
        summaries.append(migrate_one_post(slug, args.staging_url, args.production_url, workdir))
    print(json.dumps({"migrated": summaries}, ensure_ascii=True, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
