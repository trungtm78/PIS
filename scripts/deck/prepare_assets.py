"""Chuan bi anh cho bo trinh chieu: cat logo DPM, copy logo Mach Von, cat khung hinh tu clip.

Chay: python -X utf8 scripts/deck/prepare_assets.py [--out D:/PIS-clips-out/deck/assets]
Dau vao da co san (khong tai lai): dpm-logo-header.webp, dpm-logo-alt.webp (tai tu dpm.vn, xem brand-notes.md)
va khung hinh trong D:/PIS-clips-out/deck/frames (xem README.md).
"""
import argparse
import shutil
from pathlib import Path
from PIL import Image

ap = argparse.ArgumentParser()
ap.add_argument("--out", default="D:/PIS-clips-out/deck/assets")
ap.add_argument("--frames", default="D:/PIS-clips-out/deck/frames")
ap.add_argument("--brand", default="D:/PIS-clips-out/brand")
a = ap.parse_args()
out = Path(a.out)
out.mkdir(parents=True, exist_ok=True)

# Logo dau trang cua dpm.vn co dong chu "Trang Thong tin dien tu tong hop" o tren cung: cat bo dong do,
# giu chu PHU MY (cham cam tren chu Y) va khau hieu "Se chia thinh vuong". Khong ve lai, khong doi mau.
src = Image.open(out / "dpm-logo-header.webp").convert("RGBA")
w, h = src.size
lock = src.crop((0, int(h * 0.175), w, h))
lock.save(out / "dpm-logo-lockup.png")
word = src.crop((0, int(h * 0.175), w, int(h * 0.69)))
word.save(out / "dpm-logo-wordmark.png")
Image.open(out / "dpm-logo-alt.webp").convert("RGBA").save(out / "pvfcco-logo.png")

for n in ["logo-enterprise-horizontal", "logo-public-horizontal", "logo-enterprise-mark", "logo-enterprise-icon"]:
    shutil.copy(Path(a.brand) / f"{n}.png", out / f"machvon-{n}.png")

fr = Path(a.frames)
# Mot khung hinh 1920x1080 cua clip gom nen toi va bang chuyen muc: chi lay vung man hinh ung dung.
APP = (540, 95, 1895, 890)
PHONE = (1290, 55, 1760, 965)
jobs = {
    "shot-directives.jpg": ("t_directives_28.jpg", APP),
    "shot-directive-period.jpg": ("t_directives_45.jpg", APP),
    "shot-hpm.jpg": ("hpm-ebs.jpg", APP),
    "shot-reports.jpg": ("reports-pvn.jpg", APP),
    "shot-leader.jpg": ("t_leader-home_28.jpg", APP),
    "shot-analytics.jpg": ("analytics.jpg", APP),
    "shot-alerts.jpg": ("t_alerts_45.jpg", APP),
    "shot-contractors.jpg": ("contractors.jpg", APP),
    "shot-tree.jpg": ("process-tree.jpg", APP),
    "shot-capital.jpg": ("capital.jpg", APP),
    "phone-home.jpg": ("p_8.jpg", PHONE),
    "phone-projects.jpg": ("p_50.jpg", PHONE),
}
for dst, (srcn, box) in jobs.items():
    p = fr / srcn
    if not p.exists():
        print("thieu", p)
        continue
    Image.open(p).convert("RGB").crop(box).save(out / dst, quality=88)
print("xong", out)
