"""Control de calidad honesto de una conversión PDF → Word (Portal IA).

Comprueba, sin red y sin modificar el documento:
- editabilidad: texto real en el Word (w:t), sin páginas completas como imagen, sin marcos VML/posicionados ni fitText;
- integridad: recall de palabras del original en el Word y en su render (orden incluido), duplicados;
- forma: número de páginas del render (desbordes), páginas en blanco;
- imagen: comparación visual por página (PNG lado a lado) y diferencia media.

Uso: python doc_qa.py original.pdf documento.docx carpeta_qa [--paginas 1 2 ...] [--soffice RUTA] [--perfil DIR]
Escribe carpeta_qa/qa.json y carpeta_qa/comparacion-NN.png. Código de salida 0 si pasa, 2 si falla una puerta.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import zipfile
from difflib import SequenceMatcher
from pathlib import Path

import fitz

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
EMU_PT = 12700
WORD_RE = re.compile(r"[0-9A-Za-zÁÉÍÓÚÜÑáéíóúüñ#%$.,:/+\-]{2,}")


def words(text: str) -> list[str]:
    return [w.strip(".,:").lower() for w in WORD_RE.findall(text) if w.strip(".,:")]


def inspect_docx(path: Path) -> dict:
    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        doc = z.read("word/document.xml").decode("utf-8", "replace")
    # Texto por párrafo: los fragmentos de un párrafo se unen; párrafos, saltos y tabulaciones separan palabras.
    parts = []
    for para in re.split(r"</w:p>", doc):
        para = re.sub(r"<w:(?:br|tab|cr)\b[^>]*/>", "<w:t> </w:t>", para)
        parts.append("".join(re.findall(r"<w:t(?: [^>]*)?>([^<]*)</w:t>", para)))
    text = "\n".join(parts)
    alt = " ".join(re.findall(r'<wp:docPr [^>]*descr="([^"]*)"', doc))
    # Tamaño de página por sección y extensión de cada imagen.
    pages = [(int(a) / 20, int(b) / 20) for a, b in re.findall(r'<w:pgSz w:w="(\d+)" w:h="(\d+)"', doc)]
    page_area = max((a * b for a, b in pages), default=1)
    exts = [(int(cx) / EMU_PT, int(cy) / EMU_PT) for cx, cy in re.findall(r'<wp:extent cx="(\d+)" cy="(\d+)"', doc)]
    ratios = sorted((round(cx * cy / page_area, 3) for cx, cy in exts), reverse=True)
    return {
        "chars": len(text.strip()),
        "words": len(words(text)),
        "text": text,
        "alt_text_words": len(words(alt)),
        "sections": len(pages),
        "pictures": len(exts),
        "largest_picture_ratio": ratios[0] if ratios else 0.0,
        "pictures_over_60pct": sum(1 for r in ratios if r >= 0.6),
        "anchored": doc.count("<wp:anchor"),
        "vml": doc.count("<v:shape") + doc.count("<w:pict"),
        "frames": doc.count("<w:framePr"),
        "fit_text": doc.count("<w:fitText"),
        "tables": doc.count("<w:tbl>"),
        "media_files": len([n for n in names if n.startswith("word/media/")]),
    }


ORDERS = {
    "pPr": ["pStyle", "keepNext", "keepLines", "pageBreakBefore", "framePr", "widowControl", "numPr", "suppressLineNumbers",
            "pBdr", "shd", "tabs", "suppressAutoHyphens", "kinsoku", "wordWrap", "overflowPunct", "topLinePunct",
            "autoSpaceDE", "autoSpaceDN", "bidi", "adjustRightInd", "snapToGrid", "spacing", "ind", "contextualSpacing",
            "mirrorIndents", "suppressOverlap", "jc", "textDirection", "textAlignment", "textboxTightWrap", "outlineLvl",
            "divId", "cnfStyle", "rPr", "sectPr", "pPrChange"],
    "rPr": ["rStyle", "rFonts", "b", "bCs", "i", "iCs", "caps", "smallCaps", "strike", "dstrike", "outline", "shadow",
            "emboss", "imprint", "noProof", "snapToGrid", "vanish", "webHidden", "color", "spacing", "w", "kern",
            "position", "sz", "szCs", "highlight", "u", "effect", "bdr", "shd", "fitText", "vertAlign", "rtl", "cs", "em",
            "lang", "eastAsianLayout", "specVanish", "oMath", "ins", "del", "moveFrom", "moveTo", "rPrChange"],
    "tblPr": ["tblStyle", "tblpPr", "tblOverlap", "bidiVisual", "tblStyleRowBandSize", "tblStyleColBandSize", "tblW", "jc",
              "tblCellSpacing", "tblInd", "tblBorders", "shd", "tblLayout", "tblCellMar", "tblLook", "tblCaption",
              "tblDescription", "tblPrChange"],
    "tcPr": ["cnfStyle", "tcW", "gridSpan", "hMerge", "vMerge", "tcBorders", "shd", "noWrap", "tcMar", "textDirection",
             "tcFitText", "vAlign", "hideMark", "headers", "cellIns", "cellDel", "cellMerge", "tcPrChange"],
    "tcBorders": ["top", "start", "left", "bottom", "end", "right", "insideH", "insideV", "tl2br", "tr2bl"],
}


def schema_order_problems(path: Path, limit: int = 20) -> list[str]:
    """Compatibilidad con Word: hijos de las propiedades en el orden del esquema, sin duplicados, ids de dibujo únicos,
    y una celda/cuerpo nunca terminan en tabla. (LibreOffice tolera esto; Word puede declarar el archivo dañado.)"""
    import xml.etree.ElementTree as ET
    with zipfile.ZipFile(path) as z:
        root = ET.fromstring(z.read("word/document.xml"))
    probs: list[str] = []
    for el in root.iter():
        tag = el.tag.split("}")[-1]
        if tag in ORDERS and el.tag.startswith(W):
            order = ORDERS[tag]
            seen = [c.tag.split("}")[-1] for c in el if c.tag.startswith(W)]
            known = [order.index(t) for t in seen if t in order]
            if known != sorted(known) or len(set(seen)) != len(seen):
                probs.append(f"{tag}: {seen}")
        if tag in ("tc", "body"):
            kids = [c.tag.split("}")[-1] for c in el if c.tag.split("}")[-1] in ("p", "tbl", "sectPr")]
            kids = [k for k in kids if k != "sectPr"]
            if kids and kids[-1] == "tbl":
                probs.append(f"{tag} termina en tabla")
        if len(probs) >= limit:
            break
    ids = [d.get("id") for d in root.iter("{http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing}docPr")]
    if len(ids) != len(set(ids)):
        probs.append("ids de dibujo repetidos")
    return probs


def render(docx: Path, out_dir: Path, soffice: str, profile: Path) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    cmd = [soffice, f"-env:UserInstallation={profile.resolve().as_uri()}", "--headless", "--norestore",
           "--convert-to", "pdf", "--outdir", str(out_dir), str(docx)]
    # LibreOffice trae su propio Python: las variables PYTHON* de este proceso lo hacen fallar al arrancar (0xC0000409).
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith("PYTHON")}
    subprocess.run(cmd, check=True, capture_output=True, timeout=600, env=env)
    pdf = out_dir / (docx.stem + ".pdf")
    if not pdf.exists():
        raise RuntimeError("LibreOffice no produjo el PDF de comprobación")
    return pdf


def order_recall(src: list[str], dst: list[str]) -> float:
    if not src:
        return 1.0
    sm = SequenceMatcher(None, src, dst, autojunk=False)
    return sum(b.size for b in sm.get_matching_blocks()) / len(src)


def bag_recall(src: list[str], dst: list[str]) -> float:
    from collections import Counter
    a, b = Counter(src), Counter(dst)
    return sum(min(n, b[w]) for w, n in a.items()) / max(1, sum(a.values()))


def visual(orig, rend, pi_o, pi_r, out: Path) -> float:
    zoom = 0.9
    a = orig[pi_o].get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
    b = rend[pi_r].get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False) if pi_r is not None else None
    from PIL import Image, ImageChops, ImageStat
    ia = Image.frombytes("RGB", (a.width, a.height), a.samples)
    ib = Image.frombytes("RGB", (b.width, b.height), b.samples).resize(ia.size) if b else Image.new("RGB", ia.size, "white")
    diff = ImageChops.difference(ia.convert("L"), ib.convert("L"))
    score = round(sum(ImageStat.Stat(diff).mean) / 255, 4)
    canvas = Image.new("RGB", (ia.width * 2 + 12, ia.height), "#888888")
    canvas.paste(ia, (0, 0)); canvas.paste(ib, (ia.width + 12, 0))
    canvas.save(out)
    return score


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf", type=Path); ap.add_argument("docx", type=Path); ap.add_argument("qa", type=Path)
    ap.add_argument("--paginas", type=int, nargs="*")
    ap.add_argument("--soffice", default=os.environ.get("SOFFICE") or shutil.which("soffice") or r"C:\Program Files\LibreOffice\program\soffice.com")
    ap.add_argument("--perfil", type=Path)
    ap.add_argument("--min-recall", type=float, default=0.97)
    ap.add_argument("--informe", type=Path, help="informe del conversor: figuras declaradas (su texto no cuenta como editable)")
    a = ap.parse_args()
    a.qa.mkdir(parents=True, exist_ok=True)
    orig = fitz.open(a.pdf)
    idx = [p - 1 for p in a.paginas] if a.paginas else list(range(len(orig)))
    figures = {}
    if a.informe:
        rep = json.loads(a.informe.read_text(encoding="utf-8"))
        figures = {pg["page"]: pg.get("figures", []) for pg in rep.get("pages", [])}
    src_words, body_words, fig_words = [], [], 0
    for i in idx:
        src_words += words(orig[i].get_text("text", sort=True))
        for b in orig[i].get_text("words", sort=True):
            cx, cy = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
            inside = any(f[0] <= cx <= f[2] and f[1] <= cy <= f[3] for f in figures.get(i + 1, []))
            ws = words(b[4])
            if inside:
                fig_words += len(ws)
            else:
                body_words += ws
    info = inspect_docx(a.docx)
    docx_words = words(info.pop("text"))
    profile = a.perfil or (a.qa / "perfil_lo")
    rendered = render(a.docx, a.qa / "render", a.soffice, profile)
    rend = fitz.open(rendered)
    rend_words = []
    for p in rend:
        rend_words += words(p.get_text("text", sort=True))
    pages = []
    for n, i in enumerate(idx):
        r = n if n < len(rend) else None
        score = visual(orig, rend, i, r, a.qa / f"comparacion-{i + 1:02d}.png")
        pw = words(orig[i].get_text("text", sort=True))
        rw = words(rend[n].get_text("text", sort=True)) if r is not None else []
        pages.append({"page": i + 1, "visual_diff": score, "words": len(pw),
                      "recall_page": round(bag_recall(pw, rw), 4), "rendered_words": len(rw)})
    result = {
        "pdf_pages": len(idx), "rendered_pages": len(rend), "docx": info,
        "recall_docx": round(bag_recall(src_words, docx_words), 4),
        "recall_docx_outside_figures": round(bag_recall(body_words, docx_words), 4),
        "words_in_figures": fig_words,
        "figure_share": round(fig_words / max(1, len(src_words)), 4),
        "recall_render": round(bag_recall(src_words, rend_words), 4),
        "order_render": round(order_recall(body_words, rend_words), 4),
        "duplication": round(max(0.0, len(rend_words) / max(1, len(body_words)) - 1), 4),
        "pages": pages,
        "schema_problems": schema_order_problems(a.docx),
    }
    gates = {
        "texto_editable": info["chars"] > 0 and result["recall_docx_outside_figures"] >= a.min_recall,
        "sin_paginas_como_imagen": info["pictures_over_60pct"] == 0,
        "sin_marcos_ni_vml": info["vml"] == 0 and info["frames"] == 0 and info["fit_text"] == 0 and info["anchored"] == 0,
        "estructura_compatible_word": not result["schema_problems"],
        "mismas_paginas": len(rend) == len(idx),
        "contenido_completo": bag_recall(body_words, rend_words) >= a.min_recall,
        "sin_duplicados": result["duplication"] <= 0.03,
        "paginas_con_contenido": all(p["rendered_words"] > 0 or p["words"] == 0 for p in pages),
        # Las figuras que declara el conversor (su texto no cuenta como editable) deben existir como imágenes y llevar ese
        # texto como texto alternativo: un conversor no puede «esconder» texto que falta llamándolo figura.
        "figuras_verificadas": sum(len(v) for v in figures.values()) == 0 or (
            info["pictures"] >= sum(len(v) for v in figures.values()) and (fig_words == 0 or info["alt_text_words"] >= 0.5 * fig_words)),
    }
    result["gates"] = gates
    result["passed"] = all(gates.values())
    (a.qa / "qa.json").write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps({k: result[k] for k in ("pdf_pages", "rendered_pages", "recall_docx", "recall_docx_outside_figures", "figure_share", "recall_render", "order_render", "duplication", "passed")} | {"gates": gates}, ensure_ascii=False))
    sys.exit(0 if result["passed"] else 2)


if __name__ == "__main__":
    main()
