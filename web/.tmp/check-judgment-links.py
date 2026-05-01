import json
import re


def main():
    rows = []
    with open("web/.tmp/jw-norway-metadata.jsonl", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue

    needles = [
        "domstol",
        "lovdata",
        "hoyesterett",
        "supremecourt",
        "court",
        "judgment",
        "judgement",
        "verdict",
        ".pdf",
    ]

    for r in rows:
        vid = r.get("id")
        title = r.get("title")
        url = r.get("webpage_url")
        desc = r.get("description") or ""
        links = re.findall(r"https?://[^\s)\]>\"]+", desc)
        judgment_like = [u for u in links if any(n in u.lower() for n in needles)]
        print("---")
        print(vid)
        print(title)
        print(url)
        print(f"links_total={len(links)}")
        if judgment_like:
            print("judgment_like_links:")
            for link in judgment_like:
                print(link)
        else:
            print("judgment_like_links=none")


if __name__ == "__main__":
    main()
