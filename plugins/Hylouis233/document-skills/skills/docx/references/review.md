# Review / repair a DOCX

## Symptom-driven triage

| Symptom | Likely cause | Fix route
|---|---|---|
File will not open at all | broken ZIP (truncated, wrong repack) | inspect with `zipfile.ZipFile(path).testzip()`; if entries are damaged, recover from the user's original or prior version |
Opens with "unreadable content" repair prompt | content-types / rels mismatch, invalid XML | Tier 2 surgery: validate XML parses, check `[Content_Types].xml` covers every part extension |
Text present but styles lost | document rebuilt from scratch instead of edited | redo as edit on the original package |
Images missing | media parts not repacked or rels broken | verify `word/media/*` exist and `document.xml.rels` references them |
Fonts render differently on another machine | non-embedded fonts | expected; report which fonts are referenced (`w:rFonts` values) |

## Programmatic health check

```python
import zipfile
from lxml import etree

path = "input.docx"
with zipfile.ZipFile(path) as z:
    bad = z.testzip()
    assert bad is None, f"corrupt entry: {bad}"
    names = z.namelist()
    assert "[Content_Types].xml" in names and "word/document.xml" in names
    for part in names:
        if part.endswith(('.xml', '.rels')):
            etree.fromstring(z.read(part))  # raises on malformed XML
```

Then the SKILL.md postcheck (python-docx re-open, optional soffice PDF smoke test).

## Report format

State what is broken, the minimal repair applied, and what could not be verified without the
target viewer (exact pagination, field updates, embedded font rendering).
