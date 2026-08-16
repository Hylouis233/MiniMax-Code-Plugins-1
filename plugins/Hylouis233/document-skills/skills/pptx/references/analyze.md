# Analyze / triage a deck

## Content inventory

```python
from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE_TYPE
from pptx.oxml.ns import qn

def iter_shapes(shapes):
    """Walk shapes recursively so content nested inside group shapes is counted too."""
    for shape in shapes:
        if shape.shape_type == MSO_SHAPE_TYPE.GROUP:
            yield from iter_shapes(shape.shapes)
        else:
            yield shape

def cached_numeric_points(series, element_name):
    """Read cached numeric points python-pptx does not expose for XY/bubble axes.

    Returns (idx, value) pairs: a series with blank points omits those <c:pt>
    entries while later points keep their original idx, so values extracted
    without their indices cannot be paired across the x/y/bubble axes.
    """
    return [
        (int(pt.get("idx")), pt.find(qn("c:v")).text)
        for pt in series._element.xpath(f"./c:{element_name}//c:pt")
        if pt.get("idx") is not None and pt.find(qn("c:v")) is not None
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
        [[{
            "text": cell.text,
            "is_merge_origin": cell.is_merge_origin,
            "is_spanned": cell.is_spanned,
            "span_width": cell.span_width,
            "span_height": cell.span_height,
        } for cell in row.cells] for row in sh.table.rows]
        for sh in shapes if sh.has_table
    ]
    charts = []
    for sh in shapes:
        if not sh.has_chart:
            continue
        chart = sh.chart
        chart_title = (
            chart.chart_title.text_frame.text
            if chart.has_title else ""
        )
        plots = []
        for plot in chart.plots:
            plot_kind = type(plot).__name__
            if plot_kind in {"XyPlot", "BubblePlot"}:
                series = []
                for item in plot.series:
                    values = {
                        "name": item.name,
                        # Pair x/y/bubble entries by idx; a missing idx marks a
                        # blank point and must not shift the pairing.
                        "x_points": cached_numeric_points(item, "xVal"),
                        "y_points": cached_numeric_points(item, "yVal"),
                    }
                    if plot_kind == "BubblePlot":
                        values["bubble_points"] = cached_numeric_points(item, "bubbleSize")
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

# Security limits must survive `python -O` (which strips assert statements),
# so every check raises explicitly instead of asserting.
def require(condition, message):
    if not condition:
        raise ValueError(message)

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
    require(len(names) == len(infos), "duplicate archive member names are unsafe")
    require("[Content_Types].xml" in names and "ppt/presentation.xml" in names,
            "missing required OPC members")
    require(sum(info.file_size for info in infos) <= MAX_TOTAL_UNCOMPRESSED,
            "declared total uncompressed size above limit")

    actual_total = 0
    for info in infos:
        require(info.file_size <= MAX_ENTRY, f"oversized part: {info.filename}")
        ratio = info.file_size / max(info.compress_size, 1)
        require(ratio <= MAX_COMPRESSION_RATIO, f"suspicious compression ratio: {info.filename}")
        is_xml = info.filename.endswith((".xml", ".rels"))
        if is_xml:
            require(info.file_size <= MAX_XML_PART, f"oversized XML part: {info.filename}")

        chunks = []
        actual_size = 0
        # Streaming to EOF verifies decompression and CRC only after metadata limits pass.
        with archive.open(info) as stream:
            while chunk := stream.read(64 * 1024):
                actual_size += len(chunk)
                actual_total += len(chunk)
                require(actual_size <= MAX_ENTRY, f"part exceeded read limit: {info.filename}")
                require(actual_total <= MAX_TOTAL_UNCOMPRESSED, "archive exceeded total read limit")
                if is_xml:
                    chunks.append(chunk)
        require(actual_size == info.file_size, f"size mismatch: {info.filename}")
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
from pptx.enum.shapes import MSO_SHAPE_TYPE
from pptx.opc.constants import RELATIONSHIP_TYPE as RT
from pptx.oxml.ns import qn

def iter_shapes(shapes):
    """Self-contained recursive walker for this independently runnable block."""
    for shape in shapes:
        if shape.shape_type == MSO_SHAPE_TYPE.GROUP:
            yield from iter_shapes(shape.shapes)
        else:
            yield shape

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

def required_font_slots(text):
    tags = script_tags(text)
    slots = []
    if any(ch.isascii() and ch.isalnum() for ch in text):
        slots.append("latin")
    if any(tag in ("Hans", "Hant", "Jpan", "Hang") for tag in tags):
        slots.append("eastAsia")
    if any(tag in ("Arab", "Hebr", "Deva") for tag in tags):
        slots.append("complexScript")
    return slots or ["latin"]

def theme_candidates_by_slot(role_fonts, text):
    tags = script_tags(text)
    east_tags = {"Hans", "Hant", "Jpan", "Hang"}
    complex_tags = {"Arab", "Hebr", "Deva"}
    candidates = {}
    for slot in required_font_slots(text):
        slot_tags = [
            tag for tag in tags
            if (slot == "eastAsia" and tag in east_tags)
            or (slot == "complexScript" and tag in complex_tags)
            or (slot == "latin" and tag not in east_tags | complex_tags)
        ]
        faces = [role_fonts[slot]]
        faces.extend(role_fonts["scripts"].get(tag, "") for tag in slot_tags)
        candidates[slot] = [face for face in dict.fromkeys(faces) if face]
    return candidates

# 2. Per run: explicit value, else paragraph defaults, else report as inherited.
# run.font.name exposes only the LATIN typeface; a run that also declares a:ea
# or a:cs must be resolved per the scripts present in its own text first.
def explicit_run_faces(run):
    """Direct a:latin/a:ea/a:cs faces keyed by slot; missing slots stay missing."""
    rPr = run._r.find(qn("a:rPr"))
    if rPr is None:
        return {}
    declared = {}
    for slot, tag in (("latin", "a:latin"), ("eastAsia", "a:ea"), ("complexScript", "a:cs")):
        node = rPr.find(qn(tag))
        if node is not None and node.get("typeface"):
            declared[slot] = node.get("typeface")
    return declared

def resolve_run_faces(run, paragraph, role_fonts):
    """Resolve every required script slot without letting one direct slot hide another."""
    direct = explicit_run_faces(run)
    inherited = theme_candidates_by_slot(role_fonts, run.text)
    resolved = []
    for slot in required_font_slots(run.text):
        if slot in direct:
            faces, source = [direct[slot]], "run direct"
        elif slot == "latin" and run.font.name:
            faces, source = [run.font.name], "run latin"
        elif slot == "latin" and paragraph.font.name:
            faces, source = [paragraph.font.name], "paragraph defaults (latin)"
        else:
            faces = inherited.get(slot, []) or ["(unresolved inherited face)"]
            source = "theme candidates (verify placeholder chain/locale)"
        resolved.append({"slot": slot, "faces": faces, "source": source})
    return resolved

def iter_text_frames(shapes):
    """Shape text frames plus every table cell's text frame (a graphic frame
    has has_text_frame=False, so tables must be walked explicitly)."""
    for shape in shapes:
        if shape.has_text_frame:
            yield shape.text_frame
        if getattr(shape, "has_table", False):
            for row in shape.table.rows:
                for cell in row.cells:
                    yield cell.text_frame

for i, slide in enumerate(prs.slides):
    master_name, theme_fonts = theme_faces_for_slide(slide)
    print(i, "master:", master_name, "theme:", ascii(theme_fonts))
    title_shape = slide.shapes.title
    for frame in iter_text_frames(iter_shapes(slide.shapes)):
        holder = getattr(frame, "_parent", None)  # the shape for ordinary frames
        for paragraph in frame.paragraphs:
            for run in paragraph.runs:
                role = "major" if (
                    title_shape is not None and
                    getattr(holder, "_element", None) is title_shape._element
                ) else "minor"
                resolved = resolve_run_faces(run, paragraph, theme_fonts[role])
                print(i, repr(run.text[:20]), f"{role} font slots:", ascii(resolved))
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
