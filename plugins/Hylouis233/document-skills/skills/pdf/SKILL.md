---
name: pdf
description: Create, extract, transform, or analyze PDF documents. Use this Skill whenever a .pdf file is the input or output - generating reports, one-pagers, posters or structured documents as real selectable-text PDFs; extracting text, tables or images from existing PDFs; merging, splitting, rotating, or watermarking pages; filling forms; checking that a produced PDF has the right page count and extractable text.
---

# PDF workbench

PDF tasks fail when the agent mixes incompatible libraries or generates pages as screenshots.
Route by job, use one tool per job, verify the artifact.

## Step 0 - Check the toolchain

```bash
python -c "import reportlab, pypdf, fitz; print('reportlab', reportlab.Version, '| pypdf ok | pymupdf ok')"
```

- `reportlab` - creation (preferred: real text, real structure).
- `pypdf` - page-level transforms: split, merge, rotate, encrypt, form fields.
- `pymupdf` (`fitz`) - extraction (text with coordinates, tables, images), rasterization,
  page-level inspection.

Missing any -> say so and degrade to the ones present; do not substitute screenshot pipelines.

## Step 1 - Pick exactly one tool for the job

| Task | Tool | Reference |
|---|---|---|
| Build a new structured PDF (report, one-pager, letter, checklist) | ReportLab | [references/create.md](references/create.md) |
| Extract text / tables / images | PyMuPDF | [references/extract.md](references/extract.md) |
| Merge, split, rotate, watermark, encrypt, forms | pypdf | [references/transform.md](references/transform.md) |
| Inspect: page count, sizes, fonts, links, blank-page detection | PyMuPDF | [references/inspect.md](references/inspect.md) |

Chaining tools on one artifact is fine (create -> inspect). Using two creation libraries on one
file is not.

## Step 2 - Shared rules

1. **Text-first**: a generated PDF must contain extractable text. Image-of-text is acceptable
   only when the user asked for a rasterized look or provides only images.
2. **Page geometry is explicit**: A4 = 595.27 x 841.89 pt, US Letter = 612 x 792 pt. Declare
   the target size and margins up front; re-check fit after generation.
3. **Fonts**: the standard 14 fonts cover only limited encodings; they do not automatically
   support arbitrary Unicode. Check that the selected face contains every requested character.
   If any glyph is unsupported - including CJK, Cyrillic, Arabic, Devanagari, or emoji - embed
   one or more licensed TTF/OTF fonts with the required coverage and use them for those runs.
   If no suitable embeddable font is available, report the limitation instead of emitting tofu.
4. **Overflow is a defect**: content that spills past the last page or the margin must be
   detected in postcheck and fixed (shrink, paginate, or cut), never shipped.
5. Write output to a new path; keep inputs untouched unless in-place was requested.

## Step 3 - Postcheck (mandatory)

```python
import os
import pypdf

output_path = "output.pdf"
password = os.environ.get("PDF_PASSWORD")
r = pypdf.PdfReader(output_path)
if r.is_encrypted:
    if not password:
        raise RuntimeError("set PDF_PASSWORD so the encrypted output can be postchecked")
    r = pypdf.PdfReader(output_path, password=password)  # wrong passwords fail here
page_count = len(r.pages)
page_texts = {
    number: (page.extract_text() or "").strip()
    for number, page in enumerate(r.pages, start=1)
}

def widget_count(page):
    # Interactive-only pages (pure AcroForm screens) extract no text yet are valid output.
    count = 0
    for ref in page.get("/Annots") or []:
        if ref.get_object().get("/Subtype") == "/Widget":
            count += 1
    return count

intentionally_raster_only_pages = set()
missing_text_pages = [
    number for number, text in page_texts.items()
    if number not in intentionally_raster_only_pages
    and not text
    and widget_count(r.pages[number - 1]) == 0
]
assert not missing_text_pages, f"pages without extractable text: {missing_text_pages}"
# Add task-specific checks when exact copy matters, for example
# {1: ("Report title",), 2: ("Conclusion",)}. Per-page text presence is enforced above.
expected_strings_by_page = {}
for page_number, expected_strings in expected_strings_by_page.items():
    missing = [value for value in expected_strings if value not in page_texts[page_number]]
    assert not missing, f"page {page_number} is missing {missing}"
# Compare width/height to the exact size used at creation with a small point tolerance.
# ReportLab A4 is about (595.2756, 841.8898), not the rounded prose value (595.27, 841.89).
expected_page_size = (595.2756, 841.8898)  # replace for Letter or a task-specific size
page_size_tolerance = 0.5
page_sizes = [
    (float(page.mediabox.width), float(page.mediabox.height))
    for page in r.pages
]
size_mismatches = [
    (number, actual)
    for number, actual in enumerate(page_sizes, start=1)
    if any(abs(value - expected) > page_size_tolerance
           for value, expected in zip(actual, expected_page_size))
]
assert not size_mismatches, f"unexpected page sizes: {size_mismatches}"

# Overflow is a defect (shared rule 4): text that runs past the page box is
# clipped or off-page even though every check above still passes. Plain block
# extraction silently drops fully off-page text, so extract through an
# explicitly enlarged clip rectangle and compare the block boxes to the page.
import fitz

overflow_doc = fitz.open(output_path)
if overflow_doc.needs_pass:
    if not password:
        raise RuntimeError("set PDF_PASSWORD so the encrypted output can be overflow-checked")
    overflow_doc.authenticate(password)
overflow_pages = []
for page in overflow_doc:
    clip = fitz.Rect(-2000, -2000, page.rect.width + 2000, page.rect.height + 2000)
    text_blocks = [b for b in page.get_text("blocks", clip=clip) if b[6] == 0]
    beyond_box = any(
        b[0] < -0.5 or b[1] < -0.5 or b[2] > page.rect.width + 0.5 or b[3] > page.rect.height + 0.5
        for b in text_blocks
    )
    if beyond_box:
        overflow_pages.append(page.number + 1)
overflow_doc.close()
assert not overflow_pages, f"text blocks extend past the page box on pages: {overflow_pages}"
# The page box is the hard bound. When the task declares specific margins,
# additionally check key blocks against them (or render and inspect visually) -
# content inside the box but past a declared margin is a softer, task-specific
# defect to report.
```

Confirm: page count matches the request; every page except those explicitly listed in
`intentionally_raster_only_pages` has extractable text or at least one form widget (a pure
interactive page); each requested key string is listed in `expected_strings_by_page` and
extracts on the correct page; every value in `page_sizes` is the declared size within
`page_size_tolerance`; and no page's text blocks extend past the page box (the overflow
check). Report all five. For pixel-sensitive work, render every applicable page
with PyMuPDF at 100 dpi and check that each render is non-blank (mean pixel value).
