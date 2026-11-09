"""Thu vien ve slide: dung toan cac hinh goc cua PowerPoint (python-pptx), do chu bang phong that de tu co chu
va ve ban xem truoc (PNG) tu cung danh sach hinh. Don vi toa do: 1/100 inch (trang 1333 x 750), nhu mau goc."""
import math
from pathlib import Path

from lxml import etree
from PIL import Image, ImageDraw, ImageFont
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE, MSO_CONNECTOR
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from pptx.oxml.ns import qn
from pptx.util import Emu, Pt

EMU = 9144
W, H = 1333, 750
FONT_DIR = Path("C:/Windows/Fonts")
FONT_FILES = {False: "segoeui.ttf", True: "segoeuib.ttf"}
LINE_H = 1.36  # chieu cao dong / co chu (Segoe UI)
PX_PER_PT = 100 / 72

TEAL, TEAL_D, ORANGE, ORANGE_D = "389E9E", "2B7C7C", "F15A22", "C8470F"
INK, GREY, GREY_L, LINE = "2B323B", "6B7076", "95989D", "E1E8EA"
T100, T200, T300, T400 = "EBF5F5", "D7ECEC", "C3E2E2", "9BCFCF"
O100, O200 = "FEEFE9", "FCDED3"
WHITE, BG = "FFFFFF", "F9F9F9"

_fonts = {}


def _font(pt, bold):
    key = (round(pt * 4), bold)
    if key not in _fonts:
        _fonts[key] = ImageFont.truetype(str(FONT_DIR / FONT_FILES[bold]), max(4, int(round(pt * PX_PER_PT * 4))))
    return _fonts[key]


def _fd(pt_scaled, bold):
    key = ("d", round(pt_scaled * 4), bold)
    if key not in _fonts:
        _fonts[key] = ImageFont.truetype(str(FONT_DIR / FONT_FILES[bold]), max(4, int(round(pt_scaled * PX_PER_PT))))
    return _fonts[key]


def tw(s, pt, bold=False):
    return _font(pt, bold).getlength(s) / 4


def rgb(h):
    return RGBColor.from_string(h)


def parse_runs(s, bold=False):
    """'a **b** c' -> [(a,False),(b,True),(c,False)]"""
    out = []
    for i, part in enumerate(s.split("**")):
        if part:
            out.append((part, (not bold) if i % 2 else bold))
    return out or [("", bold)]


def wrap_para(s, pt, bold, width):
    """Tra ve danh sach dong, moi dong la list (chuoi, dam)."""
    toks = []
    for text, b in parse_runs(s, bold):
        for i, w in enumerate(text.split(" ")):
            if w == "" and i > 0:
                continue
            toks.append((w, b))
    lines, cur, cw = [], [], 0.0
    sp = tw(" ", pt)
    for w, b in toks:
        ww = tw(w, pt, b)
        add = ww + (sp if cur else 0)
        if cur and cw + add > width:
            lines.append(cur)
            cur, cw = [(w, b)], ww
        else:
            cur.append((w, b))
            cw += add
    lines.append(cur)
    return lines


class Para:
    def __init__(self, text, size=None, bold=None, color=None, bullet=False, after=None, align=None):
        self.text, self.size, self.bold, self.color = text, size, bold, color
        self.bullet, self.after, self.align = bullet, after, align


def norm_paras(paras):
    if isinstance(paras, (str, Para, dict)):
        paras = [paras]
    return [p if isinstance(p, Para) else (Para(**p) if isinstance(p, dict) else Para(p)) for p in paras]


INS_X, INS_Y = 5, 3
BUL_IND = 14


def measure(paras, size, bold, width, after, ins=(INS_X, INS_Y), sc=1.0):
    h = 0.0
    ps = norm_paras(paras)
    for p in ps:
        pt = round((p.size or size) * sc * 2) / 2
        b = bool(bold if p.bold is None else p.bold)
        w = width - 2 * ins[0] - (BUL_IND if p.bullet else 0)
        n = len(wrap_para(p.text, pt, b, w))
        h += n * pt * PX_PER_PT * LINE_H + (after if p.after is None else p.after)
    last = ps[-1].after if ps and ps[-1].after is not None else after
    return h + 2 * ins[1] - last


class Canvas:
    """Mot trang (hoac mot layout) dang ve. Ghi lai hinh de xem truoc va bao tran chu."""

    def __init__(self, shapes, assets, record=True, name=""):
        self.sh, self.assets, self.record, self.name = shapes, Path(assets), record, name
        self.prims, self.warn = [], []

    def _style(self, shp, fill, line, lw):
        if fill:
            shp.fill.solid()
            shp.fill.fore_color.rgb = rgb(fill)
        else:
            shp.fill.background()
        if line:
            shp.line.color.rgb = rgb(line)
            shp.line.width = Emu(int(lw * 12700))
        else:
            shp.line.fill.background()
        sppr = shp._element.spPr
        if sppr.find(qn("a:effectLst")) is None:
            etree.SubElement(sppr, qn("a:effectLst"))
        st = shp._element.find(qn("p:style"))
        if st is not None:
            shp._element.remove(st)

    def shape(self, x, y, w, h, fill=None, line=None, lw=1, kind="rect", r=None, text=None, size=14, color=INK,
              bold=False, align="c", anchor="m", name=None, after=4, minsize=9, adj=None):
        m = {"rect": MSO_SHAPE.RECTANGLE, "round": MSO_SHAPE.ROUNDED_RECTANGLE, "oval": MSO_SHAPE.OVAL,
             "chevron": MSO_SHAPE.CHEVRON, "pentagon": MSO_SHAPE.PENTAGON}[kind]
        s = self.sh.add_shape(m, Emu(int(x * EMU)), Emu(int(y * EMU)), Emu(int(w * EMU)), Emu(int(h * EMU)))
        if name:
            s.name = name
        if kind == "round":
            s.adjustments[0] = min(0.5, (r if r is not None else 10) / min(w, h))
        if kind in ("chevron", "pentagon"):
            s.adjustments[0] = adj if adj is not None else 0.4
        self._style(s, fill, line, lw)
        if self.record:
            self.prims.append(("shape", kind, x, y, w, h, fill, line, lw, r))
        if text is not None:
            ins = (INS_X, INS_Y) if kind not in ("chevron", "pentagon") else (int(h * 0.4), INS_Y)
            self._write(s.text_frame, x, y, w, h, text, size, color, bold, align, anchor, after, minsize, ins=ins)
        return s

    def text(self, x, y, w, h, paras, size=14, color=INK, bold=False, align="l", anchor="t", after=4, minsize=9,
             name=None):
        tb = self.sh.add_textbox(Emu(int(x * EMU)), Emu(int(y * EMU)), Emu(int(w * EMU)), Emu(int(h * EMU)))
        if name:
            tb.name = name
        self._write(tb.text_frame, x, y, w, h, paras, size, color, bold, align, anchor, after, minsize)
        return tb

    def fit_scale(self, paras, size, bold, w, h, after, minsize, ins=(INS_X, INS_Y)):
        sc = 1.0
        while measure(paras, size, bold, w, after, ins, sc) > h and size * sc > minsize + 0.01:
            sc -= 0.02
        need = measure(paras, size, bold, w, after, ins, sc)
        if need > h + 0.5:
            first = norm_paras(paras)[0].text[:40]
            self.warn.append(f"TRAN CHU [{self.name}] '{first}' hop {w:.0f}x{h:.0f}, can {need:.0f}")
        return sc

    def _write(self, tf, x, y, w, h, paras, size, color, bold, align, anchor, after, minsize, ins=(INS_X, INS_Y)):
        paras = norm_paras(paras)
        sc = self.fit_scale(paras, size, bold, w, h, after, minsize, ins)
        tf.word_wrap = True
        tf.auto_size = None
        tf.margin_left = tf.margin_right = Emu(ins[0] * EMU)
        tf.margin_top = tf.margin_bottom = Emu(ins[1] * EMU)
        tf.vertical_anchor = {"t": MSO_ANCHOR.TOP, "m": MSO_ANCHOR.MIDDLE, "b": MSO_ANCHOR.BOTTOM}[anchor]
        shown = []
        for i, p in enumerate(paras):
            para = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
            pt = round((p.size or size) * sc * 2) / 2
            b = bool(bold if p.bold is None else p.bold)
            col = p.color or color
            al = p.align or align
            para.alignment = {"l": PP_ALIGN.LEFT, "c": PP_ALIGN.CENTER, "r": PP_ALIGN.RIGHT}[al]
            para.space_after = Pt((after if p.after is None else p.after) * 0.72)
            para.line_spacing = 1.0
            if p.bullet:
                ppr = para._p.get_or_add_pPr()
                ppr.set("marL", str(int(BUL_IND * EMU)))
                ppr.set("indent", str(-int(BUL_IND * EMU)))
                bc = etree.SubElement(ppr, qn("a:buClr"))
                etree.SubElement(bc, qn("a:srgbClr")).set("val", TEAL)
                etree.SubElement(ppr, qn("a:buChar")).set("char", "•")
            for t, rb in parse_runs(p.text, b):
                r = para.add_run()
                r.text = t
                r.font.size = Pt(pt)
                r.font.bold = rb
                r.font.color.rgb = rgb(col)
            shown.append((p, pt, b, col, al))
        if self.record:
            self.prims.append(("text", x, y, w, h, shown, anchor, ins, after))

    def pic(self, path, x, y, w, h, mode="cover", border=None, name=None, alt=None):
        p = Path(path) if Path(path).is_absolute() else self.assets / path
        im = Image.open(p)
        iw, ih = im.size
        if mode == "cover":
            pic = self.sh.add_picture(str(p), Emu(int(x * EMU)), Emu(int(y * EMU)), Emu(int(w * EMU)), Emu(int(h * EMU)))
            ar_box, ar_img = w / h, iw / ih
            if ar_img > ar_box:
                c = (1 - ar_box / ar_img) / 2
                pic.crop_left = pic.crop_right = c
            else:
                c = (1 - ar_img / ar_box) / 2
                pic.crop_top = pic.crop_bottom = c
            bx, by, bw, bh = x, y, w, h
        else:
            sc = min(w / iw, h / ih)
            bw, bh = iw * sc, ih * sc
            bx, by = x + (w - bw) / 2, y + (h - bh) / 2
            pic = self.sh.add_picture(str(p), Emu(int(bx * EMU)), Emu(int(by * EMU)), Emu(int(bw * EMU)), Emu(int(bh * EMU)))
        if border:
            pic.line.color.rgb = rgb(border)
            pic.line.width = Emu(int(0.75 * 12700))
        if name:
            pic.name = name
        pic._element.nvPicPr.cNvPr.set("descr", alt or name or p.stem)
        if self.record:
            self.prims.append(("pic", str(p), bx, by, bw, bh, mode, (x, y, w, h)))
        return pic

    def line(self, x1, y1, x2, y2, color=TEAL, lw=1.5, arrow=False, both=False):
        c = self.sh.add_connector(MSO_CONNECTOR.STRAIGHT, Emu(int(x1 * EMU)), Emu(int(y1 * EMU)), Emu(int(x2 * EMU)), Emu(int(y2 * EMU)))
        c.line.color.rgb = rgb(color)
        c.line.width = Emu(int(lw * 12700))
        ln = c.line._get_or_add_ln()
        if both:
            etree.SubElement(ln, qn("a:headEnd")).set("type", "triangle")
        if arrow:
            etree.SubElement(ln, qn("a:tailEnd")).set("type", "triangle")
        st = c._element.find(qn("p:style"))
        if st is not None:
            c._element.remove(st)
        if self.record:
            self.prims.append(("line", x1, y1, x2, y2, color, lw, arrow))
        return c

    def preview(self, path, scale=1.0, bg="FFFFFF"):
        im = Image.new("RGB", (int(W * scale), int(H * scale)), "#" + bg)
        d = ImageDraw.Draw(im)
        S = lambda v: v * scale
        for pr in self.prims:
            k = pr[0]
            if k == "shape":
                _, kind, x, y, w, h, fill, line, lw, r = pr
                box = [S(x), S(y), S(x + w), S(y + h)]
                f = "#" + fill if fill else None
                o = "#" + line if line else None
                if kind == "oval":
                    d.ellipse(box, fill=f, outline=o, width=int(lw))
                elif kind == "round":
                    d.rounded_rectangle(box, radius=S(r if r is not None else 10), fill=f, outline=o, width=int(lw))
                elif kind in ("chevron", "pentagon"):
                    n = h * 0.4
                    pts = [(x, y), (x + w - n, y), (x + w, y + h / 2), (x + w - n, y + h), (x, y + h)]
                    if kind == "chevron":
                        pts.append((x + n, y + h / 2))
                    d.polygon([(S(a), S(b)) for a, b in pts], fill=f, outline=o)
                else:
                    d.rectangle(box, fill=f, outline=o, width=int(lw))
            elif k == "pic":
                _, p, x, y, w, h, mode, full = pr
                im2 = Image.open(p).convert("RGBA")
                if mode == "cover":
                    fx, fy, fw, fh = full
                    ar_b, ar_i = fw / fh, im2.width / im2.height
                    if ar_i > ar_b:
                        nw = im2.height * ar_b
                        im2 = im2.crop((int((im2.width - nw) / 2), 0, int((im2.width + nw) / 2), im2.height))
                    else:
                        nh = im2.width / ar_b
                        im2 = im2.crop((0, int((im2.height - nh) / 2), im2.width, int((im2.height + nh) / 2)))
                im2 = im2.resize((max(1, int(S(w))), max(1, int(S(h)))))
                im.paste(im2.convert("RGB"), (int(S(x)), int(S(y))), im2.split()[3])
            elif k == "line":
                _, x1, y1, x2, y2, c, lw, ar = pr
                d.line([(S(x1), S(y1)), (S(x2), S(y2))], fill="#" + c, width=max(1, int(lw)))
                if ar:
                    a = math.atan2(y2 - y1, x2 - x1)
                    for da in (2.6, -2.6):
                        d.line([(S(x2), S(y2)), (S(x2 + 10 * math.cos(a + da)), S(y2 + 10 * math.sin(a + da)))], fill="#" + c, width=max(1, int(lw)))
            elif k == "text":
                _, x, y, w, h, shown, anchor, ins, after = pr
                rows = []
                for p, pt, b, col, al in shown:
                    ww = w - 2 * ins[0] - (BUL_IND if p.bullet else 0)
                    for i, ln in enumerate(wrap_para(p.text, pt, b, ww)):
                        rows.append((ln, pt, col, al, p.bullet and i == 0, p.bullet, pt * PX_PER_PT * LINE_H))
                    rows.append((None, 0, None, None, False, False, p.after if p.after is not None else after))
                total = sum(r_[6] for r_ in rows[:-1]) + ins[1] * 2
                cy = y + ins[1] + (0 if anchor == "t" else (h - total) / 2 if anchor == "m" else h - total)
                for ln, pt, col, al, bul, isb, lh in rows:
                    if ln is None:
                        cy += lh
                        continue
                    wl = sum(tw(t, pt, b) for t, b in ln) + tw(" ", pt) * (len(ln) - 1)
                    ox = x + ins[0] + (BUL_IND if isb else 0)
                    aw = w - 2 * ins[0] - (BUL_IND if isb else 0)
                    cx = ox + (0 if al == "l" else (aw - wl) / 2 if al == "c" else aw - wl)
                    if bul:
                        d.text((S(x + ins[0]), S(cy)), "•", font=_fd(pt * scale, False), fill="#" + TEAL)
                    for t, b in ln:
                        d.text((S(cx), S(cy)), t, font=_fd(pt * scale, b), fill="#" + col)
                        cx += tw(t, pt, b) + tw(" ", pt)
                    cy += lh
        im.save(path)
