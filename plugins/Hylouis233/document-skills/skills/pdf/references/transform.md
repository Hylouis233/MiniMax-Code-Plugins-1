# Transform a PDF (pypdf)

One tool for page-level structure changes:

```python
import os
from pypdf import PdfReader, PdfWriter

def open_pdf(path):
    reader = PdfReader(path)
    if reader.is_encrypted:
        password = os.environ.get("PDF_PASSWORD", "")
        if reader.decrypt(password) == 0:
            raise RuntimeError(f"Encrypted PDF {path}: set a valid PDF_PASSWORD")
    return reader

reader = open_pdf("input.pdf")
writer = PdfWriter()

# Split: keep only pages 2-4 (0-based), remapping any retained outline entries.
writer.append(reader, pages=(1, 4), import_outline=True)

# Merge another file at the end. append() imports bookmarks/named destinations;
# copying other.pages one by one would silently discard that navigation structure.
other = open_pdf("appendix.pdf")
writer.append(other, import_outline=True)

# Rotate a page 90 degrees
writer.pages[0].rotate(90)

# Metadata
writer.add_metadata({"/Title": "Merged report", "/Producer": "document-skills"})

with open("output.pdf", "wb") as f:
    writer.write(f)
```

Watermark / stamp by merging a stamp page onto each page:

```python
from pypdf import Transformation

stamp = open_pdf("watermark.pdf").pages[0]
stamp.transfer_rotation_to_content()
stamp_text = (stamp.extract_text() or "").strip()
reader = open_pdf("input.pdf")
expected_fields = reader.get_fields() or {}
writer = PdfWriter()
writer.append(reader)                 # clone pages plus catalog entries such as /AcroForm

# A plain merge_page() overlays the stamp in its own coordinates, so on a page
# with different dimensions, origin, or rotation the stamp can be clipped or
# land entirely off-page. Normalize only the stamp, then scale each copy to the
# destination crop box and include both boxes' non-zero origins. Keep the
# destination page's /Rotate value intact: transfer_rotation_to_content() does
# not transform annotation rectangles, so normalizing a page that has widgets,
# links, or other annotations can displace its interactive geometry.
stamp_box = stamp.cropbox
sw, sh = float(stamp_box.width), float(stamp_box.height)
for page in writer.pages:
    destination = page.cropbox
    dw, dh = float(destination.width), float(destination.height)
    scale = min(dw / sw, dh / sh)
    tx = float(destination.left) + (dw - sw * scale) / 2 - float(stamp_box.left) * scale
    ty = float(destination.bottom) + (dh - sh * scale) / 2 - float(stamp_box.bottom) * scale
    page.merge_transformed_page(stamp, Transformation().scale(scale).translate(tx, ty))

expected_sizes = [tuple(float(value) for value in page.mediabox) for page in writer.pages]

with open("watermarked.pdf", "wb") as f:
    writer.write(f)

check = PdfReader("watermarked.pdf")
assert len(check.pages) == len(expected_sizes)
assert [tuple(float(value) for value in page.mediabox) for page in check.pages] == expected_sizes
if expected_fields:
    assert set(expected_fields) <= set(check.get_fields() or {}), "watermarking dropped form fields"
if stamp_text:
    assert all(stamp_text in (page.extract_text() or "") for page in check.pages)
```

If the stamp is graphical, render every output page and visually confirm that it is present;
text extraction cannot validate a graphical watermark.

Encryption and forms:

- AES encryption requires pypdf's optional crypto backend. Install `pypdf[crypto]` with
  `python -m pip install "pypdf[crypto]"`. Run
  `python -c "import cryptography; print('AES backend ok')"` before calling
  `writer.encrypt("pass", algorithm="AES-256")`.
  Open the result with `PdfReader(..., password="pass")`. Report that you set a password - the
  user must record it.
- AcroForm: fill fields on a cloned copy of the document, never on the readers' own pages:

  ```python
  from pypdf import PdfReader, PdfWriter

  reader = open_pdf("form.pdf")
  fields = reader.get_fields() or {}
  assert fields, "this PDF has no AcroForm form fields"

  writer = PdfWriter()
  writer.append(reader)   # clones every page AND the catalog /AcroForm into the writer

  def widget_field_name(widget):
      """Resolve /T on a widget or its parent field dictionary."""
      while widget is not None:
          if widget.get("/T") is not None:
              return str(widget["/T"])
          parent = widget.get("/Parent")
          widget = None if parent is None else parent.get_object()
      return None

  field_name = "applicant_name"
  target_pages = [
      page for page in writer.pages
      if any(
          (widget := ref.get_object()).get("/Subtype") == "/Widget"
          and widget_field_name(widget) == field_name
          for ref in (page.get("/Annots") or [])
      )
  ]
  if not target_pages:
      raise KeyError(f"no widget page found for field {field_name!r}")
  for page in target_pages:
      writer.update_page_form_field_values(page, {field_name: "Ada Byron"})

  with open("filled.pdf", "wb") as f:
      writer.write(f)

  check = PdfReader("filled.pdf")
  value = str((check.get_fields() or {}).get("applicant_name", {}).get("/V", ""))
  assert value.strip("/") == "Ada Byron"
  ```

  A freshly constructed `PdfWriter` is empty: `append` (or `clone_document_from_reader`) must
  copy the pages and the `/AcroForm` dictionary before any `update_page_form_field_values`
  call, or the write fails or silently produces a formless file. Flatten only on explicit
  request; it stops later editing.

## Rules

- Always write a new file; transformation in place risks losing the original on a bad write.
- Open every source through `open_pdf` above before touching `.pages`; this authenticates
  encrypted inputs and fails with a clear password error instead of failing mid-transform.
- Merge complete inputs with `writer.append(..., import_outline=True)` so their outlines and
  named destinations are imported and remapped; page-by-page `add_page` is for intentional splits.
- After writing, re-open with `PdfReader("output.pdf")` and verify page count and page sizes.
- `rotate` is cumulative on already-rotated pages - read `/Rotate` first if the source was
  scanned sideways.
