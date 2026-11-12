#!/usr/bin/env python3
"""
为 words.json / verbs.json / sentences.json 生成发音 mp3（免费，不需要任何账号）。

用的是 edge-tts（微软 Edge 浏览器"大声朗读"背后的神经语音）。
- 文件名 = 法语文本的 FNV-1a 32 位哈希，和 app.js 里的 audioKey() 完全一致
- 已经生成过的直接跳过，只生成新增/修改过的句子
- 最后写出 audio/index.json，app 据此知道哪些文本有 mp3

用法：
    pip install edge-tts
    python tools/gen_audio.py                 # 全部
    python tools/gen_audio.py --only sentence # 只生成句子
    python tools/gen_audio.py --voice fr-FR-DeniseNeural

GitHub 上有自动任务（.github/workflows/tts.yml）会定期跑这个脚本，
平时不需要在自己电脑上运行。
"""
import argparse
import asyncio
import json
import os
import re
import sys
import time
import unicodedata

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AUDIO_DIR = os.path.join(ROOT, 'audio')
SOURCES = {'word': 'words.json', 'verb': 'verbs.json', 'sentence': 'sentences.json'}


def normalize_for_audio(text):
    text = unicodedata.normalize('NFC', text or '').replace('’', "'")
    return re.sub(r'\s+', ' ', text).strip()


def audio_key(text):
    h = 0x811c9dc5
    for b in normalize_for_audio(text).encode('utf-8'):
        h ^= b
        h = (h * 0x01000193) & 0xffffffff
    return '%08x' % h


def collect(only):
    jobs = {}  # key -> (text, kind)
    for kind, fname in SOURCES.items():
        if only and kind not in only:
            continue
        with open(os.path.join(ROOT, fname), encoding='utf-8') as f:
            for item in json.load(f):
                text = normalize_for_audio(item.get('fr', ''))
                if text:
                    # 句子优先：同一文本既是单词又是句子时，按句子语速生成
                    k = audio_key(text)
                    if k not in jobs or kind == 'sentence':
                        jobs[k] = (text, kind)
    return jobs


def write_index():
    keys = sorted(f[:-4] for f in os.listdir(AUDIO_DIR)
                  if f.endswith('.mp3') and os.path.getsize(os.path.join(AUDIO_DIR, f)) > 0)
    with open(os.path.join(AUDIO_DIR, 'index.json'), 'w') as f:
        json.dump(keys, f, separators=(',', ':'))
    return len(keys)


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--voice', default='fr-CA-SylvieNeural',
                    help='默认加拿大法语女声；可选 fr-CA-AntoineNeural / fr-FR-DeniseNeural / fr-FR-HenriNeural 等')
    ap.add_argument('--sentence-rate', default='-5%', help='句子语速，比如 -10%% 更慢')
    ap.add_argument('--word-rate', default='-5%')
    ap.add_argument('--only', nargs='*', choices=list(SOURCES), help='只生成某几类')
    ap.add_argument('--concurrency', type=int, default=6)
    ap.add_argument('--time-limit', type=int, default=0, help='最多运行多少秒（0 = 不限），到点后保存进度退出')
    args = ap.parse_args()

    try:
        import edge_tts
    except ImportError:
        sys.exit('缺少 edge-tts：请先运行  pip install edge-tts')

    os.makedirs(AUDIO_DIR, exist_ok=True)
    jobs = collect(args.only)
    todo = [(k, t, kind) for k, (t, kind) in jobs.items()
            if not (os.path.exists(os.path.join(AUDIO_DIR, k + '.mp3'))
                    and os.path.getsize(os.path.join(AUDIO_DIR, k + '.mp3')) > 0)]
    print(f'共 {len(jobs)} 条文本，需要生成 {len(todo)} 条，声音 {args.voice}', flush=True)

    start = time.time()
    sem = asyncio.Semaphore(args.concurrency)
    stats = {'ok': 0, 'fail': 0, 'skipped': 0}
    first_error = []

    async def one(key, text, kind):
        if args.time_limit and time.time() - start > args.time_limit:
            stats['skipped'] += 1
            return
        async with sem:
            path = os.path.join(AUDIO_DIR, key + '.mp3')
            tmp = path + '.part'
            rate = args.sentence_rate if kind == 'sentence' else args.word_rate
            for attempt in range(4):
                try:
                    await edge_tts.Communicate(text, args.voice, rate=rate).save(tmp)
                    if os.path.getsize(tmp) == 0:
                        raise RuntimeError('生成了空文件')
                    os.replace(tmp, path)
                    stats['ok'] += 1
                    if stats['ok'] % 200 == 0:
                        print(f'  已生成 {stats["ok"]} 条…', flush=True)
                    return
                except Exception as e:  # 网络抖动/限流：退避重试
                    if not first_error:
                        first_error.append(f'{type(e).__name__}: {e}')
                    await asyncio.sleep(2 ** attempt)
            if os.path.exists(tmp):
                os.remove(tmp)
            stats['fail'] += 1

    await asyncio.gather(*(one(k, t, kind) for k, t, kind in todo))
    total = write_index()
    print(f'完成：新生成 {stats["ok"]}，失败 {stats["fail"]}，因时间限制留到下次 {stats["skipped"]}；'
          f'audio/ 里现在共有 {total} 个 mp3', flush=True)
    if first_error:
        print('第一个错误：' + first_error[0], flush=True)
    if todo and stats['ok'] == 0 and stats['fail'] > 0:
        sys.exit('一条都没有生成成功，多半是连不上微软语音服务器（speech.platform.bing.com）。')


if __name__ == '__main__':
    asyncio.run(main())
