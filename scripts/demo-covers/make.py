"""生成演示用的豆瓣封面与海报（全是虚构的书和影片）：拼成一张 HTML，用无头 Chrome 截一张大图，再切成每本一张 jpg。
用法（在仓库根目录）：python scripts/demo-covers/make.py
输出 scripts/demo-covers/douban/<编号>.jpg 与 scripts/demo-covers/douban-movie/<编号>.jpg；scripts/demo-data.mjs 生成演示数据时把它们拷进 public/covers/。
书名、片名、编号与 demo-data.mjs 里的一致；改了那边的名单要重跑这里。"""
import hashlib
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
BOOKS = ["雾中的灯塔", "第七条河流", "纸上的城市", "慢船去南方", "晚钟与麦田", "一座岛的编年", "听见石头说话", "镜子里的旅人", "冬天的植物学",
         "旧地图上的名字", "风从北方来", "一个人的天文台", "无人知晓的海岸", "手工的哲学", "时间的抽屉", "家族相册", "思考的速度", "雨季备忘录",
         "灰色城市指南", "小数点后的世界", "穿过森林的铁路", "安静的力量", "船长的笔记本", "最后一个钟表匠", "水的形状", "影子博物馆", "蓝色的边界",
         "远方来信", "一百个清晨", "被遗忘的发明", "日常的勇气", "沙丘上的房子", "看不见的市场", "夜航", "云的分类学", "石头与星辰"]
MOVIES = ["夏天结束的地方", "灯塔看守人", "第九站台", "海边的理发店", "长夜慢车", "一封没寄出的信", "纸飞机", "雾港", "回声小镇", "星期三的雨", "最后的放映员", "远山来客"]
PRESSES = ["青石出版社", "远帆文艺", "白鹭书局", "北辰人文", "南窗出版社", "知言书社"]
W, H = 300, 420  # 一张封面的 CSS 尺寸，按 2 倍截图得到 600×840

PALETTES = [("#1f3a4d", "#ece3d0", "#c9784a"), ("#2d4a3e", "#efe6d2", "#d4a24c"), ("#5a2e2a", "#f2e8dc", "#e0a458"),
            ("#24304f", "#f4efe6", "#e46f4b"), ("#3b3a36", "#ede4d3", "#8fae8b"), ("#0f4c5c", "#f6f1e7", "#e36414"),
            ("#4a3b5c", "#f1ece4", "#d9a5b3"), ("#283618", "#fefae0", "#dda15e"), ("#14213d", "#ece9e2", "#fca311"),
            ("#6b2737", "#f3ece2", "#e9b44c"), ("#1d3557", "#f1faee", "#e63946")]
ARTS = ["sea", "night", "forest", "city", "desert", "rings", "blobs", "grid", "stripes", "leaves"]
SERIF = "'Noto Serif SC','Source Han Serif SC','Songti SC',serif"
SANS = "'Noto Sans SC','Microsoft YaHei',sans-serif"


def h(s, n):
    return int(hashlib.md5(s.encode()).hexdigest(), 16) % n


def art(kind, r, pal):
    """一幅 300×420 的画；r 只让同题材的几张各有差别"""
    dark, light, acc = pal
    if kind == "sea":
        waves = "".join(f'<path d="M0 {250 + i * 24} Q 75 {236 + i * 24 + r % 11} 150 {250 + i * 24} T 300 {250 + i * 24} V420 H0Z" fill="{dark}" opacity="{0.3 + i * 0.14:.2f}"/>' for i in range(5))
        return f'<rect width="300" height="420" fill="{light}"/><circle cx="{80 + r % 140}" cy="150" r="48" fill="{acc}"/>{waves}'
    if kind == "night":
        stars = "".join(f'<circle cx="{(r * 7 + i * 53) % 300}" cy="{(r * 3 + i * 37) % 250}" r="{0.8 + (i % 3) * 0.6:.1f}" fill="#fff" opacity="0.75"/>' for i in range(46))
        return (f'<rect width="300" height="420" fill="{dark}"/>{stars}<circle cx="{210 - r % 90}" cy="120" r="34" fill="{light}"/><circle cx="{222 - r % 90}" cy="112" r="30" fill="{dark}"/>'
                '<path d="M0 330 L60 290 L110 320 L170 270 L230 310 L300 280 V420 H0Z" fill="#000" opacity="0.3"/>')
    if kind == "forest":
        trees = "".join(f'<path d="M{x} 380 L{x + 20} {290 - (x * r) % 70} L{x + 40} 380Z" fill="{dark}" opacity="{0.5 + ((x // 28) % 3) * 0.17:.2f}"/>' for x in range(-12, 300, 24))
        return f'<rect width="300" height="420" fill="{light}"/><circle cx="{220 - r % 60}" cy="110" r="40" fill="{acc}" opacity="0.9"/>{trees}<rect y="378" width="300" height="42" fill="{dark}"/>'
    if kind == "city":
        blds = "".join(f'<rect x="{x}" y="{190 + (x * r) % 130}" width="{24 + (x % 3) * 8}" height="300" fill="{dark}" opacity="{0.45 + ((x // 30) % 3) * 0.2:.2f}"/>' for x in range(0, 300, 30))
        wins = "".join(f'<rect x="{8 + (i * 31) % 284}" y="{250 + (i * 17) % 140}" width="4" height="6" fill="{acc}"/>' for i in range(34))
        return f'<rect width="300" height="420" fill="{light}"/><circle cx="{60 + r % 180}" cy="120" r="30" fill="{acc}" opacity="0.6"/>{blds}{wins}'
    if kind == "desert":
        return (f'<rect width="300" height="420" fill="{light}"/><circle cx="{110 + r % 80}" cy="170" r="72" fill="{acc}"/>'
                f'<path d="M0 290 Q 90 240 170 290 T 300 280 V420 H0Z" fill="{dark}" opacity="0.55"/><path d="M0 335 Q 120 295 220 340 T 300 325 V420 H0Z" fill="{dark}"/>')
    if kind == "rings":
        rings = "".join(f'<circle cx="{150 + r % 70 - 35}" cy="{200 + r % 40 - 20}" r="{18 + i * 24}" fill="none" stroke="{dark if i % 2 else acc}" stroke-width="{7 - i * 0.6:.1f}" opacity="0.85"/>' for i in range(9))
        return f'<rect width="300" height="420" fill="{light}"/>{rings}'
    if kind == "blobs":
        b = "".join(f'<circle cx="{(r * (i + 2) * 13) % 300}" cy="{(r * (i + 5) * 7) % 420}" r="{60 + (i * 23) % 70}" fill="{[dark, acc, light][i % 3]}" opacity="0.8"/>' for i in range(6))
        return f'<rect width="300" height="420" fill="{light}"/><rect width="300" height="420" fill="{acc}" opacity="0.3"/>{b}'
    if kind == "grid":
        cells = "".join(f'<rect x="{30 + (i % 5) * 50}" y="{40 + (i // 5) * 50}" width="40" height="40" rx="{20 if (i * r) % 3 == 0 else 2}" fill="{[dark, acc, light][(i * r) % 3]}"/>' for i in range(35))
        return f'<rect width="300" height="420" fill="{light}"/><rect width="300" height="420" fill="{dark}" opacity="0.08"/>{cells}'
    if kind == "stripes":
        st = "".join(f'<rect x="{-200 + i * 28}" y="-80" width="14" height="640" fill="{dark if i % 2 else acc}" transform="rotate(30 150 210)"/>' for i in range(22))
        return f'<rect width="300" height="420" fill="{light}"/>{st}<circle cx="150" cy="210" r="70" fill="{light}"/><circle cx="150" cy="210" r="28" fill="{acc}"/>'
    leaves = "".join(f'<ellipse cx="{(r * 5 + i * 47) % 300}" cy="{(r * 11 + i * 61) % 420}" rx="34" ry="12" fill="{[dark, acc][i % 2]}" opacity="0.85" '
                     f'transform="rotate({(i * 37) % 180} {(r * 5 + i * 47) % 300} {(r * 11 + i * 61) % 420})"/>' for i in range(26))
    return f'<rect width="300" height="420" fill="{light}"/>{leaves}'


def piece(kind, r, pal, x, y, w, hh):
    """把一幅画按裁切放进封面上的一块区域"""
    return f'<svg x="{x}" y="{y}" width="{w}" height="{hh}" viewBox="0 0 300 420" preserveAspectRatio="xMidYMid slice">{art(kind, r, pal)}</svg>'


def box(svg, text):
    return f'<div style="position:relative;width:{W}px;height:{H}px;overflow:hidden"><svg width="{W}" height="{H}" viewBox="0 0 300 420" style="position:absolute;inset:0">{svg}</svg>{text}</div>'


def book_cover(t, press, i):
    """三种版式轮流：上图下字、浅底画框、深底竖排；标题都放在不压画的地方，保证看得清"""
    pal = PALETTES[i % len(PALETTES)]
    dark, light, acc = pal
    kind, r, layout = ARTS[(i * 3) % len(ARTS)], h(t, 1000), i % 3
    size = 30 if len(t) <= 6 else 25
    if layout == 0:
        svg = piece(kind, r, pal, 0, 0, 300, 268) + f'<rect y="268" width="300" height="152" fill="{light}"/><rect x="24" y="356" width="36" height="3" fill="{acc}"/>'
        text = (f'<div style="position:absolute;left:24px;right:20px;top:284px;font:700 {size}px/1.25 {SERIF};color:{dark}">{t}</div>'
                f'<div style="position:absolute;left:24px;bottom:22px;font:12px {SANS};letter-spacing:2px;color:{dark};opacity:.75">{press}</div>')
    elif layout == 1:
        svg = f'<rect width="300" height="420" fill="{light}"/>' + piece(kind, r, pal, 30, 120, 240, 230) + f'<rect x="30" y="120" width="240" height="230" fill="none" stroke="{dark}" stroke-width="1.5"/>'
        text = (f'<div style="position:absolute;left:30px;right:30px;top:34px;font:700 {size}px/1.2 {SERIF};color:{dark}">{t}</div>'
                f'<div style="position:absolute;left:30px;bottom:26px;font:12px {SANS};letter-spacing:2px;color:{dark};opacity:.75">{press}</div>')
    else:
        svg = f'<rect width="300" height="420" fill="{dark}"/>' + piece(kind, r, pal, 0, 240, 300, 180)
        if len(t) <= 5:
            text = (f'<div style="position:absolute;right:30px;top:30px;writing-mode:vertical-rl;font:700 34px/1.1 {SERIF};letter-spacing:8px;color:{light}">{t}</div>'
                    f'<div style="position:absolute;left:24px;top:34px;font:12px {SANS};letter-spacing:2px;color:{light};opacity:.8">{press}</div>')
        else:
            text = (f'<div style="position:absolute;left:24px;right:24px;top:40px;font:700 {size}px/1.25 {SERIF};color:{light}">{t}</div>'
                    f'<div style="position:absolute;left:24px;top:200px;font:12px {SANS};letter-spacing:2px;color:{light};opacity:.8">{press}</div>')
    return box(svg, text)


def movie_poster(t, i):
    """满版画面，底部压一层渐暗，片名白字"""
    pal = PALETTES[(i * 5 + 2) % len(PALETTES)]
    acc = pal[2]
    kind, r = ["night", "sea", "city", "desert", "forest", "rings"][i % 6], h(t, 1000)
    svg = (piece(kind, r, pal, 0, 0, 300, 420) + f'<defs><linearGradient id="g{i}" x1="0" y1="0" x2="0" y2="1"><stop offset=".45" stop-color="#000" stop-opacity="0"/>'
           f'<stop offset="1" stop-color="#000" stop-opacity=".8"/></linearGradient></defs><rect width="300" height="420" fill="url(#g{i})"/>')
    text = (f'<div style="position:absolute;left:22px;right:22px;bottom:58px;font:700 {30 if len(t) <= 6 else 25}px/1.2 {SERIF};color:#fff">{t}</div>'
            f'<div style="position:absolute;left:22px;bottom:30px;font:600 10px {SANS};letter-spacing:4px;color:#fff;opacity:.8">A FILM</div>'
            f'<div style="position:absolute;left:22px;top:20px;width:40px;height:3px;background:{acc}"></div>')
    return box(svg, text)


def main():
    items = [("douban", str(90000001 + i * 37), book_cover(t, PRESSES[h(t, len(PRESSES))], i)) for i, t in enumerate(BOOKS)]
    items += [("douban-movie", str(91000001 + i * 41), movie_poster(t, i)) for i, t in enumerate(MOVIES)]
    cols = 8
    rows = (len(items) + cols - 1) // cols
    html = (f'<!doctype html><meta charset="utf-8"><body style="margin:0;background:#fff;display:grid;grid-template-columns:repeat({cols},{W}px)">'
            + "".join(c for _, _, c in items) + "</body>")
    tmp = Path(tempfile.mkdtemp())
    (tmp / "covers.html").write_text(html, encoding="utf-8")
    chrome = r"C:\Program Files\Google\Chrome\Application\chrome.exe" if sys.platform == "win32" else "google-chrome"
    subprocess.run([chrome, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=2", f"--user-data-dir={tmp / 'p'}",
                    f"--window-size={cols * W},{rows * H}", f"--screenshot={tmp / 'all.png'}", (tmp / "covers.html").as_uri()], check=True, capture_output=True)
    big = Image.open(tmp / "all.png").convert("RGB")
    for k, (d, v, _) in enumerate(items):
        x, y = (k % cols) * W * 2, (k // cols) * H * 2
        out = HERE / d / f"{v}.jpg"
        out.parent.mkdir(parents=True, exist_ok=True)
        big.crop((x, y, x + W * 2, y + H * 2)).save(out, quality=86)
    shutil.rmtree(tmp, ignore_errors=True)
    print(f"wrote {len(items)} covers and posters")


if __name__ == "__main__":
    main()
