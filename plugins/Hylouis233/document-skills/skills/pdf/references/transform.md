# Transform a PDF (pypdf)

One tool for page-level structure changes:

```python
from pypdf import PdfReader, PdfWriter

reader = PdfReader("input.pdf")
writer = PdfWriter()

# Split: keep only pages 2-4 (0-based)
for i in range(1, 4):
    writer.add_page(reader.pages[i])

# Merge another file at the end
other = PdfReader("appendix.pdf")
for page in other.pages:
    writer.add_page(page)

# Rotate a page 90 degrees
writer.pages[0].rotate(90)

# Metadata
writer.add_metadata({"/Title": "Merged report", "/Producer": "document-skills"})

with open("output.pdf", "wb") as f:
    writer.write(f)
```

Watermark / stamp by merging a stamp page onto each page:

```python
stamp = PdfReader("watermark.pdf").pages[0]
stamp_text = (stamp.extract_text() or "").strip()
reader = PdfReader("input.pdf")
expected_sizes = [tuple(float(value) for value in page.mediabox) for page in reader.pages]
expected_fields = reader.get_fields() or {}
writer = PdfWriter()
writer.append(reader)                 # clone pages plus catalog entries such as /AcroForm
for page in writer.pages:
    page.merge_page(stamp)          # stamp content on top; use merge_transformed_page to place

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

  reader = PdfReader("form.pdf")
  fields = reader.get_fields() or {}
  assert fields, "this PDF has no AcroForm form fields"

  writer = PdfWriter()
  writer.append(reader)   # clones every page AND the catalog /AcroForm into the writer

  # update fields on the writer's page copies; a field widget can sit on any page,
  # so pass the writer page that actually carries the field you are filling
  writer.update_page_form_field_values(
      writer.pages[0],
      {"applicant_name": "Ada Byron"},
  )

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
- After writing, re-open with `PdfReader("output.pdf")` and verify page count and page sizes.
- `rotate` is cumulative on already-rotated pages - read `/Rotate` first if the source was
  scanned sideways.
