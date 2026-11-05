#!/usr/bin/env python3
"""
定时补全哈Gemi 的 Q 版表情包（由 hagemi-stickers.timer 每小时调起，以 MIKU 身份运行）。

每轮：
  1. 找出 gen-stickers.sh 清单里还没生成的表情；全齐了就收尾（写 DONE、停掉定时器）。
  2. 先只生成 1 张试探配额。还是 429/配额耗尽就直接结束，等下一轮。
  3. 配额恢复了就把剩下的补完（并发 2），然后去底、描边（finish-stickers.py），做简单质检。
  4. 把新贴纸装进 persona/expressions/chibi/，更新 manifest.json 和三处人设里的可选表情，
     重新生成访客沙箱，等机器人空闲时重启服务让新映射生效。

非配额原因的失败按表情计数，同一张连续失败 5 次就放弃它（避免永远重试）；整轮全部失败视为环境问题，不计数。
从第一次运行起超过 14 天还没齐，也会停掉定时器并在日志里说明。

用法：/home/MIKU/external/MemoryOS/.venv/bin/python scripts/sticker-cycle.py
测试安装步骤（不生成、不重启）：... sticker-cycle.py --test-install <仓库副本根目录> <final 目录>
"""
import base64
import fcntl
import json
import os
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone

import numpy as np
from PIL import Image
from PIL.PngImagePlugin import PngInfo

REPO = '/home/MIKU/dsh-qqbot'
WORK = os.environ.get('STICKER_WORK', '/home/MIKU/.local/share/hagemi-stickers')
GEN = os.path.join(REPO, 'scripts', 'gen-stickers.sh')
FINISH = os.path.join(REPO, 'scripts', 'finish-stickers.py')
PY = sys.executable
TIMER = 'hagemi-stickers.timer'
BOT = 'napcat-qqbot.service'

MAX_FAILS = 5          # 同一张非配额失败几次后放弃
MAX_DAYS = 14          # 最多尝试多少天
QC_OPAQUE = (0.30, 0.85)  # 已有 13 张的不透明占比在 54%–67%；超出这个范围多半是去底失败或画面异常

# id -> 名字（第一个写进人设的可选列表，其余作为同义词进 manifest）
NAMES = {
    'natural': ['自然微笑'], 'calm': ['平静'], 'surprise': ['惊讶'], 'shy': ['害羞'], 'pout': ['鼓腮'],
    'giggle': ['闭眼轻笑'], 'serious': ['认真'], 'upset': ['委屈'], 'happy': ['开心'], 'confused': ['疑惑'],
    'cry': ['大哭'], 'smug': ['得意'], 'sleepy': ['困'],
    'sparkle': ['星星眼', '期待', '激动'],
    'love': ['比心', '爱心', '喜欢'],
    'ok': ['OK', '好的', '点赞', '收到'],
    'speechless': ['无语', '汗', '无言'],
    'goodnight': ['晚安', '睡觉'],
    'wave': ['挥手', '你好', '打招呼', '再见'],
    'angry': ['生气', '愤怒', '气炸'],
    'hungry': ['馋', '饿', '想吃'],
    'thinking': ['思考', '想想', '琢磨'],
}

QUOTA_RE = re.compile(r'429|RESOURCE_EXHAUSTED|QUOTA|quota|exhausted|配额|额度', re.I)


def log(*a):
    print('[stickers]', *a, flush=True)


# ───────────────────────── 状态 ─────────────────────────

def state_path():
    return os.path.join(WORK, 'state.json')


def load_state():
    try:
        return json.load(open(state_path(), encoding='utf8'))
    except Exception:
        return {'first_run': time.time(), 'fails': {}, 'given_up': [], 'pending_restart': False, 'runs': 0}


def save_state(st):
    tmp = state_path() + '.tmp'
    with open(tmp, 'w', encoding='utf8') as f:
        json.dump(st, f, ensure_ascii=False, indent=2)
    os.replace(tmp, state_path())


def job_ids():
    """从 gen-stickers.sh 的 JOBS 清单里读 id，保证两边不会不同步"""
    src = open(GEN, encoding='utf8').read()
    block = src.split("JOBS=$(cat <<'EOF'", 1)[1].split('\nEOF', 1)[0]
    return [ln.split('|', 1)[0].strip() for ln in block.splitlines() if '|' in ln]


def installed(repo, sid):
    return os.path.isfile(os.path.join(repo, 'persona', 'expressions', 'chibi', f'{sid}.png'))


# ───────────────────────── 生成 ─────────────────────────

def run_gen(ids, par):
    env = dict(os.environ, STICKER_OUT=WORK, HOME='/home/MIKU')
    r = subprocess.run(['bash', GEN, str(par), ','.join(ids)], env=env, capture_output=True, text=True, timeout=80 * 60)
    for ln in (r.stdout or '').splitlines():
        log('  gen:', ln)


def outcome(sid):
    """ok / quota / fail"""
    raw = os.path.join(WORK, 'raw', f'{sid}.jpg')
    if os.path.exists(raw) and os.path.getsize(raw) > 0:
        return 'ok'
    text = ''
    for ext in ('out', 'err'):
        try:
            text += open(os.path.join(WORK, 'log', f'{sid}.{ext}'), encoding='utf8', errors='replace').read()
        except OSError:
            pass
    return 'quota' if QUOTA_RE.search(text) else 'fail'


def finish_and_qc(new_ids, st):
    """去底描边，返回通过质检的 id；不过关的删掉原图，下一轮重画"""
    r = subprocess.run([PY, FINISH, os.path.join(WORK, 'raw'), os.path.join(WORK, 'final')], capture_output=True, text=True)
    if r.returncode != 0:
        log('finish-stickers 失败：', (r.stderr or '')[-500:])
        return []
    good = []
    for sid in new_ids:
        p = os.path.join(WORK, 'final', f'{sid}.png')
        try:
            im = Image.open(p).convert('RGBA')
            frac = float((np.asarray(im)[:, :, 3] > 8).mean())
        except Exception as e:
            log(f'质检 {sid}：读不了成品（{e}）')
            frac = -1
        if im.size == (512, 512) and QC_OPAQUE[0] <= frac <= QC_OPAQUE[1]:
            good.append(sid)
            log(f'质检通过 {sid}（不透明 {frac:.0%}）')
        else:
            log(f'质检不过 {sid}（不透明 {frac:.0%}），删掉原图下轮重画')
            for d, ext in (('raw', 'jpg'), ('final', 'png')):
                try:
                    os.remove(os.path.join(WORK, d, f'{sid}.{ext}'))
                except OSError:
                    pass
            st['fails'][sid] = st['fails'].get(sid, 0) + 1
    return good


# ───────────────────────── 安装进人设 ─────────────────────────

def _append_list(text, pattern, sep, names):
    """在可选表情列表末尾追加还没有的名字；找不到列表返回 None"""
    m = re.search(pattern, text)
    if not m:
        return None
    items = [s.strip() for s in m.group(2).split(sep.strip())]
    add = [n for n in names if n not in items]
    if not add:
        return text
    return text[:m.start(2)] + m.group(2) + ''.join(sep + n for n in add) + text[m.end(2):]


def _write_text(path, text):
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf8') as f:
        f.write(text)
    os.replace(tmp, path)


CARD_PAT = r'(可选 )(.*?)(，程序会把它换成)'


def install(repo, final_dir, ids):
    """把成品装进 repo（可以是测试副本）。返回实际新装上的 id 列表"""
    chibi = os.path.join(repo, 'persona', 'expressions', 'chibi')
    os.makedirs(chibi, exist_ok=True)
    added = []
    for sid in ids:
        if sid not in NAMES:
            log(f'{sid} 没有配置名字，先不装（在 NAMES 里补上）')
            continue
        dst = os.path.join(chibi, f'{sid}.png')
        if os.path.exists(dst):
            continue
        shutil.copyfile(os.path.join(final_dir, f'{sid}.png'), dst + '.tmp')
        os.replace(dst + '.tmp', dst)
        added.append(sid)
    if not added:
        return []

    # manifest：新名字指向新贴纸（同名旧映射会被覆盖，例如 生气 从 鼓腮 改成 生气 的贴纸）
    mf = os.path.join(repo, 'persona', 'expressions', 'manifest.json')
    man = json.load(open(mf, encoding='utf8'))
    for sid in added:
        for n in NAMES[sid]:
            man.setdefault('stickers', {})[n] = f'chibi/{sid}.png'
    _write_text(mf, json.dumps(man, ensure_ascii=False, indent=2) + '\n')

    primary = [NAMES[sid][0] for sid in added]
    # 管理员人设 AGENTS.md 和访客模板里的可选表情列表
    for rel, pat, sep in (
        ('AGENTS.md', r'(可选：)(.*?)(。一条最多一个)', ' / '),
        (os.path.join('scripts', 'setup-guest-home.py'), r'(写 `\[表情:名\]`（)(.*?)(），程序会)', '/'),
    ):
        p = os.path.join(repo, rel)
        t = _append_list(open(p, encoding='utf8').read(), pat, sep, primary)
        if t is None:
            log(f'{rel} 里没找到可选表情列表，跳过')
        else:
            _write_text(p, t)
    # 角色卡 JSON
    p = os.path.join(repo, 'persona', 'gemini-chan.card.json')
    card = json.load(open(p, encoding='utf8'))
    t = _append_list(card['data']['system_prompt'], CARD_PAT, '/', primary)
    if t is None:
        log('角色卡 system_prompt 里没找到可选表情列表，跳过')
    else:
        card['data']['system_prompt'] = t
        _write_text(p, json.dumps(card, ensure_ascii=False, indent=2) + '\n')
    # 角色卡 PNG：chara（V2，与 JSON 一致）和 ccv3 两个文本块
    p = os.path.join(repo, 'persona', 'gemini-chan.card.png')
    try:
        im = Image.open(p)
        im.load()
        info = PngInfo()
        info.add_text('chara', base64.b64encode(json.dumps(card, ensure_ascii=False).encode('utf8')).decode('ascii'))
        if 'ccv3' in im.text:
            v3 = json.loads(base64.b64decode(im.text['ccv3']))
            t3 = _append_list(v3['data'].get('system_prompt', ''), CARD_PAT, '/', primary)
            if t3 is not None:
                v3['data']['system_prompt'] = t3
            info.add_text('ccv3', base64.b64encode(json.dumps(v3, ensure_ascii=False).encode('utf8')).decode('ascii'))
        tmp = p + '.tmp.png'
        im.save(tmp, 'PNG', pnginfo=info, icc_profile=im.info.get('icc_profile'))
        os.replace(tmp, p)
    except Exception as e:
        log('更新角色卡 PNG 失败（JSON 已更新）：', e)
    log('已装上：', ', '.join(f'{sid}({NAMES[sid][0]})' for sid in added))
    return added


# ───────────────────────── 让机器人加载新贴纸 ─────────────────────────

def sh(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def bot_idle(seconds=180):
    r = sh(['sudo', '-n', 'journalctl', '-u', BOT, '--since', f'-{seconds}s', '--no-pager', '-o', 'cat'])
    return r.returncode == 0 and not re.search(r'Inbound \[|GroupProactive|\[Poke\]', r.stdout)


def apply_to_bot(st):
    r = sh(['/usr/bin/python3', os.path.join(REPO, 'scripts', 'setup-guest-home.py')], cwd=REPO)
    if r.returncode != 0:
        log('重新生成访客沙箱失败：', (r.stderr or r.stdout)[-400:])
        st['pending_restart'] = True
        return
    for _ in range(20):            # 最多等 20 分钟，等没人在聊的时候再重启
        if bot_idle():
            break
        time.sleep(60)
    else:
        log('机器人一直有人在用，这轮先不重启，下一轮再试')
        st['pending_restart'] = True
        return
    r = sh(['sudo', '-n', 'systemctl', 'restart', BOT])
    if r.returncode != 0:
        log('重启机器人失败：', r.stderr[-300:])
        st['pending_restart'] = True
        return
    time.sleep(5)
    active = sh(['systemctl', 'is-active', BOT]).stdout.strip()
    log(f'已重启 {BOT}：{active}')
    st['pending_restart'] = active != 'active'


def stop_timer(reason):
    log('停止定时器：', reason)
    with open(os.path.join(WORK, 'DONE'), 'w', encoding='utf8') as f:
        f.write(f'{datetime.now(timezone.utc).isoformat()} {reason}\n')
    sh(['sudo', '-n', 'systemctl', 'disable', '--now', TIMER])


# ───────────────────────── 主流程 ─────────────────────────

def main():
    if len(sys.argv) == 4 and sys.argv[1] == '--test-install':
        added = install(sys.argv[2], sys.argv[3], [f[:-4] for f in sorted(os.listdir(sys.argv[3])) if f.endswith('.png') and f != 'contact.png'])
        log('test-install 完成：', added)
        return

    os.makedirs(os.path.join(WORK, 'raw'), exist_ok=True)
    lock = open(os.path.join(WORK, '.lock'), 'w')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        log('上一轮还没结束，跳过')
        return
    if os.path.exists(os.path.join(WORK, 'DONE')):
        log('已完成，无事可做')
        return

    st = load_state()
    st['runs'] = st.get('runs', 0) + 1
    try:
        if st.get('pending_restart'):
            apply_to_bot(st)

        ids = job_ids()
        # 已生成但还没装上的（上一轮装失败、或质检后补装）
        ready = [s for s in ids if os.path.exists(os.path.join(WORK, 'final', f'{s}.png')) and not installed(REPO, s)]
        todo = [s for s in ids if not installed(REPO, s) and s not in st['given_up'] and s not in ready
                and not os.path.exists(os.path.join(WORK, 'raw', f'{s}.jpg'))]
        log(f'第 {st["runs"]} 轮：清单 {len(ids)} 张，已装 {sum(installed(REPO, s) for s in ids)}，待生成 {len(todo)}：{" ".join(todo) or "-"}')

        new_raw = [s for s in ids if not installed(REPO, s) and os.path.exists(os.path.join(WORK, 'raw', f'{s}.jpg'))
                   and not os.path.exists(os.path.join(WORK, 'final', f'{s}.png'))]
        if todo:
            probe = todo[0]
            run_gen([probe], 1)
            res = {probe: outcome(probe)}
            if res[probe] == 'quota':
                log('图像生成配额还没恢复，等下一轮')
            else:
                rest = todo[1:]
                if rest:
                    run_gen(rest, 2)
                    res.update({s: outcome(s) for s in rest})
                if all(v == 'fail' for v in res.values()) and len(res) > 1:
                    log('这一轮全部失败且不是配额问题，可能是 agy/登录/网络异常，不计入单张失败次数：', res)
                else:
                    for s, v in res.items():
                        if v == 'fail':
                            st['fails'][s] = st['fails'].get(s, 0) + 1
                            log(f'{s} 生成失败（第 {st["fails"][s]} 次）')
                            if st['fails'][s] >= MAX_FAILS:
                                st['given_up'].append(s)
                                log(f'{s} 连续失败 {MAX_FAILS} 次，放弃这一张')
                new_raw += [s for s, v in res.items() if v == 'ok']
                log('本轮结果：', res)

        if new_raw:
            ready += finish_and_qc(new_raw, st)
        if ready:
            if install(REPO, os.path.join(WORK, 'final'), ready):
                apply_to_bot(st)

        remaining = [s for s in ids if not installed(REPO, s) and s not in st['given_up']]
        if not remaining:
            gu = st['given_up']
            stop_timer('表情包已配齐' + (f'（放弃了 {len(gu)} 张：{" ".join(gu)}）' if gu else ''))
        elif time.time() - st.get('first_run', time.time()) > MAX_DAYS * 86400:
            stop_timer(f'已尝试 {MAX_DAYS} 天仍未配齐，还差：{" ".join(remaining)}')
        else:
            log(f'还差 {len(remaining)} 张：{" ".join(remaining)}')
    finally:
        save_state(st)


if __name__ == '__main__':
    main()
