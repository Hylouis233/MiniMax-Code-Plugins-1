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
writer = PdfWriter()
for page in PdfReader("input.pdf").pages:
    page.merge_page(stamp)          # stamp content on top; use merge_transformed_page to place
    writer.add_page(page)
```

Encryption and forms:

- `writer.encrypt("pass", algorithm="AES-256")` to protect; `PdfReader(..., password="pass")`
  to open. Report that you set a password - the user must record it.
- AcroForm fields: `reader.get_fields()` to enumerate; `writer.update_page_form_field_values(
  page, {"fieldname": "value"})` to fill. Flatten only on explicit request; it stops later
  editing.

## Rules

- Always write a new file; transformation in place risks losing the original on a bad write.
- After writing, re-open with `PdfReader("output.pdf")` and verify page count and page sizes.
- `rotate` is cumulative on already-rotated pages - read `/Rotate` first if the source was
  scanned sideways.
