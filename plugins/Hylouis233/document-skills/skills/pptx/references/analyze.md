# Analyze / triage a deck

## Content inventory

```python
from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE_TYPE

def iter_shapes(shapes):
    """Walk shapes recursively so content nested inside group shapes is counted too."""
    for shape in shapes:
        if shape.shape_type == MSO_SHAPE_TYPE.GROUP:
            yield from iter_shapes(shape.shapes)
        else:
            yield shape

def cached_numeric_values(series, element_name):
    """Read the cached numeric points python-pptx does not expose for XY/bubble axes."""
    return [
        node.text for node in
        series._element.xpath(f"./c:{element_name}//c:pt/c:v")
    ]

prs = Presentation("input.pptx")
print("slide size:", prs.slide_width, prs.slide_height)
for i, slide in enumerate(prs.slides):
    layout = slide.slide_layout.name
    title = slide.shapes.title.text_frame.text if slide.shapes.title is not None else ""
    notes = slide.notes_slide.notes_text_frame.text if slide.has_notes_slide else ""
    shapes = list(iter_shapes(slide.shapes))   # flattened; groups are common in template decks
    text = [sh.text_frame.text for sh in shapes if sh.has_text_frame and sh.text_frame.text]
    tables = [
        [[cell.text for cell in row.cells] for row in sh.table.rows]
        for sh in shapes if sh.has_table
    ]
    charts = []
    for sh in shapes:
        if not sh.has_chart:
            continue
        chart = sh.chart
        chart_title = (
            chart.chart_title.text_frame.text
            if chart.has_title and chart.chart_title.has_text_frame else ""
        )
        plots = []
        for plot in chart.plots:
            plot_kind = type(plot).__name__
            if plot_kind in {"XyPlot", "BubblePlot"}:
                series = []
                for item in plot.series:
                    values = {
                        "name": item.name,
                        "x_values": cached_numeric_values(item, "xVal"),
                        "y_values": cached_numeric_values(item, "yVal"),
                    }
                    if plot_kind == "BubblePlot":
                        values["bubble_sizes"] = cached_numeric_values(item, "bubbleSize")
                    series.append(values)
                plots.append({"kind": plot_kind, "series": series})
            else:
                categories = [
                    [str(level) for level in label]
                    for label in plot.categories.flattened_labels
                ]
                series = [
                    {"name": item.name, "values": list(item.values)}
                    for item in plot.series
                ]
                plots.append({"kind": plot_kind, "categories": categories, "series": series})
        charts.append({"title": chart_title, "plots": plots})
    pictures = [sh.name for sh in shapes if sh.shape_type == MSO_SHAPE_TYPE.PICTURE]

    # These full values - not only counts or lengths - are the evidence for summaries and
    # repurposing. Keep notes verbatim so markdown output can preserve them as blockquotes.
    print(f"slide {i + 1}: layout={layout!r} title={title!r}")
    print("  text:", text)
    print("  tables:", tables)
    print("  charts:", charts)
    print("  pictures:", pictures)
    print("  notes:", notes)
```

(Simplify the title lookup to `slide.shapes.title` when present; the defensive loop is for
layouts where the title placeholder is missing.)

## Triage: deck renders wrong

| Symptom | Check | Fix |
|---|---|---|
| Shape crosses the slide edge | compare all four shape bounds with the slide bounds | move or resize the shape |
| Text is clipped or overflows its box | render every slide and inspect right/left and bottom/vertical fit; shape bounds do not measure laid-out text | reflow, resize the box, or reduce text/font size, then render again |
| Everything shifted | slide size changed between sources | normalize slide size or re-layout on the target size |
| Fonts look wrong elsewhere | non-embedded fonts (pptx rarely embeds) | report every effective font via the resolution chain below, not just explicit `run.font.name` values |
| File will not open | broken ZIP / part mismatch | run the bounded package health check below before parsing every XML part |
| Pictures blank | media parts missing or rels broken | verify `ppt/media/*` present and slide rels reference them |

## Bounded package health check

Inspect declared sizes and compression ratios before decompressing anything. `ZipFile.testzip()`
must not be the first check because it expands every member, including an archive bomb.

```python
import zipfile
from lxml import etree

path = "input.pptx"
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

with zipfile.ZipFile(path) as archive:
    infos = archive.infolist()
    names = {info.filename for info in infos}
    assert len(names) == len(infos), "duplicate archive member names are unsafe"
    assert "[Content_Types].xml" in names and "ppt/presentation.xml" in names
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
        # Streaming to EOF verifies decompression and CRC only after metadata limits pass.
        with archive.open(info) as stream:
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

These are conservative triage defaults, not PPTX format limits. Raise a limit only for an
explicitly trusted large deck, and retain the per-member and streaming checks.

## Font triage with inheritance

Most template decks set no explicit `run.font.name`; the effective face is inherited from the
placeholder, layout, master, or theme. Resolve what you can and name the fallback explicitly:

```python
import xml.etree.ElementTree as ET
from pptx import Presentation
from pptx.opc.constants import RELATIONSHIP_TYPE as RT

prs = Presentation("deck.pptx")

# 1. Resolve the theme related to each slide's own layout/master. A package can contain
# multiple masters with different themes, so the first /ppt/theme/* part is not a safe default.
theme_cache = {}
DRAWINGML = {"a": "http://schemas.openxmlformats.org/drawingml/2006/main"}

def read_theme_role(root, role):
    node = root.find(f".//a:{role}Font", DRAWINGML)
    if node is None:
        return {"latin": "", "eastAsia": "", "complexScript": "", "scripts": {}}
    def typeface(tag):
        child = node.find(f"a:{tag}", DRAWINGML)
        return "" if child is None else child.get("typeface", "")
    return {
        "latin": typeface("latin"),
        "eastAsia": typeface("ea"),
        "complexScript": typeface("cs"),
        "scripts": {
            child.get("script"): child.get("typeface", "")
            for child in node.findall("a:font", DRAWINGML) if child.get("script")
        },
    }

def theme_faces_for_slide(slide):
    master_part = slide.slide_layout.slide_master.part
    cache_key = str(master_part.partname)
    if cache_key not in theme_cache:
        theme_part = master_part.part_related_by(RT.THEME)
        root = ET.fromstring(theme_part.blob)
        theme_cache[cache_key] = {
            "major": read_theme_role(root, "major"),
            "minor": read_theme_role(root, "minor"),
        }
    return cache_key, theme_cache[cache_key]

def script_tags(text):
    tags = []
    for character in text:
        codepoint = ord(character)
        if 0x3040 <= codepoint <= 0x30FF:
            tags.append("Jpan")
        elif 0xAC00 <= codepoint <= 0xD7AF:
            tags.append("Hang")
        elif 0x2E80 <= codepoint <= 0x9FFF:
            tags.extend(("Hans", "Hant", "Jpan", "Hang"))  # locale disambiguates Han
        elif 0x0400 <= codepoint <= 0x052F:
            tags.append("Cyrl")
        elif 0x0590 <= codepoint <= 0x05FF:
            tags.append("Hebr")
        elif 0x0600 <= codepoint <= 0x06FF:
            tags.append("Arab")
        elif 0x0900 <= codepoint <= 0x097F:
            tags.append("Deva")
    return list(dict.fromkeys(tags))

def theme_candidates(role_fonts, text):
    faces = [role_fonts["latin"]]
    tags = script_tags(text)
    if any(tag in ("Hans", "Hant", "Jpan", "Hang") for tag in tags):
        faces.append(role_fonts["eastAsia"])
    if any(tag in ("Arab", "Hebr", "Deva") for tag in tags):
        faces.append(role_fonts["complexScript"])
    faces.extend(role_fonts["scripts"].get(tag, "") for tag in tags)
    return [face for face in dict.fromkeys(faces) if face]

# 2. Per run: explicit value, else paragraph defaults, else report as inherited.
for i, slide in enumerate(prs.slides):
    master_name, theme_fonts = theme_faces_for_slide(slide)
    print(i, "master:", master_name, "theme:", ascii(theme_fonts))
    title_shape = slide.shapes.title
    for shape in iter_shapes(slide.shapes):
        if not shape.has_text_frame:
            continue
        for paragraph in shape.text_frame.paragraphs:
            for run in paragraph.runs:
                if run.font.name:
                    face, source = run.font.name, "run"
                elif paragraph.font.name:
                    face, source = paragraph.font.name, "paragraph defaults"
                else:
                    role = "major" if (
                        title_shape is not None and shape._element is title_shape._element
                    ) else "minor"
                    face = theme_candidates(theme_fonts[role], run.text)
                    source = f"inherited {role} theme candidates (verify placeholder chain/locale)"
                print(i, shape.name, repr(run.text[:20]), "font:", ascii(face), "source:", source)
```

python-pptx does not evaluate the full placeholder -> layout -> master inheritance chain; when
a run reports inherited, list the script-aware theme candidates above and, if the exact face
matters, check the layout and master placeholder of the same index for explicit `<a:latin>`,
`<a:ea>`, `<a:cs>`, and script-specific `<a:font>` mappings. Han text also needs the deck locale
to distinguish Hans, Hant, Japanese, and Korean theme mappings.

## Text-fit verification

`python-pptx` exposes a text box's geometry, not the renderer's final glyph and line layout.
After any text or layout change, render all slides with the fonts used in production:

```bash
python -c "from pathlib import Path; Path('deck-render').mkdir(exist_ok=True)"
soffice --headless --convert-to pdf --outdir deck-render input.pptx
```

Inspect every page of `deck-render/input.pdf` for horizontal clipping and for the final line being
clipped or missing at the bottom. Rasterize the PDF when image inspection is easier. If this must
be an automated gate, use measured text bounds from a native renderer in both axes;
`shape.left + shape.width` is only a slide-boundary check, not an overflow test.

## Report contract

Summarize: slide count, per-slide one-line inventory, then findings ranked by user impact.
Extraction for repurposing goes to markdown with speaker notes preserved as blockquotes.
