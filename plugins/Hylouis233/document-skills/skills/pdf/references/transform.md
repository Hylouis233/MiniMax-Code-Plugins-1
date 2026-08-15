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
writer = PdfWriter()
for page in reader.pages:
    page.merge_page(stamp)          # stamp content on top; use merge_transformed_page to place
    writer.add_page(page)

with open("watermarked.pdf", "wb") as f:
    writer.write(f)

check = PdfReader("watermarked.pdf")
assert len(check.pages) == len(expected_sizes)
assert [tuple(float(value) for value in page.mediabox) for page in check.pages] == expected_sizes
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
- AcroForm fields: `reader.get_fields()` to enumerate; `writer.update_page_form_field_values(
  page, {"fieldname": "value"})` to fill. Flatten only on explicit request; it stops later
  editing.

## Rules

- Always write a new file; transformation in place risks losing the original on a bad write.
- After writing, re-open with `PdfReader("output.pdf")` and verify page count and page sizes.
- `rotate` is cumulative on already-rotated pages - read `/Rotate` first if the source was
  scanned sideways.
