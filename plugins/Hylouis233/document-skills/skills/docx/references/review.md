# Review / repair a DOCX

## Symptom-driven triage

| Symptom | Likely cause | Fix route
|---|---|---|
File will not open at all | broken ZIP (truncated, wrong repack) | run the bounded health check below; if entries are damaged, recover from the user's original or prior version |
Opens with "unreadable content" repair prompt | content-types / rels mismatch, invalid XML | Tier 2 surgery: validate XML parses, check `[Content_Types].xml` covers every part extension |
Text present but styles lost | document rebuilt from scratch instead of edited | redo as edit on the original package |
Images missing | media parts not repacked or rels broken | verify `word/media/*` exist and `document.xml.rels` references them |
Fonts render differently on another machine | non-embedded fonts | expected; report which fonts are referenced (`w:rFonts` values) |

## Programmatic health check

```python
import zipfile
from lxml import etree

path = "input.docx"
MAX_XML_PART = 20 * 1024 * 1024
MAX_ENTRY = 100 * 1024 * 1024
MAX_TOTAL_UNCOMPRESSED = 500 * 1024 * 1024
MAX_COMPRESSION_RATIO = 200
safe_xml_parser = etree.XMLParser(
    load_dtd=False,
    resolve_entities=False,
    no_network=True,
    huge_tree=False,
    recover=False,
)
with zipfile.ZipFile(path) as z:
    infos = z.infolist()
    names = {info.filename for info in infos}
    assert len(names) == len(infos), "duplicate archive member names are unsafe"
    assert "[Content_Types].xml" in names and "word/document.xml" in names
    assert sum(info.file_size for info in infos) <= MAX_TOTAL_UNCOMPRESSED
    actual_total = 0
    for info in infos:
        assert info.file_size <= MAX_ENTRY, f"oversized part: {info.filename}"
        ratio = info.file_size / max(info.compress_size, 1)
        assert ratio <= MAX_COMPRESSION_RATIO, f"suspicious compression ratio: {info.filename}"
        is_xml = info.filename.endswith((".xml", ".rels"))
        if is_xml:
            assert info.file_size <= MAX_XML_PART, f"oversized XML part: {info.filename}"
        chunks = []
        actual_size = 0
        # Stream every bounded member to verify decompression and CRC. Do not call testzip()
        # before the limits: it would expand every member regardless of declared risk.
        with z.open(info) as stream:
            while chunk := stream.read(64 * 1024):
                actual_size += len(chunk)
                actual_total += len(chunk)
                assert actual_size <= MAX_ENTRY, f"part exceeded read limit: {info.filename}"
                assert actual_total <= MAX_TOTAL_UNCOMPRESSED, "archive exceeded total read limit"
                if is_xml:
                    chunks.append(chunk)
        assert actual_size == info.file_size, f"size mismatch: {info.filename}"
        if is_xml:
            etree.fromstring(b"".join(chunks), parser=safe_xml_parser)
```

These limits are conservative review defaults, not a DOCX specification. Raise one only for an
explicitly trusted, expected large input, and keep the streaming/per-part checks in place.

Then the SKILL.md postcheck (python-docx re-open, optional soffice PDF smoke test).

## Report format

State what is broken, the minimal repair applied, and what could not be verified without the
target viewer (exact pagination, field updates, embedded font rendering).
