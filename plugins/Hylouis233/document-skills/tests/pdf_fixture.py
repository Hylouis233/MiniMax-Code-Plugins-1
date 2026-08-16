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
import reportlab
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

failures = []


def check(name, cond, extra=""):
    print(("PASS " if cond else "FAIL ") + name + ((" :: " + str(extra)) if not cond and extra else ""))
    if not cond:
        failures.append(name)


def open_pdf(path, password=None):
    reader = pypdf.PdfReader(path)
    if reader.is_encrypted:
        if not password or reader.decrypt(password) == 0:
            raise RuntimeError(f"valid password required for {path}")
    return reader


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

# ---- inspect.md distinguishes referenced-only and embedded fonts ---------------
pdfmetrics.registerFont(TTFont("FixtureVera", os.path.join(
    os.path.dirname(reportlab.__file__), "fonts", "Vera.ttf",
)))
font_canvas = canvas.Canvas("font-inventory.pdf", pagesize=A4)
font_canvas.setFont("Helvetica", 12)  # standard PDF face, normally referenced only
font_canvas.drawString(72, 780, "Referenced Helvetica")
font_canvas.setFont("FixtureVera", 12)
font_canvas.drawString(72, 750, "Embedded Vera")
font_canvas.save()

def font_inventory(document, page):
    fonts = []
    for entry in page.get_fonts(full=True):
        xref, extension, font_type, base_name, resource_name, encoding = entry[:6]
        embedded_bytes = 0
        if xref > 0:
            try:
                embedded_bytes = len((document.extract_font(xref)[3] or b""))
            except (RuntimeError, ValueError):
                embedded_bytes = 0
        fonts.append({
            "base_name": base_name, "embedded": embedded_bytes > 0,
            "embedded_bytes": embedded_bytes,
        })
    return fonts

font_doc = fitz.open("font-inventory.pdf")
fonts = font_inventory(font_doc, font_doc[0])
check("font inventory labels the embedded TrueType face",
      any("Vera" in item["base_name"] and item["embedded"] for item in fonts), fonts)
check("font inventory labels referenced-only Helvetica as non-embedded",
      any("Helvetica" in item["base_name"] and not item["embedded"] for item in fonts), fonts)

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

blank_password_writer = pypdf.PdfWriter()
blank_password_writer.append(r)
blank_password_writer.encrypt("", owner_password="fixture-owner-password")
with open("blank-password-encrypted.pdf", "wb") as f:
    blank_password_writer.write(f)
blank_password_reader = pypdf.PdfReader("blank-password-encrypted.pdf")
if blank_password_reader.is_encrypted and blank_password_reader.decrypt("") == 0:
    blank_password_opened = False
else:
    blank_password_opened = len(blank_password_reader.pages) == 2
check("postcheck accepts permission encryption with an empty user password",
      blank_password_opened)
try:
    open_pdf("encrypted.pdf")
    transform_rejected_missing_password = False
except RuntimeError:
    transform_rejected_missing_password = True
check("PDF transforms reject encrypted input without a password",
      transform_rejected_missing_password)
check("PDF transforms authenticate before page access",
      len(open_pdf("encrypted.pdf", "fixture-password").pages) == 2)
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

# A widget can live on any page; locate its annotation instead of assuming page 1.
page2_form = canvas.Canvas("form-page2.pdf", pagesize=A4)
page2_form.drawString(72, 780, "Cover page")
page2_form.showPage()
page2_form.drawString(72, 780, "Form page")
page2_form.acroForm.textfield(
    name="applicant_name", x=72, y=740, width=260, height=20, borderWidth=0,
)
page2_form.showPage()
page2_form.save()

wrong_page_writer = PdfWriter()
wrong_page_writer.append(PdfReader("form-page2.pdf"))
wrong_page_writer.update_page_form_field_values(
    wrong_page_writer.pages[0], {"applicant_name": "Wrong page"},
)
with open("form-page2-wrong.pdf", "wb") as f:
    wrong_page_writer.write(f)
wrong_value = str(
    (PdfReader("form-page2-wrong.pdf").get_fields() or {})
    .get("applicant_name", {}).get("/V", "")
)
check("hard-coded first-page form fill misses a page-2 widget (negative control)",
      wrong_value.strip("/") != "Wrong page", repr(wrong_value))


def widget_field_name(widget):
    parts = []
    seen = set()
    while widget is not None:
        object_id = id(widget)
        if object_id in seen:
            raise ValueError("cycle in AcroForm field parent chain")
        seen.add(object_id)
        if widget.get("/T") is not None:
            parts.append(str(widget["/T"]))
        parent = widget.get("/Parent")
        widget = None if parent is None else parent.get_object()
    return ".".join(reversed(parts)) or None


class DirectObjectReference:
    def __init__(self, value):
        self.value = value

    def get_object(self):
        return self.value


field_parent = {"/T": "application"}
hierarchical_widget = {
    "/T": "applicant_name",
    "/Parent": DirectObjectReference(field_parent),
}
check("widget lookup resolves a fully qualified hierarchical field name",
      widget_field_name(hierarchical_widget) == "application.applicant_name")


page2_writer = PdfWriter()
page2_writer.append(PdfReader("form-page2.pdf"))
field_name = "applicant_name"
target_pages = [
    page for page in page2_writer.pages
    if any(
        (widget := ref.get_object()).get("/Subtype") == "/Widget"
        and widget_field_name(widget) == field_name
        for ref in (page.get("/Annots") or [])
    )
]
for target_page in target_pages:
    page2_writer.update_page_form_field_values(
        target_page, {field_name: "Ada on page 2"},
    )
with open("form-page2-filled.pdf", "wb") as f:
    page2_writer.write(f)
page2_value = str(
    (PdfReader("form-page2-filled.pdf").get_fields() or {})
    .get(field_name, {}).get("/V", "")
)
check("form fill locates the widget page before updating",
      len(target_pages) == 1 and target_pages[0] is page2_writer.pages[1], len(target_pages))
check("page-2 field value round-trips", page2_value.strip("/") == "Ada on page 2",
      repr(page2_value))

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
from pypdf import PdfReader as R2, Transformation
from pypdf.generic import RectangleObject


def rotation_transfer(page):
    media = RectangleObject(page.mediabox)
    transform = (
        Transformation()
        .translate(
            -float(media.left + media.width / 2),
            -float(media.bottom + media.height / 2),
        )
        .rotate(-page.rotation)
    )
    corners = [
        transform.apply_on(point)
        for point in (media.lower_left, media.lower_right, media.upper_left, media.upper_right)
    ]
    return transform.translate(
        -min(point[0] for point in corners),
        -min(point[1] for point in corners),
    )


def inverse_transformation(transform):
    a, b, c, d, e, f = map(float, transform.ctm)
    determinant = a * d - b * c
    return Transformation((
        d / determinant, -b / determinant,
        -c / determinant, a / determinant,
        (c * f - d * e) / determinant,
        (b * e - a * f) / determinant,
    ))


def transformed_rectangle(rectangle, transform):
    rectangle = RectangleObject(rectangle)
    corners = [
        transform.apply_on(point)
        for point in (
            rectangle.lower_left, rectangle.lower_right,
            rectangle.upper_left, rectangle.upper_right,
        )
    ]
    return RectangleObject((
        min(point[0] for point in corners), min(point[1] for point in corners),
        max(point[0] for point in corners), max(point[1] for point in corners),
    ))


def stamp_placement(page, stamp_box):
    to_visual = rotation_transfer(page)
    destination = transformed_rectangle(page.cropbox, to_visual)
    sw, sh = float(stamp_box.width), float(stamp_box.height)
    dw, dh = float(destination.width), float(destination.height)
    scale = min(dw / sw, dh / sh)
    tx = float(destination.left) + (dw - sw * scale) / 2 - float(stamp_box.left) * scale
    ty = float(destination.bottom) + (dh - sh * scale) / 2 - float(stamp_box.bottom) * scale
    visible_placement = Transformation().scale(scale).translate(tx, ty)
    return visible_placement.transform(inverse_transformation(to_visual))

stamp_src = canvas.Canvas("stamp.pdf", pagesize=A4)
stamp_src.setFont("Helvetica", 40)
stamp_src.setFillAlpha(0.35)
stamp_src.drawString(160, 400, "DRAFT")
stamp_src.save()

stamp = R2("stamp.pdf").pages[0]
stamp.transfer_rotation_to_content()
stamp_text = (stamp.extract_text() or "").strip()
reader = R2("form.pdf")
expected_fields = reader.get_fields() or {}
writer = PdfWriter()
writer.append(reader)
stamp_box = stamp.cropbox
for page in writer.pages:
    page.merge_transformed_page(stamp, stamp_placement(page, stamp_box))
expected_sizes = [(round(float(p.mediabox.width), 2), round(float(p.mediabox.height), 2))
                  for p in writer.pages]
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

# ---- inspect.md blank-page predicate includes widgets and annotations -----------
form_only_canvas = canvas.Canvas("form-only.pdf", pagesize=A4)
form_only_canvas.acroForm.textfield(
    name="widget_only", x=72, y=740, width=260, height=20, borderWidth=0
)
form_only_canvas.showPage()
form_only_canvas.save()
form_only_doc = fitz.open("form-only.pdf")
form_only_page = form_only_doc[0]
form_only_widgets = list(form_only_page.widgets() or ())
form_only_annotations = list(form_only_page.annots() or ())
form_only_is_blank = (
    not form_only_page.get_text().strip()
    and not form_only_page.get_images()
    and not form_only_page.get_drawings()
    and not form_only_page.get_links()
    and not form_only_widgets
    and not form_only_annotations
)
check("form-only page exposes a widget", len(form_only_widgets) == 1)
check("form-only page is not classified as blank", not form_only_is_blank)

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


# ---- transform.md: stamps fit non-zero-origin and rotated destination pages ------

mixed_writer = PdfWriter()
mixed_writer.append(open_pdf("form.pdf"))
small_source = PdfWriter()
small_source.add_blank_page(width=200, height=300)
offset_page = small_source.add_blank_page(width=200, height=300)
offset_page.mediabox.lower_left = (100, 200)
offset_page.mediabox.upper_right = (300, 500)
offset_page.cropbox.lower_left = (100, 200)
offset_page.cropbox.upper_right = (300, 500)
rotated_page = small_source.add_blank_page(width=240, height=160)
rotated_page.rotate(90)
from pypdf.generic import ArrayObject, DictionaryObject, FloatObject, NameObject, TextStringObject
rotated_link = DictionaryObject({
    NameObject("/Type"): NameObject("/Annot"),
    NameObject("/Subtype"): NameObject("/Link"),
    NameObject("/Rect"): ArrayObject([FloatObject(value) for value in (20, 30, 100, 60)]),
    NameObject("/Border"): ArrayObject([FloatObject(0), FloatObject(0), FloatObject(0)]),
    NameObject("/A"): DictionaryObject({
        NameObject("/S"): NameObject("/URI"),
        NameObject("/URI"): TextStringObject("https://example.invalid/rotated-link"),
    }),
})
rotated_page[NameObject("/Annots")] = ArrayObject([small_source._add_object(rotated_link)])
cropped_page = small_source.add_blank_page(width=400, height=500)
cropped_page.cropbox.lower_left = (250, 300)
cropped_page.cropbox.upper_right = (390, 480)
mixed_writer.append(small_source)
with open("mixed.pdf", "wb") as f:
    mixed_writer.write(f)

def first_annotation_rect(page):
    return tuple(float(value) for value in page["/Annots"][0].get_object()["/Rect"])

mixed_rotated_page = R2("mixed.pdf").pages[4]
rotated_geometry_before = (mixed_rotated_page.rotation, first_annotation_rect(mixed_rotated_page))

# Negative control: a plain merge keeps the A4 stamp's coordinates, so the text
# lands outside the small page and cannot be extracted.
plain_writer = PdfWriter()
plain_writer.append(open_pdf("mixed.pdf"))
for page in plain_writer.pages:
    page.merge_page(R2("stamp.pdf").pages[0])
with open("plain-stamped.pdf", "wb") as f:
    plain_writer.write(f)

def stamp_bboxes(path, page_number):
    doc = fitz.open(path)
    spans = []
    for block in doc[page_number].get_text("dict")["blocks"]:
        for line in block.get("lines", []):
            for span in line["spans"]:
                if "DRAFT" in span["text"]:
                    spans.append(span["bbox"])
    return spans

def stamp_line_directions(path, page_number):
    doc = fitz.open(path)
    return [
        line["dir"]
        for block in doc[page_number].get_text("dict")["blocks"]
        for line in block.get("lines", [])
        if any("DRAFT" in span["text"] for span in line["spans"])
    ]

# The plain merge keeps the A4 stamp's coordinates, so on the 200x300 page the
# stamp is far outside the box: PyMuPDF's positioned extraction sees no span at
# all, while pypdf's plain extractor still returns the text - proof that text
# extraction alone cannot validate visual placement.
plain_spans = stamp_bboxes("plain-stamped.pdf", 2)
check("plain merge pushes the stamp outside the small page (negative control)",
      plain_spans == [] and "DRAFT" in (R2("plain-stamped.pdf").pages[2].extract_text() or ""),
      plain_spans)

# Negative control for crop-box fitting: media-box centering puts the stamp
# outside this page's small, offset visible region.
media_fit_writer = PdfWriter()
media_fit_writer.append(open_pdf("mixed.pdf"), pages=(5, 6))
media_fit_page = media_fit_writer.pages[0]
media_destination = media_fit_page.mediabox
media_scale = min(float(media_destination.width) / float(stamp_box.width),
                  float(media_destination.height) / float(stamp_box.height))
media_tx = (float(media_destination.left)
            + (float(media_destination.width) - float(stamp_box.width) * media_scale) / 2
            - float(stamp_box.left) * media_scale)
media_ty = (float(media_destination.bottom)
            + (float(media_destination.height) - float(stamp_box.height) * media_scale) / 2
            - float(stamp_box.bottom) * media_scale)
media_fit_page.merge_transformed_page(
    stamp, Transformation().scale(media_scale).translate(media_tx, media_ty),
)
with open("media-fit-cropped.pdf", "wb") as f:
    media_fit_writer.write(f)
check("media-box fitting misses an offset crop region (negative control)",
      stamp_bboxes("media-fit-cropped.pdf", 0) == [])

scaled_writer = PdfWriter()
scaled_writer.append(open_pdf("mixed.pdf"))
stamp_page = R2("stamp.pdf").pages[0]
stamp_page.transfer_rotation_to_content()
stamp_box2 = stamp_page.cropbox
sw2, sh2 = float(stamp_box2.width), float(stamp_box2.height)
for page in scaled_writer.pages:
    page.merge_transformed_page(stamp_page, stamp_placement(page, stamp_box2))
with open("scaled-stamped.pdf", "wb") as f:
    scaled_writer.write(f)
scaled_check = R2("scaled-stamped.pdf")
check("scaled stamp is present on the A4 pages",
      all("DRAFT" in (p.extract_text() or "") for p in scaled_check.pages[:2]))
scaled_spans = stamp_bboxes("scaled-stamped.pdf", 2)
check("scaled stamp lands inside the mixed-size small page",
      bool(scaled_spans) and all(bbox[1] < 300 and bbox[3] <= 300.5 for bbox in scaled_spans),
      scaled_spans)
offset_spans = stamp_bboxes("scaled-stamped.pdf", 3)
rotated_spans = stamp_bboxes("scaled-stamped.pdf", 4)
cropped_spans = stamp_bboxes("scaled-stamped.pdf", 5)
check("scaled stamp lands inside the non-zero-origin page", bool(offset_spans), offset_spans)
rotated_fitz_page = fitz.open("scaled-stamped.pdf")[4]
rotated_visible_spans = [
    fitz.Rect(bbox) * rotated_fitz_page.rotation_matrix for bbox in rotated_spans
]
rotated_visible_directions = [
    (
        direction[0] * rotated_fitz_page.rotation_matrix.a
        + direction[1] * rotated_fitz_page.rotation_matrix.c,
        direction[0] * rotated_fitz_page.rotation_matrix.b
        + direction[1] * rotated_fitz_page.rotation_matrix.d,
    )
    for direction in stamp_line_directions("scaled-stamped.pdf", 4)
]
check("scaled stamp stays horizontal in the rotated page's visible space",
      bool(rotated_spans)
      and all(rect.width > rect.height for rect in rotated_visible_spans)
      and all(dx > 0.9 and abs(dy) < 0.1 for dx, dy in rotated_visible_directions),
      (rotated_visible_spans, rotated_visible_directions))
cropped_rect = fitz.open("scaled-stamped.pdf")[5].rect
check("scaled stamp lands inside the offset visible crop box",
      bool(cropped_spans)
      and all(
          bbox[0] >= -0.5 and bbox[1] >= -0.5
          and bbox[2] <= cropped_rect.width + 0.5
          and bbox[3] <= cropped_rect.height + 0.5
          for bbox in cropped_spans
      ), cropped_spans)
check("mixed-size pages keep their original media boxes",
      [(round(float(p.mediabox.width)), round(float(p.mediabox.height)))
       for p in scaled_check.pages]
      == [(595, 842), (595, 842), (200, 300), (200, 300), (240, 160), (400, 500)])
scaled_rotated_page = scaled_check.pages[4]
check("watermarking preserves rotated-page annotation geometry",
      (scaled_rotated_page.rotation, first_annotation_rect(scaled_rotated_page))
      == rotated_geometry_before,
      ((scaled_rotated_page.rotation, first_annotation_rect(scaled_rotated_page)),
       rotated_geometry_before))
mixed_link_before = tuple(
    round(float(value), 4)
    for value in fitz.open("mixed.pdf")[4].get_links()[0]["from"]
)
mixed_link_after = tuple(
    round(float(value), 4)
    for value in fitz.open("scaled-stamped.pdf")[4].get_links()[0]["from"]
)
check("watermarking preserves the rotated link's visible hit rectangle",
      mixed_link_after == mixed_link_before, (mixed_link_before, mixed_link_after))


# ---- SKILL.md overflow check: off-page text is a defect -------------------------
overflow_ok = canvas.Canvas("overflow.pdf", pagesize=A4)
overflow_ok.setFont("Helvetica", 16)
overflow_ok.drawString(72, 780, "fits on page")
overflow_ok.showPage()
overflow_ok.save()
overflow_bad = canvas.Canvas("overflow-bad.pdf", pagesize=A4)
overflow_bad.setFont("Helvetica", 16)
overflow_bad.drawString(72, -200, "drawn far below the page box")
overflow_bad.showPage()
overflow_bad.save()

rotated_source = canvas.Canvas("overflow-rotated-source.pdf", pagesize=A4)
rotated_source.setFont("Helvetica", 16)
rotated_source.drawString(72, 30, "valid near the unrotated page bottom")
rotated_source.showPage()
rotated_source.save()
rotated_writer = PdfWriter()
rotated_writer.append(R2("overflow-rotated-source.pdf"))
rotated_writer.pages[0].rotate(90)
with open("overflow-rotated.pdf", "wb") as f:
    rotated_writer.write(f)

def overflow_pages(path):
    doc = fitz.open(path)
    pages = []
    for page in doc:
        # Plain block extraction drops fully off-page text; enlarge the clip.
        page_box = fitz.Rect(0, 0, page.cropbox.width, page.cropbox.height)
        clip = fitz.Rect(
            page_box.x0 - 2000, page_box.y0 - 2000,
            page_box.x1 + 2000, page_box.y1 + 2000,
        )
        blocks = [b for b in page.get_text("blocks", clip=clip) if b[6] == 0]
        if any(b[0] < page_box.x0 - 0.5 or b[1] < page_box.y0 - 0.5
               or b[2] > page_box.x1 + 0.5 or b[3] > page_box.y1 + 0.5
               for b in blocks):
            pages.append(page.number + 1)
    doc.close()
    return pages

check("in-bounds PDF reports no overflow pages", overflow_pages("overflow.pdf") == [])
check("off-page text is detected by the overflow check (negative control)",
      overflow_pages("overflow-bad.pdf") == [1])
rotated_probe = fitz.open("overflow-rotated.pdf")[0]
rotated_blocks = rotated_probe.get_text(
    "blocks", clip=fitz.Rect(-2000, -2000, 2000, 3000),
)
rotation_blind_flag = any(
    block[2] > rotated_probe.rect.width + 0.5
    or block[3] > rotated_probe.rect.height + 0.5
    for block in rotated_blocks if block[6] == 0
)
check("rotated rect comparison falsely flags valid text (negative control)", rotation_blind_flag)
check("overflow check compares rotated pages in unrotated coordinates",
      overflow_pages("overflow-rotated.pdf") == [])
check("off-page text still extracts, so extraction alone cannot catch it",
      "drawn far below" in (pypdf.PdfReader("overflow-bad.pdf").pages[0].extract_text() or ""))


print("\n" + ("ALL PDF FIXTURES PASSED" if not failures else f"{len(failures)} FAILURES: {failures}"))
sys.exit(0 if not failures else 1)
