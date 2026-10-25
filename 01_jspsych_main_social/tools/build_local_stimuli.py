"""Generate a browser-readable CSV copy for solo previews opened as a local HTML file.

concepts.csv remains the source of truth. Run this after editing it; the selection
script also calls this automatically. Uses only Python's standard library.
"""
import json
from pathlib import Path


def main():
    experiment = Path(__file__).resolve().parents[1]
    source = experiment / "stimuli" / "concepts.csv"
    target = source.with_suffix(".js")
    payload = {"source": "stimuli/concepts.csv", "csv": source.read_text(encoding="utf-8-sig")}
    script = (
        "// Generated from concepts.csv by tools/build_local_stimuli.py. Do not edit by hand.\n"
        "// Used only for solo tests opened directly from the filesystem.\n"
        "var LOCAL_STIMULI = " + json.dumps(payload, ensure_ascii=False, indent=2) + ";\n"
    )
    target.write_text(script, encoding="utf-8", newline="\n")
    print(f"Updated {target.name} from {source.name}")


if __name__ == "__main__":
    main()
