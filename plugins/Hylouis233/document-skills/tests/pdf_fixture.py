# Minimal runnable fixtures for the snippets called out in review: one file per format.
# Each script is self-contained, writes only scratch files into the current directory,
# and exits non-zero on failed assertions. Run from any scratch directory:
#   python pdf_fixture.py   (deps: reportlab, pypdf, pymupdf)
#   python pptx_fixture.py  (deps: python-pptx)
#   python xlsx_fixture.py  (deps: openpyxl)
#   python docx_fixture.py  (deps: python-docx, pymupdf, soffice on PATH)
import os
import sys

import fitz
import pypdf
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

failures = []


def check(name, cond, extra=""):
    print(("PASS " if cond else "FAIL ") + name + ((" :: " + str(extra)) if not cond and extra else ""))
    if not cond:
        failures.append(name)


# ---- build a 2-page A4 PDF with one AcroForm text field on page 1 -------------
c = canvas.Canvas("form.pdf", pagesize=A4)
c.setFont("Helvetica", 16)
c.drawString(72, 780, "Application form")
c.acroForm.textfield(name="applicant_name", x=72, y=740, width=260, height=20, borderWidth=0)
c.showPage()
c.setFont("Helvetica", 16)
c.drawString(72, 780, "Second page content")
c.save()

# ---- SKILL.md postcheck snippet: width/height pairs from the 4-coordinate box --
r = pypdf.PdfReader("form.pdf")
page_sizes = [
    (float(page.mediabox.width), float(page.mediabox.height))
    for page in r.pages
]
A4_TOLERANCE = 0.5
check(
    "mediabox width/height is A4 on every page",
    all(abs(w - 595.2755) < A4_TOLERANCE and abs(h - 841.8897) < A4_TOLERANCE for w, h in page_sizes),
    page_sizes,
)

# ---- SKILL.md postcheck: encrypted output is reopened with its password -------
encrypted_writer = pypdf.PdfWriter()
encrypted_writer.append(r)
encrypted_writer.encrypt("fixture-password")
with open("encrypted.pdf", "wb") as f:
    encrypted_writer.write(f)
probe = pypdf.PdfReader("encrypted.pdf")
check("encrypted fixture is detected before page access", probe.is_encrypted)
encrypted_r = pypdf.PdfReader("encrypted.pdf", password="fixture-password")
check("password-authenticated postcheck can access every page", len(encrypted_r.pages) == 2)
encrypted_extract = fitz.open("encrypted.pdf")
check("PyMuPDF extraction detects that authentication is required", encrypted_extract.needs_pass)
check("PyMuPDF rejects the wrong extraction password", encrypted_extract.authenticate("wrong") == 0)
check("PyMuPDF authenticates before page extraction", encrypted_extract.authenticate("fixture-password") > 0)
check("authenticated PyMuPDF extraction reaches page text",
      "Application form" in encrypted_extract[0].get_text("text", sort=True))


def open_pdf(path):
    reader = pypdf.PdfReader(path)
    if reader.is_encrypted:
        password = os.environ.get("PDF_PASSWORD", "")
        if reader.decrypt(password) == 0:
            raise RuntimeError(f"Encrypted PDF {path}: set a valid PDF_PASSWORD")
    return reader


os.environ["PDF_PASSWORD"] = "fixture-password"
transform_encrypted = open_pdf("encrypted.pdf")
check("transform helper authenticates encrypted input before page access",
      len(transform_encrypted.pages) == 2)

# A page containing only an AcroForm widget is interactive content, not blank.
widget_canvas = canvas.Canvas("widget-only.pdf", pagesize=A4)
widget_canvas.acroForm.textfield(
    name="widget_only", x=72, y=740, width=260, height=20, borderWidth=1,
)
widget_canvas.showPage()
widget_canvas.save()
widget_doc = fitz.open("widget-only.pdf")
widget_page = widget_doc[0]
widgets = list(widget_page.widgets() or ())
annotations = list(widget_page.annots() or ())
links = widget_page.get_links()
blank = (
    not widget_page.get_text().strip()
    and not widget_page.get_images()
    and not widget_page.get_drawings()
    and not widgets and not annotations and not links
)
check("widget-only form page exposes a widget", len(widgets) == 1, len(widgets))
check("widget-aware blank-page predicate keeps form page", not blank)

# ---- SKILL.md postcheck: interactive-only pages are exempt from the text gate ---
def widget_count(page):
    count = 0
    for ref in page.get("/Annots") or []:
        if ref.get_object().get("/Subtype") == "/Widget":
            count += 1
    return count

widget_postcheck = pypdf.PdfReader("widget-only.pdf")
widget_text = (widget_postcheck.pages[0].extract_text() or "").strip()
check("widget-only page extracts no text", widget_text == "", repr(widget_text))
check("postcheck counts the widget annotation", widget_count(widget_postcheck.pages[0]) == 1)
check("widget-only page passes the text postcheck via the widget exemption",
      bool(widget_text) or widget_count(widget_postcheck.pages[0]) > 0)

blank_writer = pypdf.PdfWriter()
blank_writer.add_blank_page(width=200, height=300)
with open("blank.pdf", "wb") as f:
    blank_writer.write(f)
blank_r = pypdf.PdfReader("blank.pdf")
check("a truly blank page still fails the text postcheck",
      not (bool((blank_r.pages[0].extract_text() or "").strip()) or widget_count(blank_r.pages[0]) > 0))

# ---- transform.md AcroForm snippet: clone into writer, fill on writer pages ----
from pypdf import PdfReader, PdfWriter

reader = PdfReader("form.pdf")
fields = reader.get_fields() or {}
check("source form has the expected field", "applicant_name" in fields, list(fields))

writer = PdfWriter()
writer.append(reader)  # clones pages AND catalog /AcroForm
writer.update_page_form_field_values(
    writer.pages[0],
    {"applicant_name": "Ada Byron"},
)
with open("filled.pdf", "wb") as f:
    writer.write(f)

check_r = PdfReader("filled.pdf")
check("filled file keeps both pages", len(check_r.pages) == 2, len(check_r.pages))
value = str((check_r.get_fields() or {}).get("applicant_name", {}).get("/V", ""))
check("field value round-trips", value.strip("/") == "Ada Byron", repr(value))

# ---- transform.md merge imports outline navigation ----------------------------
appendix_writer = PdfWriter()
appendix_writer.add_blank_page(width=200, height=300)
appendix_writer.add_outline_item("Appendix bookmark", 0)
with open("appendix-outline.pdf", "wb") as f:
    appendix_writer.write(f)

merge_writer = PdfWriter()
merge_writer.append(open_pdf("form.pdf"), pages=(1, 2), import_outline=True)
merge_writer.append(open_pdf("appendix-outline.pdf"), import_outline=True)
with open("merged-outline.pdf", "wb") as f:
    merge_writer.write(f)
merged_outline = PdfReader("merged-outline.pdf").outline
check(
    "append imports the appended PDF outline",
    any(getattr(item, "title", "") == "Appendix bookmark" for item in merged_outline),
    merged_outline,
)

# ---- transform.md watermark snippet -------------------------------------------
from pypdf import PdfReader as R2

stamp_src = canvas.Canvas("stamp.pdf", pagesize=A4)
stamp_src.setFont("Helvetica", 40)
stamp_src.setFillAlpha(0.35)
stamp_src.drawString(160, 400, "DRAFT")
stamp_src.save()

stamp = R2("stamp.pdf").pages[0]
stamp_text = (stamp.extract_text() or "").strip()
reader = R2("form.pdf")
expected_sizes = [(round(float(p.mediabox.width), 2), round(float(p.mediabox.height), 2)) for p in reader.pages]
expected_fields = reader.get_fields() or {}
writer = PdfWriter()
writer.append(reader)
for page in writer.pages:
    page.merge_page(stamp)
with open("watermarked.pdf", "wb") as f:
    writer.write(f)

verify = R2("watermarked.pdf")
check("watermark written and page count kept", len(verify.pages) == 2, len(verify.pages))
check(
    "watermark page sizes unchanged",
    [(round(float(p.mediabox.width), 2), round(float(p.mediabox.height), 2)) for p in verify.pages] == expected_sizes,
)
check("watermarking preserves the AcroForm catalog and fields",
      set(expected_fields) <= set(verify.get_fields() or {}), verify.get_fields())
check("stamp text present on every page", all(stamp_text in (p.extract_text() or "") for p in verify.pages))

# ---- extract.md CMYK conversion snippet ---------------------------------------
pix = fitz.Pixmap(fitz.csCMYK, fitz.IRect(0, 0, 24, 24))  # CMYK pixmap like a CMYK PDF image
converted = fitz.Pixmap(fitz.csRGB, pix) if pix.colorspace not in (fitz.csGRAY, fitz.csRGB) else pix
converted.save("cmyk-converted.png")
check("CMYK pixmap converts to a saved PNG", os.path.getsize("cmyk-converted.png") > 0)
rgb = fitz.Pixmap("cmyk-converted.png")
check("converted pixmap is RGB", "RGB" in str(rgb.colorspace), rgb.colorspace)

# ---- extract.md soft-mask composition: transparent image keeps alpha -----------
rgba = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 8, 8), True)
for y in range(rgba.height):
    for x in range(rgba.width):
        rgba.set_pixel(x, y, (255, 0, 0, 255 if x < 4 else 64))
rgba.save("transparent-source.png")

transparent_pdf = canvas.Canvas("transparent-image.pdf", pagesize=A4)
transparent_pdf.drawImage(
    "transparent-source.png", 72, 700, width=80, height=80, mask="auto"
)
transparent_pdf.save()

transparent_doc = fitz.open("transparent-image.pdf")
image_info = transparent_doc[0].get_images(full=True)[0]
check("transparent PDF image exposes a soft-mask xref", image_info[1] > 0, image_info)
base = fitz.Pixmap(transparent_doc, image_info[0])
if base.colorspace and base.colorspace not in (fitz.csGRAY, fitz.csRGB):
    base = fitz.Pixmap(fitz.csRGB, base)
mask = fitz.Pixmap(transparent_doc, image_info[1])
composited = fitz.Pixmap(base, mask)
composited.save("transparent-extracted.png")
reopened_composite = fitz.Pixmap("transparent-extracted.png")
check("soft-mask composition keeps an alpha channel", reopened_composite.alpha == 1)
check(
    "soft-mask composition keeps varying transparency",
    len(set(reopened_composite.samples[3::4])) > 1,
    set(reopened_composite.samples[3::4]),
)

# ---- create.md rule: escape plain text before Paragraph ------------------------
from reportlab.lib.pagesizes import A4 as A4_SIZE
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.platypus import Paragraph, SimpleDocTemplate
from xml.sax.saxutils import escape

MESSY = "R&D spend <budget> & \"pipeline\" > forecast"
try:
    SimpleDocTemplate("escaped.pdf", pagesize=A4_SIZE).build(
        [Paragraph(escape(MESSY), getSampleStyleSheet()["BodyText"])]
    )
    build_error = ""
except Exception as exc:  # unescaped markup typically raises a paraparser error
    build_error = str(exc)
check("escaped messy text builds without paraparser error", build_error == "", build_error)
esc_text = " ".join(page.get_text() for page in fitz.open("escaped.pdf"))
check("escaped text extracts with original characters",
      "R&D spend <budget>" in esc_text and "\"pipeline\"" in esc_text, esc_text[:120])

unescaped_failed = False
try:
    SimpleDocTemplate("raw.pdf", pagesize=A4_SIZE).build(
        [Paragraph(MESSY, getSampleStyleSheet()["BodyText"])]
    )
except Exception:
    unescaped_failed = True
if unescaped_failed:
    check("unescaped markup is proven dangerous (negative control)", True)
else:
    # lenient inputs build but render mangled: markup is swallowed, entities reinterpreted
    raw_text = " ".join(page.get_text() for page in fitz.open("raw.pdf"))
    check(
        "unescaped markup is proven dangerous (negative control)",
        "<budget>" not in raw_text or "R&D;" in raw_text,
        raw_text[:120],
    )

# ---- extract.md table route: find_tables instead of raw span soup ---------------
from reportlab.lib import colors
from reportlab.platypus import Table as RlTable, TableStyle

rl_table = RlTable(
    [["Region", "Sales"], ["North", "120"], ["South", "340"]],
    style=TableStyle([("GRID", (0, 0), (-1, -1), 0.5, colors.black)]),
)
SimpleDocTemplate("table.pdf", pagesize=A4_SIZE).build([rl_table])

table_doc = fitz.open("table.pdf")
detected = table_doc[0].find_tables()
check("find_tables detects the drawn table", len(detected.tables) == 1, len(detected.tables))
if detected.tables:
    extracted_rows = detected.tables[0].extract()
    check("find_tables extracts the header row", extracted_rows[0] == ["Region", "Sales"], extracted_rows)
    check("find_tables extracts data rows", extracted_rows[2] == ["South", "340"], extracted_rows)

print("\n" + ("ALL PDF FIXTURES PASSED" if not failures else f"{len(failures)} FAILURES: {failures}"))
sys.exit(0 if not failures else 1)
