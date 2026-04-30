#!/usr/bin/env python3
import argparse
import json
import subprocess
from pathlib import Path


def run_cmd(args: list[str]) -> str:
    proc = subprocess.run(args, capture_output=True, text=True, encoding="utf-8")
    if proc.returncode != 0:
        raise RuntimeError(f"Command failed ({proc.returncode}): {' '.join(args)}\n{proc.stdout}\n{proc.stderr}")
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


def main() -> int:
    parser = argparse.ArgumentParser(description="Migrate a post from staging to production with media remapping.")
    parser.add_argument("--slug", required=True, help="Post slug to migrate")
    parser.add_argument("--staging-url", default="https://staging.freedomtimes.news")
    parser.add_argument("--production-url", default="https://freedomtimes.news")
    parser.add_argument("--featured-image-path", required=True, help="Local file path for featured image")
    parser.add_argument("--channel4-video-path", required=True, help="Local file path for channel4 embed video")
    parser.add_argument("--workdir", default=".tmp/crewe-story", help="Working directory for generated files")
    args = parser.parse_args()

    workdir = Path(args.workdir)
    workdir.mkdir(parents=True, exist_ok=True)

    staging_post = run_cmd_json(
        [
            "npx",
            "--prefix",
            "web",
            "emdash",
            "content",
            "get",
            "posts",
            args.slug,
            "--published",
            "-u",
            args.staging_url,
            "--json",
        ]
    )

    image_upload = run_cmd_json(
        [
            "npx",
            "--prefix",
            "web",
            "emdash",
            "media",
            "upload",
            args.featured_image_path,
            "-u",
            args.production_url,
            "--alt",
            "ARPOL Crewe headquarters compound",
            "--caption",
            "Crewe compound image",
            "--json",
        ]
    )

    video_upload = run_cmd_json(
        [
            "npx",
            "--prefix",
            "web",
            "emdash",
            "media",
            "upload",
            args.channel4_video_path,
            "-u",
            args.production_url,
            "--alt",
            "Channel 4 report on allegations and raids in Crewe",
            "--caption",
            "Channel 4 News report",
            "--json",
        ]
    )

    data = staging_post["data"]
    content = data.get("content", "")
    content = content.replace(
        "/_emdash/api/media/file/01KQFN5YQYKPMNBBAZKEF7FCPZ.mp4",
        video_upload["url"],
    )
    content = content.replace(
        "In migration-related reporting history, Swedish authorities and courts were also cited in coverage around visa and residency issues tied to group-linked entities.",
        "In international reporting, Swedish authorities and courts were also cited in coverage around visa and residency issues tied to group-linked entities.",
    )

    payload = {
        "title": data.get("title", ""),
        "excerpt": (
            "From police convoys and gate-side footage in Crewe to aerial views of vans entering Webb House, "
            "this report tracks the 500-officer ARPOL raid, the allegations under investigation, and the prior "
            "allegations and public defense campaigns that shaped the story."
        ),
        "featured_image": {"id": image_upload["id"]},
        "subjects": data.get("subjects", []),
        "content": content,
    }

    payload_path = workdir / "production-migration-payload.json"
    payload_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    try:
        prod_current = run_cmd_json(
            [
                "npx",
                "--prefix",
                "web",
                "emdash",
                "content",
                "get",
                "posts",
                args.slug,
                "-u",
                args.production_url,
                "--json",
            ]
        )
        run_cmd_json(
            [
                "npx",
                "--prefix",
                "web",
                "emdash",
                "content",
                "update",
                "posts",
                args.slug,
                "--file",
                str(payload_path),
                "--rev",
                prod_current["_rev"],
                "-u",
                args.production_url,
                "--json",
            ]
        )
    except RuntimeError as err:
        if "Content item not found" not in str(err):
            raise
        run_cmd_json(
            [
                "npx",
                "--prefix",
                "web",
                "emdash",
                "content",
                "create",
                "posts",
                "--slug",
                args.slug,
                "--file",
                str(payload_path),
                "-u",
                args.production_url,
                "--json",
            ]
        )

    run_cmd(
        [
            "npx",
            "--prefix",
            "web",
            "emdash",
            "content",
            "publish",
            "posts",
            args.slug,
            "-u",
            args.production_url,
        ]
    )

    final_post = run_cmd_json(
        [
            "npx",
            "--prefix",
            "web",
            "emdash",
            "content",
            "get",
            "posts",
            args.slug,
            "--published",
            "-u",
            args.production_url,
            "--json",
        ]
    )
    summary = {
        "slug": final_post["slug"],
        "title": final_post["data"].get("title"),
        "featured_image_id": final_post["data"].get("featured_image", {}).get("id"),
        "content_has_prod_video_url": video_upload["url"] in final_post["data"].get("content", ""),
        "subjects": final_post["data"].get("subjects", []),
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
