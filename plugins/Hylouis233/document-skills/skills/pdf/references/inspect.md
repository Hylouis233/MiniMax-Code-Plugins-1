# Inspect a PDF (PyMuPDF)

```python
import os
import fitz

doc = fitz.open("input.pdf")
if doc.needs_pass:
    password = os.environ.get("PDF_PASSWORD", "")
    if doc.authenticate(password) <= 0:
        raise RuntimeError("Encrypted PDF: set a valid PDF_PASSWORD before inspection")

print("pages:", doc.page_count)
print("password_protected:", doc.needs_pass,
      "| still_encrypted:", doc.is_encrypted, "| pdf:", doc.is_pdf)
for page in doc:
    drawings = page.get_drawings()
    print(page.number, page.rect, "text_len:", len(page.get_text()),
          "images:", len(page.get_images()), "drawings:", len(drawings),
          "links:", len(page.get_links()))
```

## Checks worth automating

- **Blank page detection**: `not page.get_text().strip() and not page.get_images() and not
  page.get_drawings()` -> flag; checking drawings avoids misclassifying vector-only pages as
  blank. A blank page after generation usually means an overflowing flowable created it.
- **Font inventory**: `page.get_fonts()` lists embedded names - needed when the user reports
  "looks different on machine X".
- **Page size consistency**: mixed `page.rect` sizes in one file break duplex printing; report
  it rather than silently normalizing.
- **Damage**: `fitz.open` on a corrupt file raises or yields garbage - pair with
  `pypdf.PdfReader` cross-check when provenance is unknown.

Report findings as a table (page, size, text chars, images, drawings, links) - it is what every
downstream decision hangs off.
