#!/usr/bin/env python3
"""
从源图生成扩展图标。
源图：asserts/icon.png（若不存在则回退 assets/icon.png）
输出：src/icon-16/32/48/128.png、assets/icon-300.png、assets/icon-1024.png

依赖：pip install pillow
"""

from pathlib import Path
import sys
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent

# 源图路径：按顺序查找，先命中先用
SRC_CANDIDATES = [
    ROOT / "asserts" / "icon.png",
    ROOT / "assets" / "icon.png",
]

# 输出尺寸
SRC_SIZES = [16, 32, 48, 128]        # 放进 src/，manifest 引用
ASSET_SIZES = [300, 1024]            # 放进 assets/，商店素材备用

# 透明内边距比例（相对边长）。图形已自带留白时保持 0；
# 若想让图形四周额外留白，可改为 0.08 ~ 0.125
PADDING_RATIO = 0.0

# 目标尺寸小于该值时，源图必须至少这么大，否则视为不合适的源图
MIN_SRC_SIZE_FOR_SMALL = 128


def find_src() -> Path:
    for p in SRC_CANDIDATES:
        if p.is_file():
            return p
    tried = "\n  ".join(str(p) for p in SRC_CANDIDATES)
    sys.exit(f"未找到源图，已尝试：\n  {tried}")


def to_square(img: Image.Image) -> Image.Image:
    """居中裁成正方形；非正方形源图会被裁掉长边两侧。"""
    w, h = img.size
    side = min(w, h)
    left = (w - side) // 2
    top = (h - side) // 2
    return img.crop((left, top, left + side, top + side))


def render(src: Image.Image, size: int) -> Image.Image:
    inner = max(1, int(round(size * (1 - 2 * PADDING_RATIO))))
    resized = src.resize((inner, inner), Image.LANCZOS)

    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    offset = (size - inner) // 2
    # 用自身 alpha 作 mask，保留半透明边缘
    canvas.paste(resized, (offset, offset), resized)
    return canvas


def main():
    src_path = find_src()
    img = Image.open(src_path).convert("RGBA")
    src_w, src_h = img.size
    print(f"源图：{src_path.relative_to(ROOT)}  {src_w}×{src_h}")

    if src_w != src_h:
        print(f"⚠ 源图非正方形，将居中裁剪为 {min(src_w, src_h)}×{min(src_w, src_h)}")

    side = min(src_w, src_h)
    if side < MIN_SRC_SIZE_FOR_SMALL:
        sys.exit(f"源图边长 {side}px < {MIN_SRC_SIZE_FOR_SMALL}px，无法生成清晰的小尺寸图标")
    if side < 1024:
        print(f"⚠ 源图边长 {side}px，生成 1024 素材会被放大，可能偏模糊（建议源图 ≥1024px）")

    src = to_square(img)

    (ROOT / "src").mkdir(exist_ok=True)
    (ROOT / "assets").mkdir(exist_ok=True)

    for s in SRC_SIZES:
        out = ROOT / "src" / f"icon-{s}.png"
        render(src, s).save(out, "PNG", optimize=True)
        print(f"  ✓ {out.relative_to(ROOT)}")

    for s in ASSET_SIZES:
        out = ROOT / "assets" / f"icon-{s}.png"
        render(src, s).save(out, "PNG", optimize=True)
        print(f"  ✓ {out.relative_to(ROOT)}")

    print("完成。")


if __name__ == "__main__":
    main()