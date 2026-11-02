"""Inventario mínimo de un PDF para el Portal (sin red, sin modificar nada).

Uso: python pdf_info.py documento.pdf
Imprime JSON: páginas, páginas con texto extraíble, caracteres, tamaños, cifrado y si el OCR está disponible.
No imprime el texto del documento (el Portal no lo envía a ningún modelo).
"""
import json
import shutil
import sys

import fitz


def main():
    doc = fitz.open(sys.argv[1])
    if doc.needs_pass:
        print(json.dumps({"encrypted": True, "pages": len(doc)}))
        return
    text_pages = 0
    chars = 0
    sizes = set()
    for p in doc:
        t = p.get_text("text").strip()
        chars += len(t)
        if len(t) >= 20:
            text_pages += 1
        sizes.add((round(p.rect.width), round(p.rect.height)))
    print(json.dumps({
        "encrypted": False, "pages": len(doc), "text_pages": text_pages, "chars": chars,
        "sizes": sorted([list(s) for s in sizes])[:10],
        "ocr_available": shutil.which("tesseract") is not None,
    }))


if __name__ == "__main__":
    main()
