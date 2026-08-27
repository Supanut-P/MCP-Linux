from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE_PATH = REPOSITORY_ROOT / "assets" / "logo" / "logo.png"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate baitonghub-linux-mcp Linux documentation logo assets.")
    parser.add_argument(
        "--source",
        type=Path,
        default=DEFAULT_SOURCE_PATH,
        help="Master PNG source image (defaults to assets/logo/logo.png).",
    )
    parser.add_argument(
        "--workspace-root",
        type=Path,
        default=REPOSITORY_ROOT,
        help="Repository root to receive generated assets.",
    )
    return parser.parse_args()


def generate(source_path: Path, workspace_root: Path) -> None:
    source_path = source_path.expanduser().resolve()
    workspace_root = workspace_root.expanduser().resolve()
    if not source_path.is_file():
        raise FileNotFoundError(f"Source file not found: {source_path}")

    img = Image.open(source_path).convert("RGBA")
    print(f"Loaded master logo: {img.size} {img.mode}")

    assets_dir = workspace_root / "assets" / "logo"
    assets_dir.mkdir(parents=True, exist_ok=True)

    sizes = [16, 24, 32, 48, 64, 96, 128, 180, 192, 256, 384, 512, 1024]

    img.save(assets_dir / "logo.png", format="PNG", optimize=True)

    for size in sizes:
        resized = img.resize((size, size), Image.Resampling.LANCZOS)
        resized.save(assets_dir / f"logo-{size}x{size}.png", format="PNG", optimize=True)
        if size == 180:
            resized.save(assets_dir / "apple-touch-icon.png", format="PNG", optimize=True)
        elif size == 192:
            resized.save(assets_dir / "android-chrome-192x192.png", format="PNG", optimize=True)
        elif size == 512:
            resized.save(assets_dir / "android-chrome-512x512.png", format="PNG", optimize=True)

    img.resize((150, 150), Image.Resampling.LANCZOS).save(
        assets_dir / "mstile-150x150.png",
        format="PNG",
        optimize=True,
    )

    bg = Image.new("RGBA", (1200, 630), (14, 15, 20, 255))
    logo_banner_size = 440
    logo_banner = img.resize((logo_banner_size, logo_banner_size), Image.Resampling.LANCZOS)
    pos_x = (1200 - logo_banner_size) // 2
    pos_y = (630 - logo_banner_size) // 2
    bg.paste(logo_banner, (pos_x, pos_y), logo_banner)
    bg.save(assets_dir / "og-banner-1200x630.png", format="PNG", optimize=True)

    manifest_content = """{
  "name": "baitonghub-linux-mcp",
  "short_name": "baitonghub-linux-mcp",
  "icons": [
    {
      "src": "/favicon-16x16.png",
      "sizes": "16x16",
      "type": "image/png"
    },
    {
      "src": "/favicon-32x32.png",
      "sizes": "32x32",
      "type": "image/png"
    },
    {
      "src": "/logo-192.png",
      "sizes": "192x192",
      "type": "image/png"
    },
    {
      "src": "/logo-512.png",
      "sizes": "512x512",
      "type": "image/png"
    }
  ],
  "theme_color": "#0e0f14",
  "background_color": "#0e0f14",
  "display": "standalone"
}
"""
    (renderer_public_dir / "site.webmanifest").write_text(manifest_content, encoding="utf-8")
    (assets_dir / "site.webmanifest").write_text(manifest_content, encoding="utf-8")

    print("Linux documentation logo assets generated successfully!")


if __name__ == "__main__":
    args = parse_args()
    generate(args.source, args.workspace_root)
