"""Convertir PDF a Word EDITABLE con fidelidad visual (habilidad convertir-pdf-word, versión 0.5.0).

Reconstruye cada página con texto real, tablas nativas (con sus filetes) y celdas sin bordes en flujo normal (la técnica
del piloto v01 aprobado), sin páginas completas como imagen y sin marcos ni VML posicionados.

- Regiones: las figuras complejas (maquetas de interfaz, capturas, fotografías) se conservan como imagen de SU región,
  con su texto en el texto alternativo; nunca una página entera. Las tarjetas claras con texto son celdas sombreadas.
- Disposición por cortes X-Y (canales verticales primero, luego los huecos mayores): columnas, tablas reales cuando las
  filas se alinean, listas con sangría francesa, muestras de color en la misma línea que su texto.
- Posición vertical con espaciados; las líneas del PDF se conservan con saltos de línea; recortes del PDF respetados.
- Imágenes inline con distancias en cero e interlineado automático (lecciones de MEMORIA.md); propiedades OOXML en el
  orden del esquema (Word es más estricto que LibreOffice).
- Con --ajustar: se renderiza con LibreOffice y las páginas que desbordan se rehacen a menor escala (máx. 3 intentos).

Uso: python convertir_editable.py origen.pdf salida.docx [--paginas 1 2 ...] [--escala 1.0] [--informe salida.json]
     [--ajustar carpeta_trabajo] [--reintentos 3]   (LibreOffice: variable SOFFICE o soffice en el PATH)
Sin red ni servicios externos. Requiere PyMuPDF y python-docx (en .dependencias del agente si no están instalados).
Límite honesto: el texto DENTRO de las figuras no es editable (queda como texto alternativo de la imagen).
"""
from __future__ import annotations

import argparse
import io
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
DEPS = ROOT / ".dependencias"
if DEPS.is_dir() and str(DEPS) not in sys.path:
    sys.path.insert(0, str(DEPS))

import fitz  # noqa: E402
from docx import Document  # noqa: E402
from docx.enum.section import WD_ORIENT, WD_SECTION_START  # noqa: E402
from docx.enum.table import WD_ROW_HEIGHT_RULE  # noqa: E402
from docx.enum.text import WD_LINE_SPACING  # noqa: E402
from docx.oxml import OxmlElement  # noqa: E402
from docx.oxml.ns import qn  # noqa: E402
from docx.shared import Pt, RGBColor  # noqa: E402

VERSION = "0.5.0"
MARGIN = 18.0           # márgenes de la página Word (pt); el contenido conserva su posición con espaciados
RENDER_ZOOM = 2.5       # 180 ppp para las regiones gráficas
GAP_X = 2.5             # separación mínima entre columnas (líneas distintas del PDF)
TOL_ROW = 3.0           # tolerancia de alineación de filas
LIST_MARK = re.compile(r"^\s*(\d{1,3}[.)]|[a-zA-Z][.)]|[•·▪◦‣\-–—])\s")
ROW_GAP = 3.5           # hueco mínimo entre filas de una tabla (mayor que el interlineado)
WORD_RE = re.compile(r"[0-9A-Za-zÁÉÍÓÚÜÑáéíóúüñ#%$]{2,}")

# ---------------------------------------------------------------- utilidades de formato

def font_name(raw: str) -> str:
    n = re.sub(r"^[A-Z]{6}\+", "", raw or "")
    low = n.lower()
    if "consolas" in low:
        return "Consolas"
    if "fluent" in low:
        return "Segoe Fluent Icons"
    if "segoeuisymbol" in low.replace(" ", "") or "segoe ui symbol" in low:
        return "Segoe UI Symbol"
    if "segoe" in low:
        return "Segoe UI"
    if "roboto" in low:
        return "Roboto"
    if "courier" in low:
        return "Courier New"
    if "times" in low:
        return "Times New Roman"
    return "Arial"


def hex_color(c: int) -> str:
    return f"{(c >> 16) & 255:02X}{(c >> 8) & 255:02X}{c & 255:02X}"


def set_run(run, size: float, font: str, color: str, bold: bool, italic: bool):
    run.font.size = Pt(round(size * 2) / 2)
    run.font.name = font
    run.font.bold = bold
    run.font.italic = italic
    run.font.color.rgb = RGBColor.from_string(color)
    rpr = run._element.get_or_add_rPr()
    rf = rpr.find(qn("w:rFonts"))
    if rf is None:
        rf = OxmlElement("w:rFonts"); rpr.insert(0, rf)
    for k in ("w:ascii", "w:hAnsi", "w:cs", "w:eastAsia"):
        rf.set(qn(k), font)


TBLPR_ORDER = ["tblStyle", "tblpPr", "tblOverlap", "bidiVisual", "tblStyleRowBandSize", "tblStyleColBandSize", "tblW", "jc",
               "tblCellSpacing", "tblInd", "tblBorders", "shd", "tblLayout", "tblCellMar", "tblLook", "tblCaption",
               "tblDescription", "tblPrChange"]
TCPR_ORDER = ["cnfStyle", "tcW", "gridSpan", "hMerge", "vMerge", "tcBorders", "shd", "noWrap", "tcMar", "textDirection",
              "tcFitText", "vAlign", "hideMark", "headers", "cellIns", "cellDel", "cellMerge", "tcPrChange"]
PPR_TAIL = ["rPr", "sectPr", "pPrChange"]
BORDER_ORDER = ["top", "start", "left", "bottom", "end", "right", "insideH", "insideV", "tl2br", "tr2bl"]


def put(parent, child, order: list[str]):
    """Inserta `child` (o reemplaza el existente) en `parent` respetando el orden del esquema OOXML."""
    tag = child.tag.split("}")[1]
    old = parent.find(qn("w:" + tag))
    if old is not None:
        parent.replace(old, child)
        return child
    rank = order.index(tag)
    for existing in parent:
        et = existing.tag.split("}")[1]
        if et in order and order.index(et) > rank:
            existing.addprevious(child)
            return child
    parent.append(child)
    return child


def tiny_mark(paragraph, size_half_points: int = 2):
    """Marca de párrafo de 1 pt (los párrafos de servicio no añaden altura)."""
    ppr = paragraph._p.get_or_add_pPr()
    rpr = ppr.find(qn("w:rPr"))
    if rpr is None:
        rpr = put(ppr, OxmlElement("w:rPr"), PPR_TAIL)
    sz = rpr.find(qn("w:sz"))
    if sz is None:
        sz = OxmlElement("w:sz"); rpr.append(sz)
    sz.set(qn("w:val"), str(size_half_points))


def exact(paragraph, line_pt: float, before: float = 0.0, indent: float = 0.0):
    pf = paragraph.paragraph_format
    pf.space_before = Pt(max(0.0, round(before, 2)))
    pf.space_after = Pt(0)
    pf.line_spacing_rule = WD_LINE_SPACING.EXACTLY
    pf.line_spacing = Pt(max(1.0, round(line_pt, 2)))
    if indent > 0.5:
        pf.left_indent = Pt(round(indent, 2))


def table_fixed(table, widths: list[float]):
    tbl = table._tbl
    tblPr = tbl.tblPr
    table.autofit = False  # w:tblLayout fixed, en su sitio
    tw = OxmlElement("w:tblW"); tw.set(qn("w:w"), str(int(sum(widths) * 20))); tw.set(qn("w:type"), "dxa")
    put(tblPr, tw, TBLPR_ORDER)
    mar = OxmlElement("w:tblCellMar")
    for side in ("top", "left", "bottom", "right"):
        e = OxmlElement(f"w:{side}"); e.set(qn("w:w"), "0"); e.set(qn("w:type"), "dxa"); mar.append(e)
    put(tblPr, mar, TBLPR_ORDER)
    grid = tbl.tblGrid
    for gc, w in zip(grid.findall(qn("w:gridCol")), widths):
        gc.set(qn("w:w"), str(int(w * 20)))
    for row in table.rows:
        for cell, w in zip(row.cells, widths):
            cell.width = Pt(w)


def shade(cell, fill: str):
    tcPr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement("w:shd"); shd.set(qn("w:val"), "clear"); shd.set(qn("w:color"), "auto"); shd.set(qn("w:fill"), fill)
    put(tcPr, shd, TCPR_ORDER)


def cell_border(cell, side: str, color: str, width_pt: float):
    """Filete de una celda (las líneas separadoras de las tablas del original)."""
    tcPr = cell._tc.get_or_add_tcPr()
    borders = tcPr.find(qn("w:tcBorders"))
    if borders is None:
        borders = put(tcPr, OxmlElement("w:tcBorders"), TCPR_ORDER)
    b = OxmlElement(f"w:{side}")
    b.set(qn("w:val"), "single"); b.set(qn("w:sz"), str(max(2, min(96, int(round(width_pt * 8))))))
    b.set(qn("w:space"), "0"); b.set(qn("w:color"), color)
    put(borders, b, BORDER_ORDER)


RPR_ORDER = ["rStyle", "rFonts", "b", "bCs", "i", "iCs", "caps", "smallCaps", "strike", "dstrike", "outline", "shadow",
             "emboss", "imprint", "noProof", "snapToGrid", "vanish", "webHidden", "color", "spacing", "w", "kern",
             "position", "sz", "szCs", "highlight", "u", "effect", "bdr", "shd", "fitText", "vertAlign", "rtl", "cs", "em",
             "lang", "eastAsianLayout", "specVanish", "oMath"]


def condense(run, twentieths: int):
    """Espaciado de caracteres negativo (w:spacing en vigésimos de punto), en su sitio del esquema."""
    sp = OxmlElement("w:spacing"); sp.set(qn("w:val"), str(-abs(twentieths)))
    put(run._element.get_or_add_rPr(), sp, RPR_ORDER)


def inline_zero(run):
    for inl in run._element.iter(qn("wp:inline")):
        for k in ("distT", "distB", "distL", "distR"):
            inl.set(k, "0")


# ---------------------------------------------------------------- análisis de la página

class El:
    __slots__ = ("kind", "x0", "y0", "x1", "y1", "data", "children")

    def __init__(self, kind, rect, data=None, children=None):
        self.kind = kind; self.x0, self.y0, self.x1, self.y1 = rect; self.data = data; self.children = children or []

    @property
    def w(self): return self.x1 - self.x0

    @property
    def h(self): return self.y1 - self.y0


def contains(outer, inner, tol=1.0):
    return inner[0] >= outer[0] - tol and inner[1] >= outer[1] - tol and inner[2] <= outer[2] + tol and inner[3] <= outer[3] + tol


def overlap(a, b) -> float:
    return max(0.0, min(a[2], b[2]) - max(a[0], b[0])) * max(0.0, min(a[3], b[3]) - max(a[1], b[1]))


def center_in(outer, inner):
    cx = (inner[0] + inner[2]) / 2; cy = (inner[1] + inner[3]) / 2
    return outer[0] <= cx <= outer[2] and outer[1] <= cy <= outer[3]


def visible_drawings(page) -> list[dict]:
    """Dibujos con su rectángulo VISIBLE (recortado por los trazados de recorte activos)."""
    out = []; clips: dict[int, fitz.Rect] = {}
    for it in page.get_drawings(extended=True):
        lvl = it.get("level", 0)
        if it["type"] == "clip":
            clips = {k: v for k, v in clips.items() if k < lvl}
            clips[lvl] = fitz.Rect(it["scissor"])
            continue
        if it["type"] == "group":
            continue
        vis = fitz.Rect(it["rect"])
        for k, sc in clips.items():
            if k < lvl:
                vis &= sc
        if vis.is_empty and not (vis.width > 0 or vis.height > 0):
            continue
        d = dict(it); d["rect"] = vis
        out.append(d)
    return out


def analyze(page) -> tuple[list[El], dict]:
    pw, ph = page.rect.width, page.rect.height
    area = pw * ph
    drawings = visible_drawings(page)
    images = [i for i in page.get_image_info(xrefs=True) if i["bbox"][2] - i["bbox"][0] > 2]
    # Regiones candidatas: dibujos grandes (no el fondo de página).
    cands = []
    for d in drawings:
        r = d["rect"]
        a = r.width * r.height
        if 0.02 * area <= a < 0.9 * area:
            cands.append([r.x0, r.y0, r.x1, r.y1, d])
    regions: list[list] = []
    for c in sorted(cands, key=lambda c: -(c[2] - c[0]) * (c[3] - c[1])):
        if any(contains(r, c[:4], 2) for r in regions):
            continue
        # Un dibujo que se sale de una figura mayor está recortado por ella: lo visible ya es parte de esa figura.
        if any(overlap(r, c[:4]) >= 0.25 * (c[2] - c[0]) * (c[3] - c[1]) for r in regions):
            continue
        regions.append(c)
    graphics: list[tuple] = []; cards: list[tuple] = []
    for r in regions:
        rect = tuple(r[:4]); d = r[4]
        inner = sum(1 for x in drawings if x is not d and contains(rect, tuple(x["rect"]), 1) and x["rect"].width * x["rect"].height < (rect[2] - rect[0]) * (rect[3] - rect[1]) * 0.95)
        imgs = sum(1 for i in images if center_in(rect, i["bbox"]))
        fill = d.get("fill")
        sat = (max(fill) - min(fill)) if fill else 0.0
        if imgs or inner >= 10 or sat > 0.25:
            graphics.append(rect)
        else:
            col = "".join(f"{int(round(v * 255)):02X}" for v in fill) if fill else None
            cards.append((rect, None if col in (None, "FFFFFF") else col))
    # Una tarjeta dentro de un gráfico forma parte del gráfico.
    cards = [c for c in cards if not any(contains(g, c[0], 2) for g in graphics)]
    figs: list[El] = [El("graphic", g, {"text": []}) for g in graphics]
    rules = []
    for d in drawings:
        r = d["rect"]
        if r.height <= 1.6 and r.width >= 15 and not any(center_in(g, (r.x0, r.y0, r.x1, r.y1)) for g in graphics):
            c = d.get("fill") or d.get("color") or (0, 0, 0)
            rules.append({"x0": r.x0, "x1": r.x1, "y": (r.y0 + r.y1) / 2, "w": max(0.25, r.height if d.get("fill") else (d.get("width") or 0.5)),
                          "color": "".join(f"{int(round(v * 255)):02X}" for v in c[:3])})
    els: list[El] = list(figs)
    for i in images:
        b = tuple(i["bbox"])
        if not any(center_in(g, b) for g in graphics):
            els.append(El("image", b))
    # Muestras de color pequeñas (swatches) fuera de los gráficos.
    for d in drawings:
        r = d["rect"]; f = d.get("fill")
        if f and 4 <= r.width <= 26 and 4 <= r.height <= 26 and abs(r.width - r.height) < 6:
            b = (r.x0, r.y0, r.x1, r.y1)
            if not any(center_in(g, b) for g in graphics) and not all(v > 0.97 for v in f):
                els.append(El("swatch", b, {"fill": "".join(f"{int(round(v * 255)):02X}" for v in f)}))
    # Líneas de texto (fuera de los gráficos).
    lines = []
    figure_words = 0
    for b in page.get_text("dict")["blocks"]:
        if b["type"] != 0:
            continue
        for ln in b["lines"]:
            spans = [s for s in ln["spans"] if s["text"].strip() != "" or s["text"] == " "]
            if not spans or not "".join(s["text"] for s in spans).strip():
                continue
            bb = tuple(ln["bbox"])
            owner = next((f for f in figs if center_in((f.x0, f.y0, f.x1, f.y1), bb)), None)
            if owner is not None:
                # El texto de una figura queda como texto alternativo de su imagen (accesible y buscable).
                txt = "".join(s["text"] for s in spans).strip()
                owner.data["text"].append(txt)
                figure_words += len(WORD_RE.findall(txt))
                continue
            lines.append(El("line", bb, {"spans": spans, "dir": ln["dir"]}))
    # Texto girado: no se reconstruye en flujo (se conserva como imagen de su zona).
    rotated = [l for l in lines if abs(l.data["dir"][1]) > 0.2]
    for l in rotated:
        els.append(El("graphic", (l.x0, l.y0, l.x1, l.y1), {"text": ["".join(s["text"] for s in l.data["spans"]).strip()]}))
        figure_words += len(WORD_RE.findall("".join(s["text"] for s in l.data["spans"])))
    lines = [l for l in lines if l not in rotated]
    # Tarjetas con su contenido.
    for rect, fill in cards:
        kids = [e for e in lines + [e for e in els if e.kind in ("image", "swatch")] if center_in(rect, (e.x0, e.y0, e.x1, e.y1))]
        if not kids:
            continue
        for k in kids:
            if k in lines: lines.remove(k)
            if k in els: els.remove(k)
        els.append(El("card", rect, {"fill": fill}, kids))
    els.extend(lines)
    stats = {"graphics": len(graphics), "cards": len([e for e in els if e.kind == "card"]), "lines": len(lines),
             "images": len([e for e in els if e.kind == "image"]), "swatches": len([e for e in els if e.kind == "swatch"]),
             "graphic_area_ratio": round(sum((g[2] - g[0]) * (g[3] - g[1]) for g in graphics) / area, 3),
             "figure_words": figure_words,
             "figures": [[round(v, 1) for v in (e.x0, e.y0, e.x1, e.y1)] for e in els if e.kind == "graphic"]}
    stats["rules"] = len(rules)
    return els, stats, rules


# ---------------------------------------------------------------- cortes X-Y

def split_gaps(els: list[El], axis: str, min_gap: float) -> tuple[list[list[El]], list[float]]:
    key0 = (lambda e: e.y0) if axis == "y" else (lambda e: e.x0)
    key1 = (lambda e: e.y1) if axis == "y" else (lambda e: e.x1)
    srt = sorted(els, key=key0)
    groups: list[list[El]] = []; gaps: list[float] = []; cur: list[El] = []; end = None
    for e in srt:
        if cur and key0(e) > end + min_gap:
            groups.append(cur); gaps.append(key0(e) - end); cur = []; end = None
        cur.append(e); end = key1(e) if end is None else max(end, key1(e))
    if cur:
        groups.append(cur)
    return groups, gaps


def split(els: list[El], axis: str, min_gap: float) -> list[list[El]]:
    return split_gaps(els, axis, min_gap)[0]


def prefix_like(e: El, els: list[El]) -> bool:
    """Muestra o icono pequeño con una línea de texto a su derecha (va en la misma línea)."""
    return e.kind in ("swatch", "image") and e.h <= 24 and any(
        l.kind == "line" and 0 <= l.x0 - e.x1 + 2 < 42 and min(l.y1, e.y1) - max(l.y0, e.y0) > 0.3 * min(l.h, e.h) for l in els)


def single_column(els: list[El]) -> bool:
    """Texto de una sola columna: solo líneas (y sus muestras) y ninguna banda se puede partir en columnas."""
    if any(e.kind not in ("line",) and not prefix_like(e, els) for e in els):
        return False
    core = [e for e in els if e.kind == "line"]
    return all(len(split(b, "x", GAP_X)) == 1 for b in split(core, "y", 0.4))


def bbox(els):
    return (min(e.x0 for e in els), min(e.y0 for e in els), max(e.x1 for e in els), max(e.y1 for e in els))


def xycut(els: list[El], depth=0):
    if len(els) <= 1 or depth > 16 or single_column(els):
        return ("leaf", els)
    bands, gy = split_gaps(els, "y", 0.4)
    cols, gx = split_gaps(els, "x", GAP_X)
    # Un canal vertical que recorre todo el bloque y deja columnas de texto (texto a columnas, tablas) manda
    # aunque sea estrecho; si no, decide el hueco mayor.
    if len(cols) > 1 and (len(bands) == 1 or max(gx) >= max(gy) or all(single_column(c) for c in cols)):
        groups = aligned_groups(cols)
        if len(groups) > 1:
            # Tablas o columnas vecinas cuyas filas no coinciden: cada una por su lado.
            return ("row", [xycut([e for c in g for e in c], depth + 1) for g in groups])
        tbl = as_table(cols)
        return ("table", tbl) if tbl else ("row", [xycut(c, depth + 1) for c in cols])
    if len(bands) > 1:
        # Se corta primero por los huecos mayores; los menores se resuelven dentro de cada parte.
        cut = max(gy) * 0.6
        parts: list[list[El]] = [bands[0]]
        for b, g in zip(bands[1:], gy):
            if g >= cut:
                parts.append(list(b))
            else:
                parts[-1] = parts[-1] + list(b)
        kids = [xycut(part, depth + 1) for part in parts]
        # Partes consecutivas de texto en una columna se emiten juntas (agrupación de párrafos).
        merged: list = []
        for k in kids:
            if merged and k[0] == "leaf" and merged[-1][0] == "leaf" and single_column(merged[-1][1] + k[1]):
                merged[-1] = ("leaf", merged[-1][1] + k[1])
            else:
                merged.append(k)
        merged = merge_row_runs(merged)
        return ("stack", merged) if len(merged) > 1 else merged[0]
    return ("leaf", els)


def node_elements(node) -> list[El]:
    kind, data = node
    if kind == "leaf":
        return list(data)
    if kind == "table":
        return [e for c in data["cols"] for e in c]
    return [e for child in data for e in node_elements(child)]


def column_lefts(node):
    kind, data = node
    if kind == "row":
        tops = [min(e.y0 for e in node_elements(c)) for c in data]
        if max(tops) - min(tops) > TOL_ROW:
            return None  # columnas que empiezan a distinta altura: no es una fila de tabla
        return [min(e.x0 for e in node_elements(c)) for c in data]
    if kind == "table":
        return [min(e.x0 for e in c) for c in data["cols"]]
    return None


def merge_row_runs(kids: list) -> list:
    """Filas consecutivas con las mismas columnas (cada una partida por un hueco vertical) → una sola tabla real."""
    out: list = []
    run: list = []

    def flush():
        if len(run) >= 2:
            ncol = len(column_lefts(run[0]))
            cols = [[] for _ in range(ncol)]
            rows, starts = [], []
            for k in run:
                kind, data = k
                if kind == "table":
                    for r, st in zip(data["rows"], data["starts"]):
                        rows.append(r); starts.append(st)
                        for i, cell in enumerate(r):
                            cols[i].extend(cell)
                else:
                    cells = [node_elements(c) for c in data]
                    rows.append(cells); starts.append(min(e.y0 for c in cells for e in c))
                    for i, cell in enumerate(cells):
                        cols[i].extend(cell)
            out.append(("table", {"cols": cols, "rows": rows, "starts": starts}))
        else:
            out.extend(run)
        run.clear()

    for k in kids:
        lefts = column_lefts(k)
        if lefts and len(lefts) >= 2:
            ref = column_lefts(run[0]) if run else None
            if ref is not None and len(ref) == len(lefts) and all(abs(a - b) <= 4 for a, b in zip(ref, lefts)):
                run.append(k)
                continue
            flush()
            run.append(k)
            continue
        flush()
        out.append(k)
    flush()
    return out


def row_gap(cols: list[list[El]]) -> float:
    """Hueco que separa filas: mayor que el interlineado de las líneas de una misma celda (según su altura)."""
    hs = sorted(e.h for c in cols for e in c if e.kind == "line")
    return max(ROW_GAP, 0.55 * hs[len(hs) // 2]) if hs else ROW_GAP


def aligned_groups(cols: list[list[El]]) -> list[list[list[El]]]:
    """Agrupa columnas contiguas cuyas filas empiezan a la misma altura (misma tabla)."""
    tops = [[min(e.y0 for e in b) for b in split(c, "y", row_gap(cols))] for c in cols]
    groups = [[cols[0]]]
    for i in range(1, len(cols)):
        a, b = tops[i - 1], tops[i]
        matched = sum(1 for t in b if any(abs(t - u) <= TOL_ROW for u in a))
        if matched / max(1, len(a), len(b)) >= 0.6:
            groups[-1].append(cols[i])
        else:
            groups.append([cols[i]])
    return groups


def as_table(cols: list[list[El]]):
    """Columnas cuyas bandas empiezan alineadas en ≥3 filas → tabla real (filas × columnas)."""
    if len(cols) < 2:
        return None
    # Columnas de listas numeradas o con viñetas son texto en columnas, no una tabla.
    for c in cols:
        firsts = [min((e for e in b if e.kind == "line"), key=lambda e: (e.y0, e.x0), default=None) for b in split(c, "y", row_gap(cols))]
        marked = sum(1 for f in firsts if f is not None and LIST_MARK.match(line_text(f)))
        if firsts and marked >= max(2, 0.5 * len(firsts)):
            return None
    # Filas: bloques separados por más que el interlineado (las líneas de una misma celda van juntas).
    gap = row_gap(cols)
    bands = [split(c, "y", gap) for c in cols]
    tops = [[min(e.y0 for e in b) for b in bs] for bs in bands]
    allt = sorted(t for ts in tops for t in ts)
    starts: list[float] = []
    for t in allt:
        hits = sum(1 for ts in tops if any(abs(x - t) <= TOL_ROW for x in ts))
        if hits >= 2 and (not starts or t - starts[-1] > TOL_ROW):
            starts.append(t)
    if len(starts) < 3:
        return None
    rows = [[[] for _ in cols] for _ in starts]
    for ci, bs in enumerate(bands):
        for b in bs:
            top = min(e.y0 for e in b)
            ri = max([i for i, s in enumerate(starts) if s <= top + TOL_ROW] or [0])
            rows[ri][ci].extend(b)
    aligned = sum(1 for r in rows if sum(1 for c in r if c) >= 2)
    if aligned < 3 or aligned < 0.5 * len(rows):
        return None
    return {"cols": cols, "rows": rows, "starts": starts}


# ---------------------------------------------------------------- emisión a Word

class Ctx:
    def __init__(self, page, scale, assets_dir):
        self.page = page; self.scale = scale; self.assets = assets_dir; self.anchor = None; self.rules = []
        self.stats = {"tables": 0, "layout_tables": 0, "pictures": 0, "paragraphs": 0, "editable_chars": 0, "max_picture_area_ratio": 0.0}


def render_region(ctx: Ctx, rect) -> io.BytesIO:
    clip = fitz.Rect(*rect) & ctx.page.rect
    pix = ctx.page.get_pixmap(matrix=fitz.Matrix(RENDER_ZOOM, RENDER_ZOOM), clip=clip, alpha=False)
    return io.BytesIO(pix.tobytes("png"))


def spacer(container, gap):
    if gap < 0.8:
        return
    p = container.add_paragraph(); exact(p, gap); tiny_mark(p)


def emit_picture(ctx: Ctx, container, e: El, before: float, indent: float):
    p = container.add_paragraph()
    pf = p.paragraph_format
    pf.space_before = Pt(max(0.0, round(before, 2))); pf.space_after = Pt(0)
    pf.line_spacing_rule = WD_LINE_SPACING.SINGLE
    if indent > 0.5:
        pf.left_indent = Pt(round(indent, 2))
    tiny_mark(p)
    add_picture_run(ctx, p, e)
    return p


def add_picture_run(ctx: Ctx, p, e: El):
    run = p.add_run()
    buf = render_region(ctx, (e.x0, e.y0, e.x1, e.y1))
    run.add_picture(buf, width=Pt(max(1.0, e.w * ctx.scale)))
    inline_zero(run)
    if e.kind == "graphic" and e.data and e.data.get("text"):
        for pr in run._element.iter(qn("wp:docPr")):
            pr.set("descr", " · ".join(e.data["text"])[:4000])
            pr.set("title", "Figura del original (su texto está en el texto alternativo)")
    ctx.stats["pictures"] += 1
    pa = ctx.page.rect.width * ctx.page.rect.height
    ctx.stats["max_picture_area_ratio"] = max(ctx.stats["max_picture_area_ratio"], round(e.w * e.h / pa, 3))
    return run


def para_groups(lines: list[El], starts: set[int] | None = None) -> list[list[El]]:
    """Líneas consecutivas del mismo bloque (mismo margen, tamaño y separación de párrafo) → un párrafo.
    `starts`: líneas que abren párrafo siempre (las que llevan una muestra o icono delante)."""
    starts = starts or set()
    out: list[list[El]] = []
    for l in sorted(lines, key=lambda e: (e.y0, e.x0)):
        if out and id(l) not in starts:
            g = out[-1]; prev = g[-1]
            size = max(s["size"] for s in l.data["spans"]); psize = max(s["size"] for s in prev.data["spans"])
            if len(g) > 1:
                same_margin = abs(l.x0 - g[1].x0) < 3
            else:
                # Sangría francesa de listas: «6. Texto…» y las líneas siguientes alineadas con el texto.
                hanging = 0 < l.x0 - g[0].x0 <= 18 and LIST_MARK.match(line_text(g[0])) is not None
                same_margin = abs(l.x0 - g[0].x0) < 3 or hanging
            if same_margin and abs(size - psize) < 0.6 and 0 <= l.y0 - prev.y1 < size * 0.9:
                g.append(l); continue
        out.append([l])
    return out


def line_text(l: El) -> str:
    return "".join(s["text"] for s in l.data["spans"])


def emit_prefixed(ctx: Ctx, container, pre: El, grp: list[El], left: float, right: float, prev_bottom: float) -> float:
    """Muestra o icono + su texto: tabla de dos celdas sin bordes (la imagen no altera el interlineado del texto)."""
    y0 = min(grp[0].y0, pre.y0)
    spacer(container, (y0 - prev_bottom) * ctx.scale)
    lead = max(0.0, pre.x0 - left)
    w_img = max(4.0, grp[0].x0 - pre.x0)
    w_txt = max(12.0, right - grp[0].x0)
    widths = ([lead] if lead > 1 else []) + [w_img, w_txt]
    t = container.add_table(rows=1, cols=len(widths)); table_fixed(t, [w * ctx.scale for w in widths])
    off = 1 if lead > 1 else 0
    img_cell = t.cell(0, off); txt_cell = t.cell(0, off + 1)
    emit_picture(ctx, img_cell, pre, (pre.y0 - y0) * ctx.scale, 0)
    bottom = emit_lines(ctx, txt_cell, grp, grp[0].y0, grp[0].x0, y0, right=right)
    for c in t.rows[0].cells:
        tidy_cell(c)
    ctx.stats["layout_tables"] += 1
    return max(bottom, pre.y1)


def emit_lines(ctx: Ctx, container, lines: list[El], top: float, left: float, prev_bottom: float,
               prefix: dict | None = None, right: float | None = None):
    """Párrafos con las líneas del PDF (saltos de línea), tipografía y color de cada fragmento.
    `prefix`: muestra de color o icono a la izquierda de la primera línea de un párrafo."""
    prefix = prefix or {}
    for grp in para_groups(lines, set(prefix)):
        pre = prefix.get(id(grp[0]))
        if pre is not None:
            edge = right if right is not None else max(l.x1 for l in grp) + 8
            prev_bottom = emit_prefixed(ctx, container, pre, grp, left, edge, prev_bottom)
            continue
        size = max(s["size"] for s in grp[0].data["spans"])
        pitch = (grp[-1].y0 - grp[0].y0) / (len(grp) - 1) if len(grp) > 1 else (grp[0].h)
        line_h = max(pitch, size * 1.12) * ctx.scale
        x0 = grp[0].x0
        y0 = grp[0].y0
        # La primera línea del párrafo empieza donde estaba en el PDF.
        before = (y0 - prev_bottom) * ctx.scale
        p = container.add_paragraph(); exact(p, line_h, before, (x0 - left) * ctx.scale)
        if len(grp) > 1 and grp[1].x0 - grp[0].x0 > 1.5:
            p.paragraph_format.left_indent = Pt(round((grp[1].x0 - left) * ctx.scale, 2))
            p.paragraph_format.first_line_indent = Pt(round((grp[0].x0 - grp[1].x0) * ctx.scale, 2))
        # Una línea que casi toca el borde de su columna se condensa un poco (no debe partirse en dos).
        tight = right is not None and right - max(l.x1 for l in grp) < 8
        if ctx.anchor is None:
            ctx.anchor = " ".join("".join(s["text"] for s in ln.data["spans"]) for ln in grp[:2])
        for li, ln in enumerate(grp):
            if li:
                p.add_run().add_break()
            for s in ln.data["spans"]:
                txt = s["text"].replace("\u00a0", " ")
                if not txt:
                    continue
                fl = s["flags"]; fn = s.get("font", "")
                bold = bool(fl & 16) or "bold" in fn.lower(); italic = bool(fl & 2) or "italic" in fn.lower() or "oblique" in fn.lower()
                r = p.add_run(txt)
                set_run(r, s["size"] * ctx.scale, font_name(fn), hex_color(s["color"]), bold, italic)
                if tight:
                    condense(r, 3)
                ctx.stats["editable_chars"] += len(txt.strip())
        prev_bottom = y0 + len(grp) * (line_h / ctx.scale)
        ctx.stats["paragraphs"] += 1
    return prev_bottom


def node_bbox(node):
    kind, data = node
    if kind == "leaf":
        return bbox(data)
    if kind == "table":
        return bbox([e for c in data["cols"] for e in c])
    return bbox_of_nodes(data)


def bbox_of_nodes(nodes):
    bs = [node_bbox(n) for n in nodes]
    return (min(b[0] for b in bs), min(b[1] for b in bs), max(b[2] for b in bs), max(b[3] for b in bs))


def emit_node(ctx: Ctx, container, node, left: float, right: float, prev_bottom: float, depth=0) -> float:
    """Emite un nodo dentro de `container` (cuerpo o celda) cuyo borde izquierdo es `left`. Devuelve el fondo alcanzado."""
    kind, data = node
    if kind == "stack":
        for child in data:
            prev_bottom = emit_node(ctx, container, child, left, right, prev_bottom, depth + 1)
        return prev_bottom
    if kind == "leaf":
        els = sorted(data, key=lambda e: (e.y0, e.x0))
        lines = [e for e in els if e.kind == "line"]
        others = [e for e in els if e.kind != "line"]
        if lines and not others:
            return emit_lines(ctx, container, lines, bbox(lines)[1], left, prev_bottom, None, right)
        # Muestras e iconos pequeños a la izquierda de una línea van en esa misma línea.
        prefix: dict[int, El] = {}
        for o in others:
            if o.kind not in ("swatch", "image") or o.h > 24:
                continue
            cand = [l for l in lines if l.x0 >= o.x1 - 2 and l.x0 - o.x1 < 40 and id(l) not in prefix
                    and min(l.y1, o.y1) - max(l.y0, o.y0) > 0.3 * min(l.h, o.h)]
            if cand:
                prefix[id(min(cand, key=lambda l: l.x0 - o.x1))] = o
        used = {id(o) for o in prefix.values()}
        seq = [e for e in els if id(e) not in used]
        i = 0
        while i < len(seq):
            e = seq[i]
            if e.kind == "line":
                j = i
                while j < len(seq) and seq[j].kind == "line":
                    j += 1
                run = seq[i:j]
                prev_bottom = emit_lines(ctx, container, run, run[0].y0, left, prev_bottom,
                                         {k: v for k, v in prefix.items() if any(id(l) == k for l in run)}, right)
                i = j
                continue
            if e.kind == "card":
                prev_bottom = emit_card(ctx, container, e, left, prev_bottom, depth)
            else:
                emit_picture(ctx, container, e, (e.y0 - prev_bottom) * ctx.scale, (e.x0 - left) * ctx.scale)
                prev_bottom = e.y1
            i += 1
        return prev_bottom
    # Columnas (fila de maquetación) o tabla real.
    cols = data["cols"] if kind == "table" else [n for n in data]
    boxes = [bbox(c) for c in data["cols"]] if kind == "table" else [node_bbox(n) for n in data]
    top = min(b[1] for b in boxes)
    spacer(container, (top - prev_bottom) * ctx.scale)
    lefts = [b[0] for b in boxes]
    widths = []
    lead = max(0.0, lefts[0] - left)
    for i, b in enumerate(boxes):
        nxt = lefts[i + 1] if i + 1 < len(boxes) else max(right, b[2])
        widths.append(max(6.0, nxt - b[0]))
    widths = [w * ctx.scale for w in widths]
    if lead > 1.0:
        widths = [lead * ctx.scale] + widths
    if kind == "table":
        nrows = len(data["rows"])
        t = container.add_table(rows=nrows, cols=len(widths))
        table_fixed(t, widths)
        off = 1 if lead > 1.0 else 0
        starts = data["starts"] + [bbox([e for c in data["cols"] for e in c])[3]]
        for ri, row in enumerate(data["rows"]):
            r = t.rows[ri]
            r.height = Pt(max(1.0, (starts[ri + 1] - starts[ri]) * ctx.scale)); r.height_rule = WD_ROW_HEIGHT_RULE.AT_LEAST
            row_bottom = max((e.y1 for c in row for e in c), default=starts[ri])
            next_top = starts[ri + 1] if ri + 1 < nrows else row_bottom + 9
            for ci, cell_els in enumerate(row):
                cell = t.cell(ri, ci + off)
                cx0 = boxes[ci][0]; cx1 = cx0 + widths[ci + off] / ctx.scale
                fill_cell(ctx, cell, cell_els, cx0, cx1, starts[ri], depth)
                for rule in ctx.rules:
                    span = min(rule["x1"], cx1) - max(rule["x0"], cx0)
                    if span < 0.5 * (cx1 - cx0):
                        continue
                    if row_bottom - 1 <= rule["y"] <= next_top + 1:
                        cell_border(cell, "bottom", rule["color"], rule["w"])
                    elif ri == 0 and starts[0] - 9 <= rule["y"] < starts[0]:
                        cell_border(cell, "top", rule["color"], rule["w"])
            if off:
                tidy_cell(t.cell(ri, 0))
        ctx.stats["tables"] += 1
    else:
        t = container.add_table(rows=1, cols=len(widths))
        table_fixed(t, widths)
        off = 1 if lead > 1.0 else 0
        for ci, child in enumerate(data):
            cell = t.cell(0, ci + off)
            b = boxes[ci]
            bottom = emit_node(ctx, cell, child, b[0], b[0] + widths[ci + off] / ctx.scale, top, depth + 1)
            tidy_cell(cell)
        if off:
            tidy_cell(t.cell(0, 0))
        ctx.stats["layout_tables"] += 1
    bottom = max(b[3] for b in boxes)
    return bottom


def fill_cell(ctx, cell, els, left, right, top, depth):
    if els:
        emit_node(ctx, cell, xycut(els), left, right, top, depth + 1)
    tidy_cell(cell)


def tidy_cell(cell):
    """La primera celda trae un párrafo vacío; si no se usó o sobra al final, se reduce a 1 pt (no añade altura)."""
    ps = cell.paragraphs
    if len(ps) > 1 and not ps[0].text and not ps[0]._p.xpath(".//w:drawing"):
        ps[0]._p.getparent().remove(ps[0]._p)
    for p in cell.paragraphs:
        if not p.text and not p._p.xpath(".//w:drawing") and not p.paragraph_format.line_spacing:
            exact(p, 1); tiny_mark(p)


def emit_card(ctx, container, card: El, left, prev_bottom, depth):
    spacer(container, (card.y0 - prev_bottom) * ctx.scale)
    lead = max(0.0, card.x0 - left)
    widths = ([lead * ctx.scale] if lead > 1 else []) + [card.w * ctx.scale]
    t = container.add_table(rows=1, cols=len(widths)); table_fixed(t, widths)
    cell = t.cell(0, len(widths) - 1)
    if card.data.get("fill"):
        shade(cell, card.data["fill"])
    pad = 6.0
    emit_node(ctx, cell, xycut(card.children), card.x0 + pad, card.x1 - pad, card.y0, depth + 1) if card.children else None
    # relleno interior: sangría izquierda de los párrafos de la tarjeta
    for p in cell.paragraphs:
        if p.text and not p.paragraph_format.left_indent:
            p.paragraph_format.left_indent = Pt(pad)
    tidy_cell(cell)
    if lead > 1:
        tidy_cell(t.cell(0, 0))
    t.rows[0].height = Pt(card.h * ctx.scale); t.rows[0].height_rule = WD_ROW_HEIGHT_RULE.AT_LEAST
    return card.y1


def convert(src: Path, out: Path, pages: list[int] | None, scale: float, scales: dict[int, float] | None = None) -> dict:
    """Convierte las páginas pedidas. `scales` ajusta páginas concretas (reintentos por desborde)."""
    scales = scales or {}
    doc = fitz.open(src)
    word = Document()
    st = word.styles["Normal"]; st.font.name = "Arial"; st.font.size = Pt(10); st.paragraph_format.space_after = Pt(0)
    body = word._body._body
    for p in list(body.iterchildren(qn("w:p"))):
        body.remove(p)
    report = {"tool": "convertir_editable.py", "version": VERSION, "source": src.name, "pages": [], "scale": scale}
    idx = [p - 1 for p in pages] if pages else list(range(len(doc)))
    for n, pi in enumerate(idx):
        page = doc[pi]
        sec = word.sections[0] if n == 0 else word.add_section(WD_SECTION_START.NEW_PAGE)
        if n:
            # el párrafo que guarda la sección anterior no debe añadir altura
            last = word.paragraphs[-1] if word.paragraphs else None
            if last is not None:
                exact(last, 1); tiny_mark(last)
        sec.page_width = Pt(page.rect.width); sec.page_height = Pt(page.rect.height)
        sec.orientation = WD_ORIENT.LANDSCAPE if page.rect.width > page.rect.height else WD_ORIENT.PORTRAIT
        sec.left_margin = sec.right_margin = Pt(MARGIN); sec.top_margin = Pt(MARGIN); sec.bottom_margin = Pt(4)
        sec.header_distance = sec.footer_distance = Pt(0)
        els, stats, rules = analyze(page)
        ctx = Ctx(page, scales.get(pi + 1, scale), None)
        ctx.rules = rules
        if els:
            emit_node(ctx, word, xycut(els), MARGIN, page.rect.width - MARGIN, MARGIN)
        else:
            p = word.add_paragraph(); exact(p, 1); tiny_mark(p)
        report["pages"].append({"page": pi + 1, "scale": ctx.scale, "anchor": ctx.anchor, **stats, **ctx.stats})
    # Word exige un párrafo tras una tabla final; ese párrafo de servicio no añade altura (el texto real no se toca).
    blocks = [c for c in body.iterchildren() if c.tag in (qn("w:p"), qn("w:tbl"))]
    if blocks and blocks[-1].tag == qn("w:tbl"):
        p = word.add_paragraph(); exact(p, 1); tiny_mark(p)
    out.parent.mkdir(parents=True, exist_ok=True)
    word.save(out)
    report["output"] = str(out)
    report["editable_chars"] = sum(p["editable_chars"] for p in report["pages"])
    report["figure_words"] = sum(p["figure_words"] for p in report["pages"])
    report["max_picture_area_ratio"] = max((p["max_picture_area_ratio"] for p in report["pages"]), default=0)
    return report


# ---------------------------------------------------------------- ajuste: render de comprobación y reintentos acotados

def norm_words(text: str) -> list[str]:
    return [w.lower() for w in WORD_RE.findall(text)]


def render_pdf(docx: Path, workdir: Path, soffice: str, profile: Path) -> Path:
    workdir.mkdir(parents=True, exist_ok=True)
    cmd = [soffice, f"-env:UserInstallation={profile.resolve().as_uri()}", "--headless", "--norestore",
           "--convert-to", "pdf", "--outdir", str(workdir), str(docx)]
    # LibreOffice trae su propio Python: las variables PYTHON* de este proceso lo hacen fallar al arrancar (0xC0000409).
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith("PYTHON")}
    subprocess.run(cmd, check=True, capture_output=True, timeout=900, env=env)
    pdf = workdir / (docx.stem + ".pdf")
    if not pdf.exists():
        raise RuntimeError("LibreOffice no produjo el PDF de comprobación")
    return pdf


def page_spans(report: dict, rendered: Path) -> list[int]:
    """Cuántas páginas del render ocupa cada página del original (1 = cabe). Se ancla con el primer texto de cada página."""
    rend = fitz.open(rendered)
    rw = [norm_words(p.get_text("text", sort=True)) for p in rend]
    starts: list[int] = []
    cursor = 0
    for n, pg in enumerate(report["pages"]):
        anchor = norm_words(pg.get("anchor") or "")[:6]
        found = None
        if anchor:
            for r in range(cursor, len(rw)):
                hay = " " + " ".join(rw[r]) + " "
                if " " + " ".join(anchor) + " " in hay:
                    found = r; break
        if found is None:
            found = min(cursor, max(0, len(rw) - 1))
        starts.append(found)
        cursor = found + 1
    ends = starts[1:] + [len(rw)]
    return [max(1, e - s) for s, e in zip(starts, ends)]


def convert_fitted(src: Path, out: Path, pages, scale: float, soffice: str, workdir: Path, tries: int = 3) -> dict:
    scales: dict[int, float] = {}
    attempts = []
    final = None
    for attempt in range(tries + 1):
        cand = workdir / f"intento-{attempt}.docx"
        if cand.exists():
            cand.unlink()
        rep = convert(src, cand, pages, scale, scales)
        rendered = render_pdf(cand, workdir / f"render-{attempt}", soffice, workdir / "perfil_lo")
        spans = page_spans(rep, rendered)
        over = [pg["page"] for pg, n in zip(rep["pages"], spans) if n > 1]
        attempts.append({"attempt": attempt, "overflowing_pages": over, "rendered_pages": sum(spans)})
        final = (cand, rep, over)
        if not over or attempt == tries:
            break
        for pn in over:
            scales[pn] = round(scales.get(pn, scale) * 0.94, 3)
    cand, rep, over = final
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(cand.read_bytes())
    rep["output"] = str(out)
    rep["attempts"] = attempts
    rep["overflowing_pages"] = over
    return rep


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("pdf", type=Path); ap.add_argument("docx", type=Path)
    ap.add_argument("--paginas", type=int, nargs="*"); ap.add_argument("--escala", type=float, default=1.0)
    ap.add_argument("--informe", type=Path)
    ap.add_argument("--ajustar", type=Path, help="carpeta de trabajo: comprobar con LibreOffice y reintentar desbordes")
    ap.add_argument("--soffice", default=os.environ.get("SOFFICE") or shutil.which("soffice") or r"C:\Program Files\LibreOffice\program\soffice.com")
    ap.add_argument("--reintentos", type=int, default=3)
    a = ap.parse_args()
    if a.docx.exists():
        sys.exit(f"No se sobrescribe {a.docx}: elige una versión nueva.")
    if a.ajustar:
        rep = convert_fitted(a.pdf, a.docx, a.paginas, a.escala, a.soffice, a.ajustar, max(0, min(a.reintentos, 5)))
    else:
        rep = convert(a.pdf, a.docx, a.paginas, a.escala)
    if a.informe:
        a.informe.write_text(json.dumps(rep, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps({k: rep.get(k) for k in ("output", "editable_chars", "figure_words", "max_picture_area_ratio", "overflowing_pages")}, ensure_ascii=False))


if __name__ == "__main__":
    main()
