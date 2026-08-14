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
3. **Fonts**: standard 14 fonts always work; embedding a custom TTF is allowed only with its
   license permitting distribution. CJK requires an embedded font - there is no built-in CJK
   face; if unavailable, report the limitation instead of emitting tofu.
4. **Overflow is a defect**: content that spills past the last page or the margin must be
   detected in postcheck and fixed (shrink, paginate, or cut), never shipped.
5. Write output to a new path; keep inputs untouched unless in-place was requested.

## Step 3 - Postcheck (mandatory)

```python
import pypdf
r = pypdf.PdfReader("output.pdf")
page_count = len(r.pages)
first_text = (r.pages[0].extract_text() or "").strip()
```

Confirm: page count matches the request; the key title/heading text extracts non-empty; page
size is the declared size (`r.pages[0].mediabox`). Report all three. For pixel-sensitive work,
add a PyMuPDF render of page 1 at 100 dpi and check it is non-blank (mean pixel value).
