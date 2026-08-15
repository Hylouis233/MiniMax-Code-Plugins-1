# CJK typography in DOCX (Chinese, Japanese, Korean)

python-docx is Latin-first: `run.font.name` writes only the `w:ascii` and `w:hAnsi` slots.
Chinese text renders from the `w:eastAsia` slot, so a "font is wrong in Word but fine in
LibreOffice" report almost always means the east-asian face was never set.

## Set the CJK face explicitly

```python
from docx.oxml.ns import qn

def set_fonts(run, latin="Times New Roman", east_asian="宋体"):
    run.font.name = latin                      # writes w:ascii + w:hAnsi
    rPr = run._element.get_or_add_rPr()
    rFonts = rPr.get_or_add_rFonts()
    rFonts.set(qn("w:eastAsia"), east_asian)   # python-docx has no helper for this slot

# Style level: do the same on the style so body text inherits it
style = doc.styles["Normal"]
style.font.name = latin
style.element.get_or_add_rPr().get_or_add_rFonts().set(qn("w:eastAsia"), east_asian)
```

Convention for mixed-script body text: CJK glyphs from the east-asian face, digits and Latin
from a Latin face (Times New Roman or Arial). Both slots set = deterministic rendering.

## Chinese font-size table (字号)

Word's Chinese UI names map to point sizes; scripts must use the points:

| 字号 | pt | typical use | 字号 | pt |
|---|---|---|---|---|
| 初号 | 42 | big covers | 小三 | 15 |
| 小初 | 36 | covers | 四号 | 14 |
| 一号 | 26 | 公文标题辅助 | 小四 | 12 |
| 小一 | 24 | | 五号 | 10.5 |
| 二号 | 22 | 公文标题 | 小五 | 9 |
| 小二 | 18 | section covers | 六号 | 7.5 |
| 三号 | 16 | 公文正文 | 七号 | 5.5 |
| | | | 八号 | 5 |

Common pairings: 正文宋体小四 (reports), 仿宋三号 (official documents), 黑体 for headings at
one size step above the body.

## Paragraph properties CJK actually needs

```python
from docx.shared import Pt

pPr = p._p.get_or_add_pPr()

# First-line indent of exactly two characters - use the char-based attribute, not twips,
# so the indent survives font-size changes
ind = pPr.get_or_add_ind()
ind.set(qn("w:firstLineChars"), "200")        # units are 1/100 of a character

# Fixed line spacing (公文 practice: 28-30 pt fixed; pick one value and stay consistent)
p.paragraph_format.line_spacing = Pt(28)      # writes w:line=560, w:lineRule="exact"
```

- Word's CJK defaults (kinsoku line-breaking, auto space between CJK and Latin) live in
  document defaults and need no action unless the source file disabled them.
- Do not fake a two-char indent with spaces or full-width spaces; `firstLineChars` is the
  durable mechanism and survives re-flow.
- Justify body text (`WD_ALIGN_PARAGRAPH.JUSTIFY`); CJK justification is the expected look.

## Official-document page geometry (GB/T 9704 family)

Public-standard values for 党政机关公文 style documents on A4 - always confirm the user's
edition before promising compliance:

```python
from docx.shared import Cm

section = doc.sections[0]
section.top_margin, section.bottom_margin = Cm(3.7), Cm(3.5)
section.left_margin, section.right_margin = Cm(2.8), Cm(2.6)
# conventional target density with 三号仿宋 body: ~22 lines per page, ~28 chars per line
```

## Font availability is a delivery risk

- `宋体`/`黑体`/`楷体` exist on Chinese Windows; `仿宋_GB2312` may not. Non-Chinese systems
  substitute silently. Report the faces you referenced and expected substitutions in the
  postcheck summary.
- python-docx cannot embed fonts. If the recipient machine is unknown and the layout must be
  exact, say so and suggest embedding from Word (File > Options > Save > Embed fonts), or
  deliver a PDF alongside.

## Postcheck additions for CJK documents

1. Re-open the output and assert the east-asian slot is set on body runs and styles
   (`.get(qn("w:eastAsia"))` is not None) - not just `run.font.name`.
2. Render with soffice and confirm no tofu (missing-glyph boxes) by extracting text from the
   rendered PDF and comparing against the source strings.
3. Confirm `firstLineChars` survived on body paragraphs if the indent was requested.
