"""Dung bo trinh chieu tu mau goc + noi dung tieng Viet (content.json) + nhan dien Phu My.

python -X utf8 scripts/deck/build_deck.py [--template ...pptx] [--assets DIR] [--out FILE.pptx] [--preview DIR]
Xem README.md. Mau goc chi duoc doc; tep dau ra la mot ban sao da doi chu de, mau, phong, logo.
"""
import argparse
import copy
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

from lxml import etree
from pptx import Presentation
from pptx.opc.constants import RELATIONSHIP_TYPE as RT
from pptx.oxml.ns import qn
from pptx.shapes.shapetree import SlideShapes
from pptx.util import Emu, Pt

sys.path.insert(0, str(Path(__file__).parent))
from deck_lib import *  # noqa: E402,F401,F403
from deck_lib import Canvas, Para, EMU, W, H  # noqa: E402

HERE = Path(__file__).parent
DEFAULT_TEMPLATE = "D:/PIS/Design/Requirments/Slide_Gioi_Thieu_Nen_Tang_Chuoi_Cung_Ung_Nguyen_Kim_20261015-ver2.pptx"
NSA = "http://schemas.openxmlformats.org/drawingml/2006/main"

ap = argparse.ArgumentParser()
ap.add_argument("--template", default=DEFAULT_TEMPLATE)
ap.add_argument("--assets", default="D:/PIS-clips-out/deck/assets")
ap.add_argument("--content", default=str(HERE / "content.json"))
ap.add_argument("--req", default=str(HERE.parent.parent / "docs/hskt/requirements.json"))
ap.add_argument("--out", default="D:/PIS-clips-out/deck/Mach_Von_Gioi_Thieu_He_Thong_Phu_My.pptx")
ap.add_argument("--preview", default="D:/PIS-clips-out/deck/preview")
ap.add_argument("--font", default="Segoe UI", help="phong trong theme; do chu luon do bang Segoe UI")
args = ap.parse_args()

content = json.load(open(args.content, encoding="utf-8"))
META = content["meta"]
SL = {s["id"]: s for s in content["slides"]}
A = Path(args.assets)

prs = Presentation(args.template)

# ---------------------------------------------------------------- 1. bo slide cu, thumbnail cu
sldIdLst = prs.slides._sldIdLst
for sldId in list(sldIdLst):
    prs.part.drop_rel(sldId.rId)
    sldIdLst.remove(sldId)
pkg = prs.part.package
for rId, rel in list(pkg._rels.items()):
    if rel.reltype.endswith("/thumbnail"):
        pkg._rels.pop(rId)

# ---------------------------------------------------------------- 2. theme: mau va phong Phu My
master = prs.slide_master
theme_part = master.part.part_related_by(RT.THEME)
troot = etree.fromstring(theme_part.blob)
troot.set("name", "Phu My - Mach Von")
scheme = {"dk1": INK, "lt1": WHITE, "dk2": TEAL_D, "lt2": T100, "accent1": TEAL, "accent2": ORANGE,
          "accent3": "74BBBB", "accent4": "F58B64", "accent5": GREY, "accent6": T400, "hlink": TEAL_D, "folHlink": GREY}
cs = troot.find(f".//{{{NSA}}}clrScheme")
cs.set("name", "Phu My")
for k, v in scheme.items():
    el = cs.find(f"{{{NSA}}}{k}")
    for ch in list(el):
        el.remove(ch)
    etree.SubElement(el, f"{{{NSA}}}srgbClr").set("val", v)
fs = troot.find(f".//{{{NSA}}}fontScheme")
fs.set("name", "Phu My")
for tag in ("majorFont", "minorFont"):
    fs.find(f"{{{NSA}}}{tag}/{{{NSA}}}latin").set("typeface", args.font)
theme_part._blob = etree.tostring(troot, xml_declaration=True, encoding="UTF-8", standalone=True)

# ---------------------------------------------------------------- 3. layout
def layout_by(name):
    return next(l for l in prs.slide_layouts if l.name == name)


def strip_layout(layout, keep_types):
    for sh in list(layout.placeholders):
        if sh.placeholder_format.type not in keep_types:
            sh._element.getparent().remove(sh._element)


def ph_style(ph, x, y, w, h, size, bold, color, anchor="t", font="+mj-lt"):
    ph.left, ph.top, ph.width, ph.height = Emu(int(x * EMU)), Emu(int(y * EMU)), Emu(int(w * EMU)), Emu(int(h * EMU))
    tx = ph._element.txBody
    body = tx.find(qn("a:bodyPr"))
    for k, v in (("lIns", "45720"), ("rIns", "45720"), ("tIns", "27432"), ("bIns", "27432"), ("anchor", anchor), ("wrap", "square")):
        body.set(k, v)
    for ch in list(body):
        body.remove(ch)
    etree.SubElement(body, qn("a:noAutofit"))
    ls = tx.find(qn("a:lstStyle"))
    for ch in list(ls):
        ls.remove(ch)
    lvl = etree.SubElement(ls, qn("a:lvl1pPr"))
    lvl.set("marL", "0")
    lvl.set("indent", "0")
    lvl.set("algn", "l")
    etree.SubElement(lvl, qn("a:buNone"))
    d = etree.SubElement(lvl, qn("a:defRPr"))
    d.set("sz", str(int(size * 100)))
    d.set("b", "1" if bold else "0")
    sf = etree.SubElement(d, qn("a:solidFill"))
    etree.SubElement(sf, qn("a:srgbClr")).set("val", color)
    etree.SubElement(d, qn("a:latin")).set("typeface", font)


def layout_canvas(layout):
    return Canvas(SlideShapes(layout.shapes._spTree, layout), A, name="layout:" + layout.name)


def add_slidenum(cv, x, y, w, h, color, align="r"):
    tb = cv.text(x, y, w, h, "0", size=9, color=color, align=align, anchor="m")
    p = tb.text_frame.paragraphs[0]._p
    for r in p.findall(qn("a:r")):
        p.remove(r)
    fld = etree.Element(qn("a:fld"))
    fld.set("id", "{B6F15528-21DE-4FAA-801E-634DDDAF4B2B}")
    fld.set("type", "slidenum")
    rpr = etree.SubElement(fld, qn("a:rPr"))
    rpr.set("lang", "vi-VN")
    rpr.set("sz", "900")
    sf = etree.SubElement(rpr, qn("a:solidFill"))
    etree.SubElement(sf, qn("a:srgbClr")).set("val", color)
    etree.SubElement(fld, qn("a:t")).text = "‹#›"
    p.insert(1 if p.find(qn("a:pPr")) is not None else 0, fld)


from pptx.enum.shapes import PP_PLACEHOLDER as PH  # noqa: E402

LAYOUT_CV = {}

# 3a. Title Slide = bia
lay = layout_by("Title Slide")
strip_layout(lay, (PH.CENTER_TITLE, PH.SUBTITLE))
ph_style(lay.placeholders[0], 95, 282, 1000, 170, 44, True, TEAL, "t")
ph_style(lay.placeholders[1], 95, 458, 1060, 70, 18, False, GREY, "t", "+mn-lt")
cv = layout_canvas(lay)
cv.shape(860, -320, 800, 800, fill=T100, kind="oval")
cv.shape(960, 330, 560, 560, fill=T200, kind="oval")
cv.shape(1301, 0, 32, 750, fill=TEAL)
cv.shape(1289, 0, 5, 750, fill=ORANGE)
LAYOUT_CV["Title Slide"] = cv

# 3b. Title Only = trang noi dung (dau trang, logo, chan trang)
lay = layout_by("Title Only")
strip_layout(lay, (PH.TITLE,))
ph_style(lay.placeholders[0], 60, 48, 975, 58, 30, True, TEAL, "ctr")
cv = layout_canvas(lay)
cv.shape(0, 0, W, 12, fill=TEAL)
cv.shape(420, 0, 220, 12, fill=ORANGE)
cv.pic("dpm-logo-wordmark.png", 1098, 30, 175, 32, mode="contain", alt="Logo Phú Mỹ")
cv.shape(60, 700, 1213, 1, fill=T200)
cv.text(60, 705, 900, 30, META["footer"], size=9, color=GREY, anchor="m")
cv.pic("machvon-logo-enterprise-mark.png", 1196, 704, 30, 26, mode="contain", alt="Biểu tượng Mạch Vốn")
add_slidenum(cv, 1233, 705, 40, 30, GREY)
LAYOUT_CV["Title Only"] = cv

# 3c. Section Header = trang nen xanh (phu luc, cam on)
lay = layout_by("Section Header")
strip_layout(lay, (PH.TITLE, PH.BODY))
ph_style(lay.placeholders[0], 95, 250, 1000, 120, 40, True, WHITE, "b")
ph_style(lay.placeholders[1], 95, 385, 900, 90, 18, False, T200, "t", "+mn-lt")
cv = layout_canvas(lay)
cv.shape(0, 0, W, H, fill=TEAL_D)
cv.shape(900, -300, 760, 760, fill="347F7F", kind="oval")
cv.shape(1000, 380, 520, 520, fill="2F7777", kind="oval")
cv.shape(1301, 0, 32, 750, fill=ORANGE)
LAYOUT_CV["Section Header"] = cv
# dua cac hinh ve vao dau cay hinh de nam duoi cac khung chu
for name in ("Title Slide", "Section Header"):
    lay = layout_by(name)
    tree = lay.shapes._spTree
    shapes = [e for e in tree if e.tag in (qn("p:sp"), qn("p:pic")) and e.find(".//" + qn("p:ph")) is None]
    first_ph = next(e for e in tree if e.tag == qn("p:sp") and e.find(".//" + qn("p:ph")) is not None)
    for e in shapes:
        tree.remove(e)
        first_ph.addprevious(e)

# ---------------------------------------------------------------- 4. tien ich slide
WARN = []
SLIDES = []  # (id, canvas, layout name)


def new_slide(layout_name, sid):
    s = prs.slides.add_slide(layout_by(layout_name))
    cv = Canvas(s.shapes, A, name=sid)
    SLIDES.append((sid, cv, layout_name, s))
    return s, cv


def set_ph(ph, paras, size, bold, cv, w, h, after=4, minsize=20):
    """Dien chu vao khung giu cho, tu thu nho de vua hop."""
    paras = [Para(p) if isinstance(p, str) else p for p in paras] if isinstance(paras, list) else [Para(paras)]
    sc = cv.fit_scale(paras, size, bold, w, h, after, minsize)
    tf = ph.text_frame
    for i, p in enumerate(paras):
        para = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        pt = round((p.size or size) * sc * 2) / 2
        for t, b in parse_runs(p.text, bool(p.bold if p.bold is not None else bold)):
            r = para.add_run()
            r.text = t
            if sc < 0.999 or p.size:
                r.font.size = Pt(pt)
            if p.color:
                r.font.color.rgb = rgb(p.color)
        if p.after is not None:
            para.space_after = Pt(p.after * 0.72)
    cv.prims.append(("text", ph.left / EMU, ph.top / EMU, ph.width / EMU, ph.height / EMU,
                     [(p, round((p.size or size) * sc * 2) / 2, bool(p.bold if p.bold is not None else bold), p.color or TEAL, "l") for p in paras],
                     "m" if size < 40 else "t", (5, 3), after))


def content_slide(sid, subtitle=None):
    d = SL[sid]
    s, cv = new_slide("Title Only", sid)
    set_ph(s.shapes.title, d["title"], 30, True, cv, 975, 58, minsize=22)
    cv.text(60, 24, 800, 24, d["eyebrow"], size=11, bold=True, color=ORANGE_D, anchor="m")
    sub = subtitle if subtitle is not None else d.get("subtitle")
    if sub:
        cv.text(60, 106, 1150, 40, sub, size=15, color=GREY, anchor="t", minsize=12)
    s.notes_slide.notes_text_frame.text = d["notes"]
    return s, cv, d


def circle(cv, x, y, dia, label, fill=TEAL_D, size=16):
    cv.shape(x, y, dia, dia, fill=fill, kind="oval", text=str(label), size=size, bold=True, color=WHITE)


# ---------------------------------------------------------------- 5. cac slide
def s_cover():
    d = SL["cover"]
    s, cv = new_slide("Title Slide", "cover")
    cv.pic("dpm-logo-lockup.png", 85, 70, 330, 95, mode="contain", alt="Logo Phú Mỹ - Sẻ chia thịnh vượng")
    cv.line(450, 80, 450, 175, color=T300, lw=1.5)
    cv.pic("machvon-logo-enterprise-horizontal.png", 485, 78, 340, 95, mode="contain", alt="Logo Mạch Vốn - Phần mềm quản lý đầu tư xây dựng")
    cv.text(85, 172, 350, 36, d["label_customer"], size=8, color=GREY, bold=True, minsize=7)
    cv.text(485, 172, 340, 36, d["label_product"], size=8, color=GREY, bold=True, minsize=7)
    cv.shape(95, 252, 55, 3, fill=ORANGE)
    cv.text(165, 238, 600, 30, d["eyebrow"], size=14, bold=True, color=ORANGE_D, anchor="m")
    t = s.shapes.title
    set_ph(t, [Para(d["title"], size=44, color=TEAL), Para(d["title2"], size=30, color=INK, bold=True)], 44, True, cv, 1000, 170, after=6, minsize=30)
    set_ph(s.placeholders[1], d["subtitle"], 18, False, cv, 1060, 70, minsize=14)
    cv.text(95, 695, 900, 30, d["confidential"], size=9, color=GREY, anchor="m")
    s.notes_slide.notes_text_frame.text = d["notes"]


def s_problem():
    s, cv, d = content_slide("problem")
    cv.shape(60, 160, 470, 525, fill=T100, kind="round", r=14)
    cv.text(80, 172, 430, 30, d["panel_title"], size=16, bold=True, color=TEAL_D, anchor="m")
    for i, f in enumerate(d["forms"]):
        y = 214 + i * 92
        circle(cv, 80, y + 18, 40, i + 1)
        cv.text(132, y, 385, 84, f, size=13.5, anchor="m")
    pos = [(570, 168), (933, 168), (570, 428), (933, 428)]
    for (x, y), st in zip(pos, d["stats"]):
        cv.shape(x + 5, y, 50, 5, fill=ORANGE)
        cv.text(x, y + 12, 340, 72, st["num"], size=44, bold=True, color=TEAL, anchor="m")
        cv.text(x, y + 86, 340, 34, st["label"], size=17, bold=True, anchor="m")
        cv.text(x, y + 122, 340, 100, st["desc"], size=13.5, color=GREY)


def s_issues():
    s, cv, d = content_slide("issues")
    for i, (t, ds) in enumerate(d["items"]):
        y = 162 + i * 105
        circle(cv, 60, y + 22, 46, i + 1, size=18)
        cv.text(125, y, 670, 96, f"**{t}** {ds}", size=15, anchor="m")
    cv.shape(830, 160, 443, 455, fill=T100)
    cv.text(850, 172, 403, 30, d["panel_title"], size=16, bold=True, color=TEAL_D, anchor="m")
    cv.text(850, 204, 403, 24, d["panel_sub"], size=12, color=GREY, anchor="m")
    cv.text(850, 240, 403, 360, [Para(x, bullet=True, after=10) for x in d["panel_items"]], size=14)
    cv.shape(830, 615, 443, 70, fill=TEAL_D, text=d["panel_bottom"], size=13, bold=True, color=WHITE, align="l")


def s_goals():
    s, cv, d = content_slide("goals")
    for i, c in enumerate(d["cards"]):
        x = 60 + i * (290 + 17.67)
        cv.shape(x, 165, 290, 180, fill=T100)
        cv.shape(x, 165, 290, 5, fill=TEAL)
        cv.text(x + 12, 178, 266, 48, c["big"], size=28, bold=True, color=TEAL, anchor="m")
        cv.text(x + 12, 228, 266, 40, c["title"], size=15, bold=True, anchor="m")
        cv.text(x + 12, 270, 266, 70, c["desc"], size=12.5, color=GREY)
    cv.text(60, 360, 700, 30, d["flow_title"], size=16, bold=True, anchor="m")
    n = len(d["flow"])
    for i, (a, b) in enumerate(d["flow"]):
        x = 60 + i * 237
        cv.shape(x, 398, 262, 70, fill=ORANGE_D if i == n - 1 else TEAL_D, kind="pentagon" if i == 0 else "chevron",
                 text=f"{i + 1}. {a}", size=16, bold=True, color=WHITE)
        cv.text(x + 22, 474, 215, 70, b, size=12.5, color=GREY, align="l")
    cv.shape(60, 590, 1213, 85, fill=O100, kind="round", r=10)
    cv.shape(60, 590, 6, 85, fill=ORANGE)
    cv.text(82, 590, 1170, 85, d["callout"], size=15, anchor="m")


def s_architecture():
    s, cv, d = content_slide("architecture")
    for x, k in ((60, "col_users"), (330, "col_core"), (860, "col_hub")):
        cv.text(x, 154, 400, 24, d[k], size=11, bold=True, color=GREY, anchor="m")
    for i, (t, ds) in enumerate(d["users"]):
        y = 183 + i * 95
        cv.shape(60, y, 215, 82, fill=WHITE, line=TEAL, lw=1.5, kind="round", r=10,
                 text=[Para(t, bold=True, color=TEAL_D, size=14), Para(ds, size=11.5, color=GREY)], align="l", after=2)
        cv.line(275, y + 41, 330, y + 41, color=TEAL, lw=1.5, arrow=True)
    cv.shape(60, 480, 215, 112, fill=O100, line=ORANGE, lw=1.5, kind="round", r=10,
             text=[Para(d["identity"][0], bold=True, color=ORANGE_D, size=14), Para(d["identity"][1], size=11.5, color=INK)], align="l", after=2)
    cv.line(275, 536, 330, 536, color=ORANGE, lw=1.5, arrow=True)
    cv.shape(330, 180, 470, 405, fill=T100, line=T300, kind="round", r=14)
    cv.shape(345, 192, 440, 36, fill=TEAL_D, text=d["core_api"], size=13, bold=True, color=WHITE)
    for i, c in enumerate(d["chips"]):
        cv.shape(345 + (i % 2) * 225, 240 + (i // 2) * 54, 215, 46, fill=WHITE, line=T400, kind="round", r=8, text=c, size=12.5, bold=True)
    cv.shape(345, 408, 440, 40, fill=T300, kind="round", r=8, text=d["snapshot"], size=13, bold=True)
    for i, (t, ds) in enumerate(d["stores"]):
        cv.shape(345 + i * 225, 460, 215, 60, fill=WHITE, line=T400, kind="round", r=8,
                 text=[Para(t, bold=True, size=12.5, color=TEAL_D), Para(ds, size=11, color=GREY)], after=1)
    cv.shape(345, 530, 440, 38, fill=WHITE, line=T400, kind="round", r=8, text=d["audit"], size=12)
    cv.shape(860, 180, 413, 405, fill=WHITE, line=TEAL, lw=1.5, kind="round", r=14)
    cv.text(875, 188, 383, 30, d["hub_title"], size=14, bold=True, color=TEAL_D, anchor="m")
    for i, (t, ds) in enumerate(d["hub"]):
        cv.shape(875, 222 + i * 70, 383, 62, fill=T100, kind="round", r=8,
                 text=[Para(t, bold=True, size=13.5, color=INK), Para(ds, size=12, color=GREY)], align="l", after=1)
    cv.line(800, 382, 860, 382, color=TEAL, lw=1.5, arrow=True, both=True)
    cv.text(60, 608, 1213, 60, d["foot"], size=13, color=GREY, anchor="m")


def s_integration():
    s, cv, d = content_slide("integration")
    cx = [60, 330, 975]
    cw = [270, 645, 298]
    cv.shape(60, 160, 1213, 38, fill=TEAL_D)
    for x, w, t in zip(cx, cw, d["cols"]):
        cv.text(x + 8, 160, w - 8, 38, t, size=13, bold=True, color=WHITE, anchor="m")
    for i, (a, b, c) in enumerate(d["rows"]):
        y = 198 + i * 75
        cv.shape(60, y, 1213, 75, fill=BG if i % 2 == 0 else WHITE)
        cv.text(cx[0] + 8, y, cw[0] - 8, 75, a, size=14, bold=True, color=TEAL_D, anchor="m")
        cv.text(cx[1] + 8, y, cw[1] - 8, 75, b, size=12.5, anchor="m")
        st, txt = c.split("|")
        cv.shape(cx[2] + 8, y + 31, 13, 13, fill=TEAL if st == "ok" else ORANGE, kind="oval")
        cv.text(cx[2] + 26, y, cw[2] - 26, 75, txt, size=12.5, bold=True, color=TEAL_D if st == "ok" else ORANGE_D, anchor="m")
    cv.text(60, 652, 1213, 40, d["foot"], size=12.5, color=GREY, anchor="m")


def s_readpath():
    s, cv, d = content_slide("readpath")
    cv.shape(60, 235, 215, 150, fill=T100, kind="round", r=12,
             text=[Para(d["source"][0], bold=True, size=15, color=TEAL_D), Para(d["source"][1], size=12.5, color=GREY)], after=4)
    cv.line(275, 310, 335, 310, color=TEAL, lw=2, arrow=True)
    cv.shape(335, 190, 285, 240, fill=TEAL_D, kind="round", r=14)
    cv.text(355, 204, 245, 36, d["snap_title"], size=20, bold=True, color=WHITE, anchor="m")
    cv.text(355, 248, 245, 170, [Para(x, bullet=True, after=8) for x in d["snap_items"]], size=13.5, color=WHITE)
    for i, (t, ds) in enumerate(d["outputs"]):
        y = 170 + i * 98
        cv.shape(740, y, 533, 86, fill=T100, kind="round", r=10)
        cv.shape(740, y, 6, 86, fill=ORANGE)
        cv.text(760, y + 4, 503, 78, [Para(t, bold=True, size=15, color=TEAL_D), Para(ds, size=13, color=GREY)], anchor="m", after=2)
        cv.line(620, 310, 740, y + 43, color=TEAL, lw=1.5, arrow=True)
    cv.shape(60, 578, 1213, 106, fill=O100, kind="round", r=10)
    cv.shape(60, 578, 6, 106, fill=ORANGE)
    cv.text(82, 578, 1170, 106, [Para(d["honest_title"], bold=True, color=ORANGE_D, size=15), Para(d["honest"], size=13.5)], anchor="m", after=3)


def s_cards4():
    s, cv, d = content_slide("features-a")
    for i, c in enumerate(d["cards"]):
        x, y = 60 + (i % 2) * 619, 160 + (i // 2) * 258
        cv.shape(x, y, 594, 240, fill=WHITE, line=T300, lw=1.25, kind="round", r=12)
        cv.shape(x, y, 594, 5, fill=TEAL)
        circle(cv, x + 20, y + 22, 42, i + 1, size=17)
        cv.text(x + 74, y + 18, 500, 50, c["title"], size=17, bold=True, color=TEAL_D, anchor="m")
        cv.text(x + 20, y + 78, 556, 150, [Para(b, bullet=True, after=8) for b in c["bullets"]], size=15)
    cv.text(60, 668, 1213, 30, d["foot"], size=11.5, color=GREY, anchor="m", minsize=10)


def s_shots(sid):
    s, cv, d = content_slide(sid)
    n = len(d["shots"])
    if n == 2:
        w, gap, ih, ty, dy, dh, ts, ds_ = 594, 25, 349, 518, 552, 135, 18, 15.5
    else:
        w, gap, ih, ty, dy, dh, ts, ds_ = 388, 24.5, 228, 398, 432, 255, 16, 14
    for i, sh in enumerate(d["shots"]):
        x = 60 + i * (w + gap)
        cv.pic(sh["img"], x, 160, w, ih, mode="cover", border=T300, alt=sh["alt"])
        cv.shape(x, ty, 50, 4, fill=ORANGE)
        cv.text(x, ty + 6, w, 32, sh["title"], size=ts, bold=True, color=TEAL_D, anchor="m")
        cv.text(x, dy + 8, w, dh - 8, sh["desc"], size=ds_, color=INK)


def s_phone():
    s, cv, d = content_slide("phone")
    for i, (img, cap) in enumerate(d["phones"]):
        x = 60 + i * 270
        cv.pic(img, x, 160, 248, 480, mode="cover", alt=cap)
        cv.text(x, 646, 248, 28, cap, size=12, color=GREY, align="c", anchor="m")
    cv.text(630, 165, 643, 340, [Para(b, bullet=True, after=12) for b in d["bullets"]], size=16.5)
    cv.shape(630, 520, 643, 150, fill=O100, kind="round", r=10)
    cv.shape(630, 520, 6, 150, fill=ORANGE)
    cv.text(652, 520, 610, 150, d["callout"], size=13.5, anchor="m")


def s_security():
    s, cv, d = content_slide("security")
    for key, x in (("left", 60), ("right", 679)):
        p = d[key]
        cv.shape(x, 160, 594, 524, fill=WHITE, line=T300, lw=1.25)
        cv.shape(x, 160, 594, 44, fill=TEAL_D, text=p["title"], size=16, bold=True, color=WHITE, align="l")
        cv.text(x + 14, 211, 300, 25, d["have_label"], size=11, bold=True, color=TEAL_D, anchor="m")
        cv.text(x + 10, 236, 574, 215, [Para(t, bullet=True, after=6) for t in p["have"]], size=13)
        cv.shape(x + 14, 458, 566, 1, fill=T200)
        cv.text(x + 14, 463, 300, 25, d["todo_label"], size=11, bold=True, color=ORANGE_D, anchor="m")
        cv.text(x + 10, 488, 574, 190, [Para(t, bullet=True, after=6) for t in p["todo"]], size=13)


def s_compliance():
    d = SL["compliance"]
    req = json.load(open(args.req, encoding="utf-8"))
    rows = req["rows"]
    total = len(rows)
    cnt = Counter(r["status"] for r in rows)
    for k in ("DONE", "PARTIAL", "PENDING-EXTERNAL", "MISSING"):
        cnt.setdefault(k, 0)
    s, cv, _ = content_slide("compliance", subtitle=d["subtitle_fmt"].format(total=total, date=req.get("readOn", "")))
    groups = defaultdict(Counter)
    for r in rows:
        groups[r["code"].split(".")[0]][r["status"]] += 1
    col = {"DONE": (TEAL_D, WHITE), "PARTIAL": (T400, INK), "PENDING-EXTERNAL": (ORANGE_D, WHITE), "MISSING": (GREY, WHITE)}
    x = 60.0
    for k in ("DONE", "PARTIAL", "PENDING-EXTERNAL", "MISSING"):
        if cnt[k]:
            w = 1213 * cnt[k] / total
            cv.shape(x, 160, w, 44, fill=col[k][0], text=str(cnt[k]), size=16, bold=True, color=col[k][1])
            x += w
    lx = 60
    for k in ("DONE", "PARTIAL", "PENDING-EXTERNAL", "MISSING"):
        lab = f"{d['labels'][k]}: **{cnt[k]}**"
        wl = int(tw(lab.replace('**', ''), 12.5, True)) + 40
        cv.shape(lx, 219, 14, 14, fill=col[k][0])
        cv.text(lx + 18, 213, wl, 26, lab, size=12.5, anchor="m")
        lx += wl + 22
    order = ["MD", "DL", "QT", "CN", "BC", "TH", "HT", "YCK", "TK", "GD", "SP"]
    unit = 50
    for i, g in enumerate(order):
        y = 256 + i * 36
        cv.text(60, y, 215, 32, d["groups"][g], size=13, anchor="m")
        xx = 280.0
        for k in ("DONE", "PARTIAL", "PENDING-EXTERNAL", "MISSING"):
            c = groups[g][k]
            if c:
                cv.shape(xx, y + 2, unit * c - 2, 28, fill=col[k][0], text=str(c), size=12, bold=True, color=col[k][1])
                xx += unit * c
    cv.shape(860, 256, 413, 395, fill=T100, kind="round", r=12)
    cv.text(878, 266, 380, 28, d["read_title"], size=16, bold=True, color=TEAL_D, anchor="m")
    cv.text(878, 300, 380, 345, [Para(t, bullet=True, after=9) for t in d["read"]], size=13)
    cv.text(60, 664, 1213, 26, d["foot"], size=10.5, color=GREY, anchor="m", minsize=9)
    return cnt, total


def s_roadmap():
    s, cv, d = content_slide("roadmap")
    for i, (name, prod, ok) in enumerate(d["stages"]):
        x = 60 + i * 170
        cv.shape(x, 160, 190, 62, fill=TEAL_D if i < 6 else TEAL, kind="pentagon" if i == 0 else "chevron",
                 text=f"GĐ{i + 1}", size=17, bold=True, color=WHITE)
        cv.text(x, 228, 168, 52, name, size=13, bold=True, color=TEAL_D, anchor="t")
        cv.text(x, 282, 166, 150, prod, size=12, color=INK)
        cv.shape(x + 4, 438, 150, 26, fill=T100, kind="round", r=13, text=f"Duyệt: {ok}", size=11.5, bold=True, color=TEAL_D)
    cv.shape(60, 485, 1213, 132, fill=O100, kind="round", r=10)
    cv.shape(60, 485, 6, 132, fill=ORANGE)
    cv.text(82, 485, 1170, 132, [Para(d["status_title"], bold=True, color=ORANGE_D, size=15), Para(d["status"], size=13.5)], anchor="m", after=4)
    cv.text(60, 632, 1213, 50, d["plan"], size=14, bold=True, color=TEAL_D, anchor="m")


def s_customer():
    s, cv, d = content_slide("customer")
    for i, c in enumerate(d["cols"]):
        x = 60 + i * (293 + 13.67)
        cv.shape(x, 160, 293, 58, fill=TEAL_D, text=c["head"], size=14, bold=True, color=WHITE, align="l")
        cv.shape(x, 218, 293, 400, fill=T100)
        cv.text(x + 8, 228, 277, 385, [Para(t, bullet=True, after=9) for t in c["items"]], size=12.5)
    cv.shape(60, 630, 6, 54, fill=ORANGE)
    cv.text(80, 630, 1190, 54, d["foot"], size=13.5, color=INK, anchor="m")


def s_demo():
    s, cv, d = content_slide("demo")
    for i, (img, cap) in enumerate(d["shots"]):
        x, y = 60 + (i % 3) * 412.5, 158 + (i // 3) * 242
        cv.pic(img, x, y, 388, 210, mode="cover", border=T300, alt=cap)
        cv.text(x, y + 212, 388, 26, cap, size=13, bold=True, color=TEAL_D, anchor="m")
    cv.text(60, 648, 1213, 40, d["foot"], size=12, color=GREY, anchor="m", minsize=10)


def s_divider():
    d = SL["appendix-divider"]
    s, cv = new_slide("Section Header", "appendix-divider")
    cv.shape(95, 222, 55, 3, fill=ORANGE)
    cv.text(165, 208, 500, 30, d["eyebrow"], size=14, bold=True, color=T300, anchor="m")
    set_ph(s.shapes.title, d["title"], 40, True, cv, 1000, 120, minsize=28)
    cv.prims[-1] = cv.prims[-1][:5] + ([(Para(d["title"]), 40, True, WHITE, "l")],) + cv.prims[-1][6:]
    set_ph(s.placeholders[1], d["body"], 18, False, cv, 900, 90, minsize=14)
    cv.prims[-1] = cv.prims[-1][:5] + ([(Para(d["body"]), 18, False, T200, "l")],) + cv.prims[-1][6:]
    cv.shape(95, 520, 470, 130, fill=WHITE, kind="round", r=14)
    cv.pic("machvon-logo-public-horizontal.png", 115, 535, 430, 100, mode="contain", alt="Logo Mạch Vốn - Hệ thống quản lý đầu tư công")
    s.notes_slide.notes_text_frame.text = d["notes"]


def s_public():
    s, cv, d = content_slide("public")
    cv.text(60, 156, 430, 26, "BẢN ĐẦU TƯ CÔNG", size=11, bold=True, color=GREY, anchor="m")
    cv.pic("machvon-logo-public-horizontal.png", 60, 182, 430, 120, mode="contain", border=T200, alt="Logo Mạch Vốn - Hệ thống quản lý đầu tư công")
    cv.text(60, 328, 430, 26, "BẢN DÀNH CHO PHÚ MỸ (ENTERPRISE)", size=11, bold=True, color=GREY, anchor="m")
    cv.pic("machvon-logo-enterprise-horizontal.png", 60, 354, 430, 120, mode="contain", border=T200, alt="Logo Mạch Vốn - Phần mềm quản lý đầu tư xây dựng")
    cv.shape(60, 500, 430, 150, fill=T100, kind="round", r=10)
    cv.text(76, 500, 400, 150, "Hai bản dùng chung một nền tảng và một lõi mã; khác nhau ở phần mã riêng của khách và các kết nối.", size=14, anchor="m")
    for i, (a, b) in enumerate(d["points"]):
        y = 160 + i * 106
        cv.shape(530, y, 743, 1, fill=T200)
        cv.text(530, y + 6, 160, 90, a, size=15, bold=True, color=TEAL_D, anchor="t")
        cv.text(695, y + 6, 578, 94, b, size=13.5, anchor="t")


def s_closing():
    d = SL["closing"]
    s, cv = new_slide("Section Header", "closing")
    cv.shape(80, 60, 790, 130, fill=WHITE, kind="round", r=14)
    cv.pic("dpm-logo-lockup.png", 105, 75, 330, 100, mode="contain", alt="Logo Phú Mỹ - Sẻ chia thịnh vượng")
    cv.line(470, 80, 470, 170, color=T300, lw=1.5)
    cv.pic("machvon-logo-enterprise-horizontal.png", 500, 75, 350, 100, mode="contain", alt="Logo Mạch Vốn")
    set_ph(s.shapes.title, d["title"], 40, True, cv, 1000, 120, minsize=28)
    cv.prims[-1] = cv.prims[-1][:5] + ([(Para(d["title"]), 40, True, WHITE, "l")],) + cv.prims[-1][6:]
    s.shapes.title.left, s.shapes.title.top, s.shapes.title.width, s.shapes.title.height = Emu(95 * EMU), Emu(215 * EMU), Emu(560 * EMU), Emu(110 * EMU)
    body = s.placeholders[1]
    body.left, body.top, body.width, body.height = Emu(95 * EMU), Emu(335 * EMU), Emu(560 * EMU), Emu(110 * EMU)
    set_ph(body, d["subtitle"], 20, False, cv, 560, 110, minsize=14)
    cv.prims[-1] = cv.prims[-1][:5] + ([(Para(d["subtitle"]), 20, False, T200, "l")],) + cv.prims[-1][6:]
    cv.shape(700, 215, 573, 245, fill=WHITE, kind="round", r=14)
    cv.shape(700, 215, 6, 245, fill=ORANGE)
    cv.text(724, 225, 535, 34, d["next_title"], size=17, bold=True, color=TEAL_D, anchor="m")
    cv.text(724, 266, 535, 190, [Para(t, bullet=True, after=9) for t in d["next"]], size=14)
    cv.text(95, 520, 1100, 30, d["org"], size=14, bold=True, color=WHITE, anchor="m")
    for i, (a, b) in enumerate(d["contact"]):
        y = 560 + i * 40
        cv.text(95, y, 130, 34, a, size=14, color=T300, bold=True, anchor="m")
        cv.text(230, y, 1000, 34, b, size=14, color=WHITE, anchor="m")
    cv.text(95, 685, 700, 26, d["source_note"], size=10, color=T300, anchor="m")
    s.notes_slide.notes_text_frame.text = d["notes"]


s_cover()
s_problem()
s_issues()
s_goals()
s_architecture()
s_integration()
s_readpath()
s_cards4()
s_shots("features-b")
s_shots("features-c")
s_shots("features-d")
s_phone()
s_security()
cnt, total = s_compliance()
s_roadmap()
s_customer()
s_demo()
s_divider()
s_public()
s_closing()

# ---------------------------------------------------------------- 6. thuoc tinh tep, luu
cp = prs.core_properties
cp.title, cp.subject, cp.keywords = META["title"], META["subject"], META["keywords"]
cp.author, cp.last_modified_by, cp.comments = "Mạch Vốn", "Mạch Vốn", "Dựng bằng scripts/deck/build_deck.py từ mẫu Slide_Gioi_Thieu_Nen_Tang_Chuoi_Cung_Ung_Nguyen_Kim_20261015-ver2"
cp.category = ""
Path(args.out).parent.mkdir(parents=True, exist_ok=True)
prs.save(args.out)

# ---------------------------------------------------------------- 7. xem truoc (mo phong tu danh sach hinh, khong phai ban ve that cua PowerPoint)
prev = Path(args.preview)
prev.mkdir(parents=True, exist_ok=True)
for f in prev.glob("*.png"):
    f.unlink()
nwarn = 0
for i, (sid, cv, lname, _) in enumerate(SLIDES, 1):
    comb = Canvas(None, A, record=False)
    comb.prims = LAYOUT_CV[lname].prims + cv.prims
    comb.preview(prev / f"{i:02d}-{sid}.png")
    for w_ in cv.warn:
        print(w_)
        nwarn += 1
for cvl in LAYOUT_CV.values():
    for w_ in cvl.warn:
        print(w_)
        nwarn += 1
print(f"Da luu {args.out}: {len(SLIDES)} trang; {nwarn} canh bao tran chu; DONE={cnt['DONE']} PARTIAL={cnt['PARTIAL']} PENDING={cnt['PENDING-EXTERNAL']} MISSING={cnt['MISSING']} tong={total}")
