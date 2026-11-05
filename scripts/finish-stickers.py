#!/usr/bin/env python3
"""
把 gen-stickers.sh 生成的白底原图做成贴纸：从四边做泛洪去掉白底（角色内部的白色衣服不受影响），
裁到内容边界、留白，加一圈白色描边，统一成 512×512 透明 PNG，并输出总览图 contact.png。
用法：/home/MIKU/external/MemoryOS/.venv/bin/python scripts/finish-stickers.py /tmp/stkgen/raw /tmp/stkgen/final
"""
import os
import sys
from collections import deque

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

SIZE = 512
STROKE = 9          # 描边半径（像素，按 1024 原图计）
WHITE_MIN = 232     # RGB 三通道都 ≥ 这个值、且和四边连通的才当背景


def cut(path: str) -> Image.Image:
    rgb = Image.open(path).convert('RGB')
    a = np.asarray(rgb).astype(np.int16)
    h, w, _ = a.shape
    white = a.min(axis=2) >= WHITE_MIN
    bg = np.zeros((h, w), bool)
    q = deque()
    for x in range(w):
        for y in (0, h - 1):
            if white[y, x] and not bg[y, x]:
                bg[y, x] = True
                q.append((y, x))
    for y in range(h):
        for x in (0, w - 1):
            if white[y, x] and not bg[y, x]:
                bg[y, x] = True
                q.append((y, x))
    while q:
        y, x = q.popleft()
        for yy, xx in ((y + 1, x), (y - 1, x), (y, x + 1), (y, x - 1)):
            if 0 <= yy < h and 0 <= xx < w and white[yy, xx] and not bg[yy, xx]:
                bg[yy, xx] = True
                q.append((yy, xx))
    alpha = Image.fromarray(np.where(bg, 0, 255).astype('uint8'))
    # 去掉 1px 白边光晕再柔化一点
    alpha = alpha.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(0.7))
    art = rgb.convert('RGBA')
    art.putalpha(alpha)
    # 白色描边
    halo = alpha.filter(ImageFilter.MaxFilter(STROKE * 2 + 1)).filter(ImageFilter.GaussianBlur(1.2))
    out = Image.new('RGBA', rgb.size, (255, 255, 255, 0))
    out.putalpha(halo)
    out = Image.alpha_composite(out, art)
    bbox = out.getchannel('A').point(lambda v: 255 if v > 8 else 0).getbbox()
    if bbox:
        out = out.crop(bbox)
    # 等比放进正方形，留 4% 边距
    side = int(max(out.size) * 1.08)
    canvas = Image.new('RGBA', (side, side), (255, 255, 255, 0))
    canvas.alpha_composite(out, ((side - out.width) // 2, (side - out.height) // 2))
    return canvas.resize((SIZE, SIZE), Image.LANCZOS)


def main() -> None:
    src, dst = sys.argv[1], sys.argv[2]
    os.makedirs(dst, exist_ok=True)
    names = sorted(f for f in os.listdir(src) if f.lower().endswith(('.jpg', '.jpeg', '.png')))
    tiles = []
    for f in names:
        im = cut(os.path.join(src, f))
        name = os.path.splitext(f)[0]
        im.save(os.path.join(dst, f'{name}.png'), optimize=True)
        tiles.append((name, im))
        print('ok', name)
    cols, cell = 6, 260
    rows = (len(tiles) + cols - 1) // cols or 1
    sheet = Image.new('RGBA', (cols * cell, rows * cell), (58, 58, 68, 255))
    d = ImageDraw.Draw(sheet)
    for k, (name, im) in enumerate(tiles):
        t = im.resize((cell - 30, cell - 30), Image.LANCZOS)
        x, y = (k % cols) * cell, (k // cols) * cell
        sheet.alpha_composite(t, (x + 15, y + 22))
        d.text((x + 8, y + 4), name, fill=(255, 255, 255, 255))
    sheet.convert('RGB').save(os.path.join(dst, 'contact.png'))
    print(f'{len(tiles)} stickers -> {dst}')


if __name__ == '__main__':
    main()
