# PWA用アイコンを作る(python3 scripts/make-icons.py)。図面の枠と配管の線をイメージした簡単な絵。
from PIL import Image, ImageDraw

BLUE = (11, 99, 206)
WHITE = (255, 255, 255)
CYAN = (0, 200, 230)
ORANGE = (240, 140, 20)


def draw(size, maskable):
    s = size
    img = Image.new("RGBA", (s, s), BLUE if maskable else (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if not maskable:
        d.rounded_rectangle((0, 0, s - 1, s - 1), radius=int(s * 0.22), fill=BLUE)
    pad = s * (0.26 if maskable else 0.2)  # maskableは周囲が切り取られるので余白を広くとる
    x0, y0, x1, y1 = pad, pad, s - pad, s - pad
    d.rounded_rectangle((x0, y0, x1, y1), radius=s * 0.03, fill=WHITE)
    w = max(2, round(s * 0.028))
    m = (x1 - x0) * 0.14
    # 図面枠
    d.rectangle((x0 + m, y0 + m, x1 - m, y1 - m), outline=BLUE, width=max(1, w // 2))
    # 配管ルートのような折れ線
    pts = [(x0 + m * 2, y1 - m * 2.2), (x0 + m * 2, y0 + (y1 - y0) * 0.52), (x1 - m * 2.2, y0 + (y1 - y0) * 0.52),
           (x1 - m * 2.2, y0 + m * 2.4)]
    d.line(pts, fill=CYAN, width=w + 1, joint="curve")
    d.line([(x0 + m * 2, y0 + (y1 - y0) * 0.72), (x0 + (x1 - x0) * 0.55, y0 + (y1 - y0) * 0.72)], fill=ORANGE, width=w)
    return img


for size, maskable, name in [(192, False, "icon-192.png"), (512, False, "icon-512.png"), (512, True, "icon-maskable-512.png")]:
    draw(size, maskable).save(f"icons/{name}")
print("icons/ に出力しました")
