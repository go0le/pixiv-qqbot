#!/usr/bin/env python3
"""
把一个 Telegram 贴纸包下载成 PNG（保留透明背景），供哈Gemi 当表情贴图用。

只调用 Bot API 的只读接口 getStickerSet / getFile，不发任何消息。
token 只从环境变量 TG_BOT_TOKEN 读，不写盘、不打印（下载 URL 里含 token，也不打印）。

用法（需要能 import PIL 的 Python，例如 MemoryOS 的 venv）：
  read -rs TG_BOT_TOKEN && export TG_BOT_TOKEN
  /home/MIKU/external/MemoryOS/.venv/bin/python scripts/fetch-telegram-stickers.py ColorfulHachimi /tmp/stickers-ColorfulHachimi

输出：<out>/NN.png（按贴纸包里的顺序编号，最长边 512）、<out>/index.json、<out>/contact.png（带编号的总览图，用来对照命名）。
动态贴纸（.tgs / .webm）只记录在 index.json 里，不转换。
"""
import io
import json
import os
import sys
import time
import urllib.parse
import urllib.request

from PIL import Image, ImageDraw

API = 'https://api.telegram.org'


def call(token: str, method: str, **params) -> dict:
    url = f'{API}/bot{token}/{method}?{urllib.parse.urlencode(params)}'
    try:
        with urllib.request.urlopen(url, timeout=30) as r:
            d = json.load(r)
    except urllib.error.HTTPError as e:            # 不把带 token 的 URL 打出来
        d = json.loads(e.read() or b'{}')
    if not d.get('ok'):
        raise SystemExit(f'{method} failed: {d.get("description", "unknown error")}')
    return d['result']


def fetch(token: str, file_path: str) -> bytes:
    with urllib.request.urlopen(f'{API}/file/bot{token}/{file_path}', timeout=60) as r:
        return r.read()


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    name, out = sys.argv[1], sys.argv[2]
    token = os.environ.get('TG_BOT_TOKEN', '').strip()
    if not token:
        raise SystemExit('先 export TG_BOT_TOKEN（从 @BotFather 创建一个 bot 即可，只用来读贴纸包）')
    os.makedirs(out, exist_ok=True)

    st = call(token, 'getStickerSet', name=name)
    stickers = st.get('stickers', [])
    print(f'set "{st.get("title")}" ({name}): {len(stickers)} stickers')
    index, tiles = [], []
    for i, s in enumerate(stickers, 1):
        item = {'n': i, 'emoji': s.get('emoji'), 'w': s.get('width'), 'h': s.get('height'),
                'animated': bool(s.get('is_animated')), 'video': bool(s.get('is_video'))}
        if item['animated'] or item['video']:
            item['skipped'] = 'animated/video sticker'
            index.append(item)
            continue
        f = call(token, 'getFile', file_id=s['file_id'])
        im = Image.open(io.BytesIO(fetch(token, f['file_path']))).convert('RGBA')
        im.thumbnail((512, 512), Image.LANCZOS)
        fn = f'{i:02d}.png'
        im.save(os.path.join(out, fn), optimize=True)
        item['file'] = fn
        index.append(item)
        tiles.append((i, im))
        time.sleep(0.15)
    with open(os.path.join(out, 'index.json'), 'w', encoding='utf8') as fp:
        json.dump({'set': name, 'title': st.get('title'), 'stickers': index}, fp, ensure_ascii=False, indent=1)

    # 带编号的总览图
    cols, cell = 8, 200
    rows = (len(tiles) + cols - 1) // cols or 1
    sheet = Image.new('RGBA', (cols * cell, rows * cell), (60, 60, 70, 255))
    d = ImageDraw.Draw(sheet)
    for k, (i, im) in enumerate(tiles):
        t = im.copy()
        t.thumbnail((cell - 24, cell - 24))
        x, y = (k % cols) * cell, (k // cols) * cell
        sheet.alpha_composite(t, (x + (cell - t.width) // 2, y + 20 + (cell - 24 - t.height) // 2))
        d.text((x + 6, y + 4), f'{i:02d} {item_emoji(index, i)}', fill=(255, 255, 255, 255))
    sheet.convert('RGB').save(os.path.join(out, 'contact.png'))
    print(f'saved {len(tiles)} png, skipped {len(index) - len(tiles)} animated -> {out}')


def item_emoji(index: list, n: int) -> str:
    for it in index:
        if it['n'] == n:
            return ''  # emoji 字体通常缺失，总览图只标编号；emoji 在 index.json 里
    return ''


if __name__ == '__main__':
    main()
