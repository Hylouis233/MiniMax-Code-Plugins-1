# Inspect a PDF (PyMuPDF)

```python
import math
import os
import fitz

doc = fitz.open("input.pdf")
if doc.needs_pass:
    password = os.environ.get("PDF_PASSWORD", "")
    if doc.authenticate(password) <= 0:
        raise RuntimeError("Encrypted PDF: set a valid PDF_PASSWORD before inspection")

def font_inventory(document, page):
    """Distinguish fonts with extractable programs from referenced-only faces."""
    fonts = []
    for entry in page.get_fonts(full=True):
        xref, extension, font_type, base_name, resource_name, encoding = entry[:6]
        embedded_bytes = 0
        if xref > 0:
            try:
                extracted = document.extract_font(xref)
                embedded_bytes = len(extracted[3] or b"")
            except (RuntimeError, ValueError):
                embedded_bytes = 0
        fonts.append({
            "xref": xref,
            "base_name": base_name,
            "resource_name": resource_name,
            "type": font_type,
            "encoding": encoding,
            "extension": extension,
            "embedded": embedded_bytes > 0,
            "embedded_bytes": embedded_bytes,
        })
    return fonts

NON_VIEWABLE_ANNOTATION_FLAGS = (
    fitz.PDF_ANNOT_IS_INVISIBLE | fitz.PDF_ANNOT_IS_HIDDEN | fitz.PDF_ANNOT_IS_NO_VIEW
)

def annotation_flags(page, item):
    flags = getattr(item, "flags", None)
    if flags is not None:
        return int(flags)
    xref = getattr(item, "xref", 0)
    if not xref:
        return 0
    value_type, value = page.parent.xref_get_key(xref, "F")
    try:
        return int(value) if value_type == "int" else 0
    except (TypeError, ValueError):
        return 0

def visible_clip(page, rectangle, *, already_rotated=False):
    try:
        rectangle = fitz.Rect(rectangle)
    except (TypeError, ValueError):
        return None
    if not all(math.isfinite(value) for value in rectangle):
        return None
    rectangle.normalize()
    if rectangle.is_empty or rectangle.is_infinite:
        return None
    rotated = rectangle if already_rotated else rectangle * page.rotation_matrix
    clip = rotated & page.rect
    return None if clip.is_empty else clip

def rendered_interactives(page, items):
    rendered = []
    visibility_unknown = False
    for item in items:
        if annotation_flags(page, item) & NON_VIEWABLE_ANNOTATION_FLAGS:
            continue
        clip = visible_clip(page, item.rect)
        if clip is None:
            continue
        try:
            with_annotations = page.get_pixmap(
                matrix=fitz.Matrix(2, 2), clip=clip, alpha=False, annots=True,
            )
            without_annotations = page.get_pixmap(
                matrix=fitz.Matrix(2, 2), clip=clip, alpha=False, annots=False,
            )
        except (RuntimeError, ValueError):
            visibility_unknown = True
            continue
        if with_annotations.samples != without_annotations.samples:
            rendered.append(item)
    return rendered, visibility_unknown

def page_links(page):
    links = []
    link = page.first_link
    while link is not None:
        links.append(link)
        link = link.next
    return links

def link_has_target(link):
    destination = getattr(link, "dest", None)
    return bool(getattr(link, "uri", None)) or (
        destination is not None and getattr(destination, "page", -1) >= 0
    )

def viewable_interactives(page):
    widgets, widget_visibility_unknown = rendered_interactives(
        page, list(page.widgets() or ())
    )
    annotations, annotation_visibility_unknown = rendered_interactives(
        page, list(page.annots() or ())
    )
    # Link hit rectangles are useful without a painted appearance. PyMuPDF reports
    # them in rotated page coordinates already, unlike widget / annotation rects.
    links = [
        link for link in page_links(page)
        if link_has_target(link)
        and not annotation_flags(page, link) & NON_VIEWABLE_ANNOTATION_FLAGS
        and visible_clip(page, link.rect, already_rotated=True) is not None
    ]
    return (
        widgets, annotations, links,
        widget_visibility_unknown or annotation_visibility_unknown,
    )

print("pages:", doc.page_count)
print("password_protected:", doc.needs_pass,
      "| still_encrypted:", doc.is_encrypted, "| pdf:", doc.is_pdf)
page_geometry = []
for page in doc:
    media_size = (round(page.mediabox.width, 2), round(page.mediabox.height, 2))
    crop_size = (round(page.cropbox.width, 2), round(page.cropbox.height, 2))
    page_geometry.append({
        "page": page.number + 1,
        "media_size": media_size,
        "crop_size": crop_size,
        "rotation": page.rotation,
    })
    blocks = page.get_text("dict")["blocks"]
    image_blocks = [block for block in blocks if block["type"] == 1]
    drawings = page.get_drawings()
    widgets, annotations, links, interaction_visibility_unknown = viewable_interactives(page)
    is_blank = not (
        page.get_text().strip() or page.get_images() or image_blocks or drawings
        or widgets or annotations or links or interaction_visibility_unknown
    )
    print(page.number + 1, "media_size:", media_size, "crop_size:", crop_size,
          "rotation:", page.rotation, "text_len:", len(page.get_text()),
          "resource_images:", len(page.get_images()),
          "image_blocks:", len(image_blocks), "drawings:", len(drawings),
          "widgets:", len(widgets), "annotations:", len(annotations),
          "links:", len(links), "interaction_visibility_unknown:",
          interaction_visibility_unknown, "blank:", is_blank)
    print("  fonts:", font_inventory(doc, page))
print("media_size_consistent:", len({row["media_size"] for row in page_geometry}) <= 1)
print("crop_size_consistent:", len({row["crop_size"] for row in page_geometry}) <= 1)
```

## Checks worth automating

- **Blank page detection**: flag only when text, resource images, type-1 image blocks, drawings,
  and viewable widgets, annotations, and links are all absent. Ignore interactive objects carrying
  invisible, hidden, or no-view flags, as well as empty, off-page, or unrendered appearances.
  `page.get_images()` lists image XObjects but
  misses images embedded inline in the content stream; type-1 blocks from `get_text("dict")`
  cover both inline and XObject image placements. Interactive form fields are widgets rather
  than page text, so a three-content-stream predicate alone would misclassify a usable form
  page as blank. A blank page after generation usually means an overflowing flowable created it.
- **Font inventory**: `page.get_fonts()` lists referenced fonts, including non-embedded base
  fonts. Use `doc.extract_font(xref)` as above and report `embedded` separately; a referenced
  face with no extractable program may be substituted on another machine.
- **Page size consistency**: compare unrotated `(width, height)` pairs from `page.mediabox` and
  `page.cropbox`, and report `page.rotation` separately. Do not compare `page.rect`: it applies
  `/Rotate`, so otherwise identical paper appears to swap width and height at 90 or 270 degrees.
  Report genuinely mixed media or crop sizes rather than silently normalizing them.
- **Damage**: `fitz.open` on a corrupt file raises or yields garbage - pair with
  `pypdf.PdfReader` cross-check when provenance is unknown.

Report findings as a table (page, media size, crop size, rotation, text chars, resource images,
image blocks, drawings, widgets, annotations, links, interaction visibility unknown, blank) - it
is what every downstream decision hangs off.
