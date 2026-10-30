import argparse
import json
from pathlib import Path
import subprocess


parser = argparse.ArgumentParser(description="Encode actual timestamped CDP frames without shortening recorded waits.")
parser.add_argument("manifest", type=Path)
parser.add_argument("output", type=Path)
args = parser.parse_args()
manifest = json.loads(args.manifest.read_text())
frames = manifest["frames"]
if not frames:
    raise SystemExit("The recording contains no frames.")
root = args.manifest.parent.resolve()
lines = ["ffconcat version 1.0"]
for index, frame in enumerate(frames):
    path = (root / frame["file"]).resolve()
    if not path.is_relative_to(root) or not path.is_file():
        raise SystemExit("The recording contains an invalid frame path.")
    timestamp = float(frame["timestamp"])
    end = float(frames[index + 1]["timestamp"]) if index + 1 < len(frames) else float(manifest.get("endedAt", timestamp + 2))
    if end < timestamp:
        raise SystemExit("Frame timestamps are not chronological.")
    escaped = str(path).replace("'", "'\\''")
    lines.extend([f"file '{escaped}'", f"duration {max(0.02, end - timestamp):.6f}"])
lines.append(f"file '{escaped}'")
concat = args.manifest.with_suffix(".ffconcat")
concat.write_text("\n".join(lines) + "\n")
args.output.parent.mkdir(parents=True, exist_ok=True)
subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-safe", "0", "-f", "concat", "-i", str(concat), "-vf", "scale=1280:900:force_original_aspect_ratio=decrease,pad=1280:900:(ow-iw)/2:(oh-ih)/2,setsar=1", "-fps_mode", "vfr", "-c:v", "libx264", "-crf", "22", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(args.output)], check=True)
print(json.dumps({"output": str(args.output.resolve()), "frames": len(frames), "recordedSeconds": round(float(manifest.get("endedAt", frames[-1]["timestamp"])) - float(frames[0]["timestamp"]), 2), "waitsShortened": False}))
