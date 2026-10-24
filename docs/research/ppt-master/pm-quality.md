# ppt-master — SVG authoring contract and quality system: implementation analysis

**Target**: `E:\code\_recon\ppt-master` (clone of `hugohe3/ppt-master`), read-only.
**Method**: full reads of the checker entry, the `svg_quality/` package, the compaction/finalize/annotation/batch scripts, `text_measure.py`, the DrawingML width estimator, the contract docs, and the workflow gate text. Every rule below cites the file that owns it.

**Path convention**: `P` = `skills/ppt-master`. All citations are `P/relative/path:line`. Two shorthand names are used throughout:

- `checker.py` = `P/scripts/svg_quality/checker.py` (10,276 lines; the real implementation — `P/scripts/svg_quality_checker.py` is a 63-line shim that re-exports `SVGQualityChecker`, `CANVAS_FORMATS` and the threshold constants, see `P/scripts/svg_quality_checker.py:33-58`).
- `elements.py` = `P/scripts/svg_to_pptx/drawingml/elements.py`; `dml_utils.py` = `P/scripts/svg_to_pptx/drawingml/utils.py`.

**Verification status**: all findings are read from source; nothing in the cloned repo was executed or modified. Where the repo publishes no number (e.g. byte savings from compaction), this report says so instead of inventing one.

---

## 0. Pipeline map — who runs what, in what order

| # | Stage | Command | Owner |
|---|---|---|---|
| 1 | Author pages into `svg_output/NN_name.svg` | model writes SVG | `P/references/shared-standards-core.md:1-3` |
| 2 | Mid-roster gate (`--stage early`) after P05, only when roster ≥ 7 pages | `svg_quality_checker.py <proj> --stage early` | `P/workflows/profiles/quick-generate.md:197` |
| 3 | Chart coordinate verification (data charts only) | `verify-charts` stage | `P/workflows/profiles/quick-generate.md:178`, `P/scripts/docs/svg-pipeline.md:1265` |
| 4 | Final gate, lockless Quick form | `svg_quality_checker.py <proj> --quick-generate --canonical-authoring --stage final --json` | `P/workflows/profiles/quick-generate.md:205-212` |
| 5 | Self-contained preview `svg_final/` | `finalize_svg.py <proj>` (skipped by Quick) | `P/scripts/finalize_svg.py:3-16`, `P/scripts/docs/svg-pipeline.md:954` |
| 6 | Optional visual review (opt-in only) | `visual_review.py <proj>` then rubric subagents | `P/workflows/stages/visual-review.md:11` |
| 7 | Native export | `svg_to_pptx.py` | `P/scripts/docs/svg-pipeline.md:997` |

Export refuses to run without a **current** final report: the report embeds a SHA-256 aggregate over every checked SVG, and postflight compares it against the exact export inputs (`checker.py:10243-10276`, `P/scripts/docs/svg-pipeline.md:997`). A missing report yields `quality_gate=not-provided` and a nonzero exit; a stale one yields `stale` (`P/scripts/docs/svg-pipeline.md:275-277`).

---

## 1. The canonical SVG authoring contract

This is the subset the pipeline accepts. It is a **closed surface**: anything not listed is rejected, not silently dropped (`P/references/shared-standards-core.md:31`).

### 1.1 Canvas and root

1. Root `viewBox="0 0 W H"` with **positive integer pixels**; the lock (or, under Quick, the first authored SVG) defines it, and every page + Layout prototype in one build shares it exactly — `P/references/shared-standards-core.md:167`, `:146`.
2. Root `width`/`height` are optional and **never override** `viewBox`; `viewBox` is the sole canvas authority — `P/scripts/docs/svg-contract.md:389-390`.
3. A root `<svg transform>` is **forbidden** — `P/references/shared-standards-core.md:167`.
4. Export quantizes once at `1 SVG px = 9,525 EMU` — `P/references/shared-standards-core.md:167`, `P/scripts/svg_to_pptx/canvas_contract.py:61`.
5. Non-canonical-but-parseable `viewBox` (fractional dims, `x y` offset) is a **warning**, not an error; a viewBox that differs from `spec_lock` / `--format` / the template's declared viewBox is an **error** — `checker.py:2598-2608` (warn), `:2646-2650` (error).
6. `--format <ppt169|…>` must name a registered format, else `Unsupported canvas format` — `checker.py:2624-2630`.
7. Quick profile: the first SVG fixes the canvas for the whole roster; leftover pages from another run must be deleted because the exporter publishes everything it finds — `P/workflows/profiles/quick-generate.md:182`.

### 1.2 Closed inline-property surface

8. Inline `style` may carry **only** these names: geometry `x/y/width/height/rx/ry/cx/cy/r`, paint/line `fill,stroke,stroke-width,stroke-dasharray,stroke-linecap,stroke-linejoin,fill-opacity,stroke-opacity,vector-effect`, text `font-family,font-size,font-weight,font-style,text-anchor,letter-spacing,text-decoration`, alpha/definition paint `opacity,stop-color,stop-opacity,flood-color,flood-opacity`, plus preview-only `shape-rendering`, `display`, `visibility`, `filter` — `P/scripts/svg_quality/svg_contracts.py:180-188` (`_SUPPORTED_INLINE_STYLE_PROPERTIES`).
9. `filter`, `clip-path`, `marker-start` / `marker-end`, and `<tspan baseline-shift>` are **direct attributes only**, never inline style — `P/scripts/docs/svg-contract.md:33-37`.
10. Unknown inline property ⇒ **error**: “uses unsupported inline style property …; native PPTX export would ignore it” — `svg_contracts.py:535-542`.
11. `!important` anywhere in an inline value ⇒ **error** — `svg_contracts.py:543-546`.
12. `mix-blend-mode`, `isolation`, `backdrop-filter` are **Bake-required** (error; pre-render or rebuild geometry) — `svg_contracts.py:189-193`, `:530-534`.
13. `mask` is fail-closed in the shared surface: `_SHARED_FAIL_CLOSED_STYLE_PROPERTIES = {"mask"}` — `svg_contracts.py:194`; it is also on the structural blacklist, `P/references/shared-standards-core.md:52`.
14. Default paint spelling: six-digit **uppercase** `#RRGGBB`, or `none`, or exact local `url(#id)`; `rgba()` and friends are *accepted* and produce a non-blocking “Recommendation:” warning — `P/references/shared-standards-core.md:65`, `P/scripts/svg_quality/svg_contracts.py:292-394` (`check_paint_compatibility`), `P/scripts/docs/svg-pipeline.md:1229`.
15. `fill-opacity` / `stroke-opacity` / `stop-opacity` / `flood-opacity` must be paired with their color (`_CANONICAL_PAINT_ALPHA_PROPERTY`) — `svg_contracts.py:174-179`.

### 1.3 Forbidden constructs (all errors)

16. `<style>`, `class`, `xml-stylesheet`, `<link rel="stylesheet">`, `@import`, `@font-face` — `svg_contracts.py:217-220`, `:228-238`, `:271-272`; doc `P/references/shared-standards-core.md:53-58`.
17. `id` is an error **only when `<style>` also exists** (CSS selector risk); a bare `id` is required and valid — `svg_contracts.py:221-227`.
18. `<foreignObject>` — “use `<tspan>` for manual line breaks” — `svg_contracts.py:252-254`.
19. `<textPath>` — `svg_contracts.py:269-270`.
20. SMIL: any `animate*` element, `<set>` — `svg_contracts.py:275-281`.
21. `<script>` and any `on*` attribute — `svg_contracts.py:282-285`.
22. `<iframe>` — `svg_contracts.py:288-289`.
23. Elements with no native converter dispatch (e.g. `<image>` inside unsupported containers, unknown visual primitives) are collected after `<use>` expansion and fail as one aggregated error: “Unsupported visual SVG element(s) for native PPTX export: …” — `checker.py:5434-5473`.
24. Text characters: raw Unicode for typography (`—` `–` `©` `®` `→` `·`, NBSP, full-width punctuation, emoji), **HTML named entities forbidden**; XML-reserved chars must be `&amp; &lt; &gt; &quot; &apos;` — `P/references/shared-standards-core.md:39-46`. One offending character aborts export.

### 1.4 Text

25. `font-size` is a **finite positive unitless px number**; `px` suffix is parseable but warns (“generated SVG should prefer unitless px”); any other unit/percentage is an error — `P/scripts/svg_quality/svg_contracts.py:1060-1131` (canonical regex `^(?:\d+(?:\.\d+)?|\.\d+)$` at `:1062`; error at `:1103-1106`; recommendation at `:1127-1131`).
26. `font-size` must also land inside the DrawingML `sz` range 1..4000 pt; outside ⇒ error, because PowerPoint would silently repair the file — `svg_contracts.py:1089-1094`, `:1108-1120`.
27. `font-weight` ∈ `normal|bold|100…900`; `font-style` ∈ `normal|italic`; `text-anchor` ∈ `start|middle|end`, and is **invalid on `<tspan>`** — `P/scripts/docs/svg-contract.md:39-47`, `P/references/shared-standards-core.md:65`.
28. Inheritable text declarations belong only on `<svg>`, `<g>`, `<text>`, `<tspan>` — `P/scripts/docs/svg-contract.md:43-44`.
29. Multiline = one `<text>` per logical paragraph; later lines are **direct positioned `<tspan>` children that repeat the parent `x` with positive relative `dy`**; an all-`<tspan>` form may start at `dy="0"` — `P/references/shared-standards-core.md:178`.
30. `line-height` has **no registered DrawingML mapping** — lead must be authored as numeric `dy`, not CSS — `P/references/shared-standards-core.md:184`.
31. Authoring lead defaults (soft, overridable): titles ≈`1.2–1.3×`, dense body `1.4–1.5×`, ordinary body `1.5–1.6×`, breathing `1.6–2.0×` font-size — `P/references/shared-standards-core.md:184`.
32. Sibling `<text>` elements used as one paragraph's line breaks are a **heuristic warning** and must be repaired before export — `checker.py:5002-5175` (`_check_fragmented_paragraph_text`), thresholds `checker.py:442-451` (gap ratio 0.9–2.05×, x tolerance 0.5 px, ≥12 total chars, ≥8 in longest line, terminator/list-marker regexes).
33. Leading text that cannot be normalized into one text frame is warned: `_check_unmergeable_leading_text` — `checker.py:4980-5001`, reject reasons at `:5194-5219`.
34. Icon placeholders use the pipeline form `<use data-icon="library/name">`, distinct from local `<use>` — `P/references/shared-standards-core.md:169`; unresolved placeholders are a hard failure at `checker.py:5364-5433`.

### 1.5 Geometry precision

35. Digital geometry attributes (`x,y,width,height,rx,ry,cx,cy,r,x1…y2,dx,dy,stroke-width`) are **finite unitless ordinary decimals** in viewBox space; `px` read-compatible + warns; `pt,pc,in,cm,mm,q,em,rem,%`, expressions, scientific notation, leading `+`, trailing `.` are invalid — `P/scripts/docs/svg-contract.md:343-364`, `P/references/shared-standards-core.md:136`.
36. `width,height,r,rx,ry` must be **non-negative**; `stroke-width` too — `P/scripts/docs/svg-contract.md:358-359`.
37. An explicitly supplied invalid value **never falls back to a default** — `P/scripts/docs/svg-contract.md:363-364`.
38. Inline geometry in `style` must be single `px` literals per element (`x:120px`, `-8.5px`); exact zero may be unitless; `%`, `auto`, `calc()`, `var()`, `inherit`, `!important` forbidden — `P/scripts/docs/svg-contract.md:380-384`. The pipeline **materializes** them into XML attributes before post-processing — `svg_contracts.py:245-249`.
39. Line endpoints, text positions, path data and point lists stay XML attributes — `P/scripts/docs/svg-contract.md:384`.
40. Coordinate compaction writes at most **2 decimals** without trailing zeros, and normalizes `-0` to `0` — `P/scripts/compact_svg_coordinates.py:38`, `:93-101`.
41. Shape frames are validated against the exporter's own OOXML `xfrm` range; only messages containing `OOXML` are surfaced (grammar errors have their own checks) — `checker.py:4475-4491`.

### 1.6 Images

42. `<image>` needs resolvable `href`; the checker walks visible images and tests existence/relative resolution of file targets — `checker.py:5220-5362`.
43. Crop/fit vocabulary is closed: `slice` (cover → native `srcRect`), `meet` (contain → fitted frame), `none` (stretch) — `P/references/svg-effects.md:245-249`.
44. `clip-path` maps **only on `<image>`**: one local `<clipPath>` in `<defs>` with exactly one direct `<circle>|<ellipse>|<rect rx/ry>|<path>|<polygon>`, no `clip-rule`/`fill-rule`; circle/ellipse/rect must exactly cover the image frame; path/polygon becomes custom geometry inside the frame. On shapes/groups/text it is forbidden — `P/scripts/docs/svg-contract.md:89-111`, `P/references/shared-standards-core.md:81`, enforced at `svg_contracts.py:645-658`.
45. Raster resolution gates are warnings: upscale ratio > `2.0`, downsample ratio > `4.0` **and** source ≥ `1 MB` — `checker.py:866-868` (`IMAGE_UPSCALE_WARN_RATIO`, `IMAGE_DOWNSIZE_WARN_RATIO`, `IMAGE_DOWNSIZE_WARN_MIN_BYTES = 1024*1024`).
46. Stretch deviation is measured (`_stretch_deviation`) from declared pixel size vs frame aspect — `checker.py:8488-8501`, pixel probe at `:8466-8487`.
47. `svg_final/` embeds assets Base64 and aligns `<image>` in one pass (`align-images`); EMF/WMF keep an external-reference exception — `P/scripts/finalize_svg.py:31-35`, `:7-8`.
48. Web-sourced images must appear in `image_sources.json` with attribution; missing entries are reported — `checker.py:7020-7084`, manifest load at `:6916-6992`.

### 1.7 Gradient / filter / clip / marker / `<use>`

49. Gradient definitions live in `<defs>`, one ID, validated as a closed interface (stop count/order, coordinates, `gradientUnits`) — `svg_contracts.py:700-729`; authoring recipes `P/references/svg-effects.md:119-175`.
50. Shadow/glow = one registered filter with `feDropShadow`-equivalent grammar; elevation tiers are fixed: resting `dy 2–4 / stdDev 4–8 / alpha 0.06–0.10`, raised `dy 6–10 / 10–16 / 0.12–0.20`, glow `0 offset / 4–8 / 0.35–0.55` — `P/references/svg-effects.md:211-216`; validator `svg_contracts.py:670-680`.
51. Line-end markers: only 5 shapes map natively (closed 3-vertex triangle, concave 4-vertex stealth, open 3-vertex arrow, convex 4-vertex diamond, circle/ellipse oval), one explicit `M`/`L` per vertex, `orient="auto"|"auto-start-reverse"`, color parity with the parent stroke — `P/scripts/docs/svg-contract.md:64-81`, validator `svg_contracts.py:631-644`.
52. Local `<use>`: `href="#id"` (SVG 2 form; legacy `xlink:href` read-compatible, must agree if both present), target = `symbol|g|use|rect|circle|ellipse|line|path|polygon|polyline|text|image`, symbol needs finite positive 4-number `viewBox` + positive instance `width/height`, `slice`/`refX`/`refY` forbidden, artwork must stay inside the symbol viewBox, **≤ 64 instances per reference chain, ≤ 10 000 `<use>` per file**, no layer/placeholder/chart metadata in the reused subtree — `P/scripts/docs/svg-contract.md:115-138`.
53. Group opacity is accepted but `Approximate`: multiplied into descendants — `P/scripts/docs/svg-contract.md:396-400`, `P/references/shared-standards-core.md:140`.

### 1.8 Structure: groups, bounds, ids

54. Every visible **direct root `<g>`** except a compact helper-authored preset atom declares positive root-coordinate `data-pptx-bounds="x y width height"` sized as the intended module zone — `P/references/shared-standards-core.md:190`, enforced `checker.py:4679-4698`.
55. Missing bounds is an **error** for final pages / templates / structured pages, and only a warning for reference SVGs without `data-pptx-page-role` / structure attrs — `checker.py:4679-4686`, `:4764-4775`.
56. Ordinary root modules must be disjoint beyond a **1 px** tolerance on both axes — `checker.py:439` (`_BOUNDS_OVERFLOW_TOLERANCE = 1.0`), `:4747-4762`.
57. Text may overflow its module up to **5 %** as a warning; > 5 % is an error; the exact 5.000 % boundary stays a warning (`math.isclose(abs_tol=1e-9)`) — `checker.py:440` (`_BOUNDS_OVERFLOW_ERROR_RATIO = 0.05`), `:4338-4350`.
58. Text beyond the root `viewBox` is **always an error**, no ratio gate — `checker.py:4371-4402`.
59. Overlap exemptions: structured slots, registered structural-role groups (`background, decoration, header, footer, chrome, watermark, page-number, logo`), and a wholly off-canvas Morph endpoint marked `data-pptx-morph-staging="true"` — `checker.py:4302-4318`, `P/references/shared-standards-core.md:190`, `:194`.
60. `data-pptx-morph-staging` itself has a contract: value exactly `"true"`, on a direct-root `<g>`, stable non-empty `id`, valid `data-pptx-bounds`, wholly disjoint from the canvas, and cannot combine with `data-pptx-layer`/`data-pptx-placeholder` — `checker.py:4604-4668`.
61. Top-level semantic groups need a **descriptive, page-unique `id`** (`card-1`, `step-discover`, `header`) — `P/references/shared-standards-core.md:215`; grouping units table `:198-208`; animation anchors `:179`.
62. Forbidden grouping: one giant `<g>` around the slide; many ungrouped root atoms; one group per icon/text line; anonymous top-level groups — `P/references/shared-standards-core.md:212-215`.
63. Native background promotion: first visual layer is a direct full-canvas `<rect>` (or inside a single-child group) with solid/gradient/preset fill, no transform/filter/clip/rounding/visible stroke — `P/references/shared-standards-core.md:180`.
64. Defs are "direct, uniquely identified": duplicate IDs, foreign namespaces, missing targets fail — `svg_contracts.py:603-615`; paint-server resolution `:617-629`.

### 1.9 Metadata and annotation conventions

65. Rendering-neutral markers only, and removing them must not change browser rendering — `P/references/semantic-svg.md:3`.
66. Flat pages: exactly one root `data-pptx-page-role` ∈ `cover|toc|section|content|ending`, and **no** Master/Layout/layer/placeholder markers — `P/references/semantic-svg.md:9`, `:15`; validated at `checker.py:6425-6456`.
67. Structured pages: root `data-pptx-master`/`-master-name` + `data-pptx-layout`/`-layout-name`; layer atoms `data-pptx-layer="master|layout"` on **direct root children**, never on `<g>` (except the one validated compact preset group) — `P/references/semantic-svg.md:10-11`, `:34`.
68. Slots: `<g id data-pptx-placeholder="…" data-pptx-bounds="…">` holds exactly one compatible direct child marked `data-pptx-carrier="true"`; composite regions use `data-pptx-placeholder="object"` + `data-pptx-binding="proxy"`; a Layout may have zero slots — `P/references/semantic-svg.md:43-54`.
69. Authored native presets: one atomic `<g data-pptx-authoring="preset">` emitted by `preset_shape_svg.py`, carrying `data-pptx-object`, `data-pptx-prst`, `data-pptx-frame` (exact four-part ordinary-decimal spelling), `data-pptx-av-*`, base paint once, then ordered direct `<path>` children; **never hand-edited**, regenerate instead — `P/scripts/docs/svg-contract.md:273-337`, `P/references/shared-standards-core.md:128`.
70. Edit annotations use `data-edit-target="true"` (+ optional `data-edit-annotation`), discovered read-only by `check_annotations.py`; a parse failure must never be reported as “no annotations” — `P/scripts/check_annotations.py:31-56`, `:5-7`.
71. Element IDs are also the animation/Morph anchors; `data-pptx-page-id` / slide-order metadata is validated so a slide jump cannot exceed the roster — `checker.py:5747-5841` (`_check_animation_group_ids`), `:1225-1227` (`partial_roster`).

---

## 2. `checker.py` in full detail

### 2.1 CLI surface, exit codes, report paths

| Concern | Behaviour | Source |
|---|---|---|
| Target forms | one SVG, a directory, a project, `--all <dir>` | `P/scripts/svg_quality/cli.py:27-44`, `:258-277` |
| `--stage` | `early` \| `first-page` \| `page` \| `final` (default) | `cli.py:230-238` |
| `--page` | only with `--stage page`; must resolve **under** `svg_output/` | `cli.py:46-86`, `:245-250` |
| Stage → roster semantics | `partial_roster = stage in {early, page, first-page}` | `cli.py:279` |
| `--format` | expected canvas format, else error | `cli.py:226-229`, `checker.py:2624-2630` |
| `--json` | writes stage-specific report | `cli.py:336-351` |
| Report file names | `final→svg_quality_report.json`, `first-page→…_first_page_report.json`, `early→…_early_report.json`, `page→…_page_report.json`, all under `validation/` | `cli.py:99-113` |
| `--json-output` | explicit path override | `cli.py:337-346` |
| `--export` / `--output` | plain-text report (default `svg_quality_report.txt`) | `cli.py:328-334` |
| `--roundtrip` | text-capacity gate on `authoring-svg-flat/`; conflicts with `--format/--stage/--page/--all` | `cli.py:251-256`, `:259-261` |
| `--template-mode` | validates `templates/`; conflicts with `--quick-generate` | `cli.py:206-208` |
| `--slot-capacity-report` | advisory slot JSON only, exit 0 | `cli.py:192-202` |
| **Exit code** | `1` if `summary["errors"] > 0`, else `0` | `cli.py:353-356` |
| Warnings | never affect exit status | `P/scripts/docs/svg-pipeline.md:1234-1235` |
| Tip lines | structured native slots + incomplete roster hints on `final` | `cli.py:308-324` |

### 2.2 Per-file check pipeline (execution order)

`check_file` parses XML **once** and bails early on parse failure so regex checks do not produce misleading errors (`checker.py:1312-1316`). Then:

| # | Call | Line |
|---|---|---|
| 0 | `_parse_xml_root` (strict XML; HTML5-tolerant sloppiness fails) | `2552-2575` |
| 0a | `_check_canonical_authoring` (advisory, only with `--canonical-authoring`) | `2502-2550` |
| 0b | hydrate native payload refs | `1319-1326` |
| 0c | Quick roster language warning (`lang` on first page) | `1328-1343` |
| 1 | `_check_viewbox` | `2576-2650` |
| 1a | `_check_legacy_pptx_attributes`, `_record_carrier_receipt` | `1354-1355` |
| 1b | `check_nested_svg_crop_contract` | `1359` |
| 2 | `check_forbidden_elements`, `check_mask_contract` | `1362-1363` |
| 2a | `check_geometry_length_values`, `_check_shape_coordinate_ranges` | `1366-1367` |
| 2b | `check_stroke_style_values` | `1370` |
| 2c | `_check_image_contract`, `check_image_aspect_ratio_values` | `1373-1374` |
| 2d | `check_freeform_geometry_values` | `1377` |
| 2e | `check_transform_values` | `1380` |
| 2f | `check_opacity_values` | `1383` |
| 2g | `check_authoring_property_contract`, `check_text_property_contract`, `_check_preserved_txbody_contract`, `check_paint_compatibility`, `check_reference_spelling`, `check_definition_contract`, `check_paint_reference_contract`, `check_marker_contract`, `check_clip_path_contract` | `1387-1395` |
| 2h | `check_imported_effect_status`, `check_filter_effects` | `1398-1399` |
| 2i | `check_gradient_interfaces` | `1402` |
| 3 | `check_font_size_values` | `1405` |
| 4 | `_check_fonts` | `1408` |
| 5 | `_check_text_elements`, `_check_semantic_shape_text` | `1411-1412` |
| 5b | `_check_hyperlinks` | `1415` |
| 6 | `_check_image_references` | `1418` |
| 7 | `_check_icon_placeholders` | `1421` |
| 7b | `_check_unsupported_visual_elements`, `_check_hidden_elements` | `1424-1425` |
| 7c | `_check_preset_geometry_metadata`, `_check_preset_geometry_transforms` | `1428-1429` |
| 8 | `_check_animation_group_ids` | `1432` |
| 8b | `_check_pattern_fills` | `1435` |
| 8c | `_check_native_object_markers` | `1438` |
| 8d | `_check_pptx_structure_metadata` (template mode or structured project) | `1441-1446` |
| 8e | `_check_semantic_markers` | `1449` |
| 9 | `_check_spec_lock_alignment` (skipped in template mode) | `1456-1462` |
| 10 | `_check_sourced_image_attribution` (skipped in template mode) | `1466-1471` |
| ✔ | `result['passed'] = len(errors) == 0` | `1476` |

`check_directory` adds project-level contracts: PPTX structure (`7519`), partial structure lock (`7761`), duplicate layout keys (`7818`), shared fixed layer (`7861-7936`), layout fingerprint (`7937`), illustration resources (`7976-8124`), planned image closure (`8533-9024`), provenance (`9025`), animation config (`9109`), template contract (`9346-9478`), project setup (`7228-7518`).

### 2.3 Thresholds and formulas (exact)

**Bounding-box overflow** (`checker.py:4214-4256`) — with `inner = (left, top, right, bottom)`, `outer` likewise:

```
left_overflow   = max(outer_left   - left,   0)
right_overflow  = max(right  - outer_right,  0)
top_overflow    = max(outer_top    - top,    0)
bottom_overflow = max(bottom - outer_bottom, 0)
horizontal      = left_overflow  > tolerance or right_overflow  > tolerance
vertical        = top_overflow   > tolerance or bottom_overflow > tolerance
horizontal_ratio = max(left_overflow,  right_overflow)  / (outer_right - outer_left)   if horizontal else 0
vertical_ratio   = max(top_overflow,   bottom_overflow) / (outer_bottom - outer_top)  if vertical   else 0
axes = "horizontal and vertical" | "horizontal" | "vertical"
tolerance = _BOUNDS_OVERFLOW_TOLERANCE = 1.0   # px
```

**Severity split** (`checker.py:4332-4350`):

```
overflow_ratio     = max(horizontal_ratio, vertical_ratio)
exceeds_error_ratio = overflow_ratio > 0.05 AND NOT isclose(overflow_ratio, 0.05, abs_tol=1e-9)
bucket = errors if exceeds_error_ratio else warnings
```

**Page-boundary text overflow** (`checker.py:4381-4402`): same metrics against the root viewBox, **always** appended to `result['errors']`, returns `True` so the caller exempts that text from the module pass (`:4917-4918`).

**Root-module overlap** (`checker.py:4747-4762`):

```
overlap_w, overlap_h = positive intersection dimensions
skip if overlap_w <= 1.0 or overlap_h <= 1.0     # needs BOTH axes past tolerance
else errors: "… overlaps … by {w:.1f}px x {h:.1f}px; keep … disjoint beyond the 1px tolerance"
```

**Text geometry** (`checker.py:3807-3826`, `:3484-3485`):

```
width  = estimate_single_line_text_frame_width(runs, include_headroom=…)
left/right = x-width/2, x+width/2   (middle) | x-width, x (end) | x, x+width (start)
ascent  = font_size * 0.85
descent = font_size * 0.35
top     = y - ascent ; bottom = y + descent          # ⇒ visual line box = 1.20 em
rect    = (left, top, right-left, bottom-top) → transformed to root coordinates
```

Multi-line carriers union all line boxes (`:3958-3997`); inline formula runs raise ascent/descent via the native math extent (`:3486-3498`).

**Text-width diagnostic string** (`checker.py:4164-4197`) — used as a suffix on horizontal overflow messages only:

```
per_cluster = rendered_width / len(clusters)
label = "CJK char" if all CJK else "Latin char" if all ASCII else "mixed char"
fits  = max(0, floor(container_width / per_cluster))
"≈{per_cluster:.1f} px per {label} at {font}px {incl. headroom|without headroom}; ≈{fits} chars fit in {width} px"
```

`rendered_width` accounts for ancestor scaling: the raw estimate is pushed through `_transformed_rect_edge_lengths` and the font size is scaled by `rendered_width / raw_width` (`:4144-4159`).

**Other thresholds**

| Constant | Value | Meaning | Line |
|---|---|---|---|
| `_BOUNDS_OVERFLOW_TOLERANCE` | `1.0` px | ignore/report boundary, module overlap tolerance | `439` |
| `_BOUNDS_OVERFLOW_ERROR_RATIO` | `0.05` | warn ≤ 5 %, error > 5 % | `440` |
| `_ROUNDTRIP_TEXT_CALIBRATION_CAP` | `0.10` | max text-width calibration shift in the roundtrip gate | `441` |
| `_PARAGRAPH_LINE_GAP_MIN_RATIO` / `MAX` | `0.9` / `2.05` | fragmented-paragraph detection band | `442-443` |
| `_PARAGRAPH_LINE_X_TOLERANCE` | `0.5` px | same-column test for paragraph lines | `444` |
| `_PARAGRAPH_LINE_MIN_TOTAL_CHARS` / `MIN_LONGEST_CHARS` | `12` / `8` | heuristic floor | `445-446` |
| `FONT_SIZE_ANCHOR_TOLERANCE_PX` | `2.0` px | declared typography anchor vs rendered size | `859` |
| `SPARSE_UNDECLARED_FONT_SIZE_MAX_OCCURRENCES` | `2` | 3rd undeclared size occurrence becomes an error | `860` |
| `IMAGE_UPSCALE_WARN_RATIO` | `2.0` | raster upscale warning | `866` |
| `IMAGE_DOWNSIZE_WARN_RATIO` / `..._MIN_BYTES` | `4.0` / `1 MiB` | wasted-resolution warning gate | `867-868` |
| `ALL_BG_THRESHOLD` (visual review) | `0.99` | blank-render detector | `P/scripts/visual_review.py:56` |
| visual-review contrast | `< 4.5` small text, `< 3.0` at ≥ 24 px | H4 readability gate | `P/references/visual-review.md:22` |
| visual-review soft spacing | baseline gap `< 1.05×`; `> 150 px` hollow; alignment drift `> 4 px`; grid spacing `> 5 %`; CJK tracking `> 5 %` | S1–S6 | `P/references/visual-review.md:41-46` |

### 2.4 Severity model — what blocks

* **Blocking**: anything appended to `result['errors']`. Exit code and the export gate key off the error count only (`cli.py:353-356`).
* **Advisory**: `result['warnings']` — no change, no acknowledgement, no exit effect (`P/scripts/docs/svg-pipeline.md:1234-1235`). The JSON report further classifies into `blocking / introduced / inherited / source-import` (`checker.py:10175-10180`, `:10203-10220`).
* **Policy asymmetry worth noting** (deliberate, documented): compatible-but-non-canonical spellings are *always* warnings (`rgba()`, `px` suffix, explicit `font-family` repetition), while **unknown** properties are errors. “Canonical compact authoring is a generated-source contract, not a compatibility restriction on external SVG input” — `P/scripts/docs/svg-pipeline.md:597-600`.
* Failing to import a shared validator degrades a check to a warning instead of crashing (`checker.py:5441-5451`, `svg_contracts.py:313-317`, `:1071-1075`), except the two visual-element preflights, which fail closed (`checker.py:5441-5450`).

### 2.5 JSON report schema

`checker.py:10192-10225`:

```jsonc
{
  "schema": "ppt-master.svg-quality-report.v1",
  "stage": "final",
  "target": "<absolute path>",
  "source_fingerprint": { "algorithm": "sha256", "digest": "...", "file_count": N,
                          "files": [ { "file": "01_cover.svg", "sha256": "..." } ] },
  "summary":      { "total": N, "passed": N, "warnings": N, "errors": N },
  "issue_types":  { "<category>": N },
  "categories": {
    "blocking":      { "count": N, "issues": [...] },
    "introduced":    { "count": N, "issues": [...] },
    "inherited":     { "count": N, "issues": [...] },
    "source-import": { "count": N, "summary": {...} }
  },
  "drift":          { "colors": {...}, "fonts": {...}, "sizes": {...} },
  "carrier_receipt": {...},
  "project_issues": [...],
  "files": [ { "file", "path", "exists", "source_sha256", "errors", "warnings",
               "info", "passed" } ]
}
```

Fingerprint construction (`checker.py:10243-10276`): files sorted by basename, then `sha256(basename \0 file_sha256 \n)` accumulated; unreadable bytes are recorded as `unreadable` with an explicit `error`, never silently dropped.

### 2.6 What the flags change

**`--canonical-authoring`** (advisory only, `checker.py:2517-2550`): runs `canonical_authoring_errors(root, compact_native_frames=False)`. Findings become warnings prefixed `Noncanonical compact authoring: …` with a **normalizer hint**: `page-space metadata` → `compact_svg_coordinates.py <svg_output> --inplace --keep-native-frames`; everything else → `compact_svg_styles.py <svg_output> --inplace` (`:2536-2542`). In template mode the message appends “(advisory; structured rosters keep their explicit form)” (`:2529-2535`). The checker **never rewrites the source** — `P/scripts/svg_quality/cli.py:154-155`.

**`--stage`**:

* `early` — checks every authored SVG *so far*, each under partial-roster rules; an incomplete future roster is allowed (`cli.py:282-294`, `P/scripts/docs/svg-pipeline.md:1237-1239`).
* `first-page` — only the first authored SVG, same permissions (`cli.py:296-297`).
* `page` — only `--page`, same partial rules (`cli.py:298-303`).
* `final` — requires the complete declared page roster; writes the release report (`cli.py:304-306`). Also prints the tip when a final run detects an incomplete roster (`cli.py:319-324`).
* Roster size affects structural page-order validation (`checker.py:1225-1227`).

**`--quick-generate`** (lockless profile, `P/scripts/svg_quality/cli.py:147-149`):

* skips `design_spec.md` and `spec_lock.md` lookups (no lock ⇒ no anchor drift, no `canvas` section requirement);
* infers flat vs structured packaging from the complete roster;
* enables the roster-language warning (`checker.py:1328-1343`);
* forbids `--template-mode`, `--all`, `--roundtrip`;
* the export gate fingerprints `validation/svg_quality_report.json` against `svg_output/`, and **both** `--quick-generate` and `--canonical-authoring` plus `--json` are required or export refuses/skips canonical proof (`P/workflows/profiles/quick-generate.md:212`).

### 2.7 What the checker does **not** check (important for any port)

Measured by absence, not by omission in the docs:

* **No contrast / luminance check.** No `contrast|luminance|WCAG` symbol exists anywhere under `P/scripts/svg_quality/**`. Contrast is owned exclusively by the visual-review rubric H4 (`P/references/visual-review.md:22`), which needs rendered PNGs.
* **No minimum-font-size rule.** The only size gates are *form* (`check_font_size_values`), *DrawingML range* (1–4000 pt), and *anchor drift* (±2 px vs `spec_lock`). The standards explicitly refuse a universal floor: “Do not turn this into one universal font-size floor: captions and metadata may be smaller when their role and context remain legible” — `P/references/shared-standards-core.md:246`.
* **No font-availability probe.** `_check_fonts` only records `info.fonts` and warns when the resolved export faces are not PPT-safe (`checker.py:3033-3050`). It never resolves a filesystem font.
* **No pixel diff / render comparison.** That is `visual_review.py` + rubric.
* **Overlap of *shapes*** (as opposed to text vs module) is not a static check; element collision is H6 in the rubric.

---

## 3. How text width/height is estimated without a browser

The estimator is shared by the checker, the exporter, and `text_measure.py` — one implementation, three consumers (`P/scripts/text_measure.py:4`, `:35-36`, `P/scripts/docs/svg-contract.md:10-12`). No headless browser is involved.

### 3.1 Font metric source

Two layers:

1. **Bundled per-glyph advance tables** — `P/scripts/svg_to_pptx/drawingml/font_advances.json`, 119,577 bytes, `schema`/`unit`/`families`, **10 families** (`arial, times new roman, georgia, verdana, calibri, cambria, trebuchet ms, tahoma, garamond, segoe ui`) × 4 styles (`regular, bold, italic, bold-italic`) × **227 glyphs**, values in em. Sample `arial/regular`: `' '=0.2778, '#'=0.5562, '%'=0.8892, '('=0.333`. Loaded once and cached — `dml_utils.py:3731`, `:3739-3760`.
2. **A hand-tuned per-character fallback table** for everything the advances JSON does not cover — `dml_utils.py:3685-3707`:

```
0xFF00–0xFFEF with East_Asian_Width == 'H'  → 0.50 em      # half-width forms
is_cjk_char(ch)                             → 1.00 em      # full-width
' '                                         → 0.30 em
fixed spaces (en/em/3-per-em/4-per-em/…)    → per table    # 0.5, 1.0, 1/3, 0.25, 1/6, 0.55, 0.3, 0.2, 0.1, 0.2
'mMwWOQ%'                                   → 0.75 em
'iIlj!|'                                    → 0.30 em
isdigit()                                   → 0.55 em      # tabular digits, incl. '1'
otherwise                                   → 0.55 em
```

Fixed-space table at `dml_utils.py:3658-3669`; Unicode-decomposed accents fall back to their base letter (`:3675-3682`).

### 3.2 CJK vs Latin

`is_cjk_char` covers Han, Hiragana, Katakana, Hangul, and the ranges `2E80–2FFF, 3000–303F, 3100–312F, 31A0–31BF, 31C0–31EF, FF00–FFEF` — `dml_utils.py:3343-3357`. Segmentation splits a run into `(text, is_cjk)` runs so headroom can be chosen **per script segment**: “a Chinese sentence that mentions `AI` keeps its own base headroom instead of inheriting the all-caps ceiling for the whole line” — `elements.py:2169-2184`, docstring `:2190-2194`. The wide-face family correction applies to Latin clusters only; CJK clusters draw with the `ea` face and do not count toward the uppercase fraction — `elements.py:2342-2354`.

Cluster splitting itself is a bounded grapheme approximation: combining marks, variation selectors, emoji modifiers, ZWJ sequences, regional-indicator pairs, and common virama conjuncts — `dml_utils.py:3589-3642`.

### 3.3 The advance sum, quoted

`dml_utils.py:3763-3797`:

```python
def estimate_text_cluster_widths(text, font_size, font_weight='400', *,
                                 font_family=None, font_style='normal') -> list[float]:
    advances = get_font_advances(font_family, font_weight, font_style)
    bold = font_weight in ('bold', '600', '700', '800', '900')
    widths = []
    for cluster in split_project_text_clusters(text):
        cjk = any(is_cjk_char(ch) for ch in cluster)
        if advances is not None and not cjk and all(...):        # exact table hit
            widths.append(sum(advances[ch] for ch in cluster) * font_size)
            continue
        ...
        width = _estimate_grapheme_width(cluster, font_size)
        widths.append(width * 1.05 if bold and not cjk else width)
    return widths
```

`_estimate_grapheme_width` (`:3710-3728`) takes `max(base width)` plus `font_size * 0.3` per **spacing** combining mark (`Mc`); emoji/regional-indicator clusters get a full `font_size`.

**Letter-spacing** is applied as one gap between clusters, not scaled by headroom — `elements.py:2355-2361`:

```python
return sum(cluster_widths) + letter_spacing_px * max(len(cluster_widths) - 1, 0)
```

where `letter_spacing_px = drawingml_letter_spacing(value_px) / 75` (`dml_utils.py:46`: `FONT_PX_TO_HUNDREDTHS_PT = 75`, i.e. 1 px = 0.75 pt). Negative tracking that would make a run non-positive is rejected outright (`elements.py:2364-2378`).

### 3.4 Headroom (why the estimator is pessimistic by design)

Constants `elements.py:2066-2069`:

```
_TEXT_WIDTH_HEADROOM_BASE        = 1.06     # sans, low uppercase fraction
_TEXT_WIDTH_HEADROOM_CAPS        = 1.12     # sans, all caps
_SERIF_TEXT_WIDTH_HEADROOM_BASE  = 1.12
_SERIF_TEXT_WIDTH_HEADROOM_CAPS  = 1.36
```

Applied per script segment with linear interpolation on the Latin uppercase fraction, and clamped so the result never falls below the raw advance (`elements.py:2196-2228`):

```python
caps  = 0.0 if cjk else _uppercase_fraction([segment])
width += _estimate_run_text_width(segment) * (base + (ceiling - base) * caps)
...
width += letter_spacing_px * (len(segments) - 1)
return max(width, _estimate_run_text_width(run))
```

Wide/monospaced families override the generic table: `_WIDE_FAMILY_WIDTH_FACTORS = {'arial black': (1.06, 1.25), 'verdana': (1.02, 1.08)}` (measured 2026-09-04) and `_MONOSPACE_ADVANCE_EM` (23 families, e.g. `consolas 0.55`, `dejavu sans mono 0.602`) with a name heuristic `mono(?!type)|(?<!uni)code|courier|consol|typewriter` → `0.60` default — `elements.py:2238-2300`. Rules that matter for a port: “Only factors ≥ 1 are listed — a narrower face wastes space, a wider one overflows the bounds” (`:2233-2234`), and monospaced glyph advances are *measured against published hmtx*, not scaled (`:2243-2249`).

The checker uses `include_headroom=True` for **module** containment and `include_headroom=False` for **page** containment (`checker.py:4858`, `:4882`, `:4914`) — module walls get the safety margin, the page edge gets the raw estimate.

### 3.5 Height and line handling

* Checker line box: `ascent = 0.85 em`, `descent = 0.35 em` ⇒ **1.20 em** per line (`checker.py:3484-3485`).
* Native text-frame height adds a `0.30 em` inter-line allowance: `ascent + descent + font_size * 0.30` ⇒ **1.50 em** (`elements.py:2112-2118`).
* Authoring lead is authored, not computed: positive `dy` per `<tspan>`, targets 1.2–2.0× by role (`P/references/shared-standards-core.md:184`).
* Multi-line carriers are resolved line-by-line (`_resolved_text_lines`, `_positioned_text_lines`, `_imported_model_text_lines` — `checker.py:3911-3957`, `:3582-3764`, `:3829-3910`) and unioned.
* A paragraph whose continuation `<tspan>` lines do **not** repeat the parent `x` warns: “continuation `<tspan>` lines repeat the parent x; a hanging indent needs its own `<text>`” (`checker.py:4927-4933`).
* Wrapping model used by `text_measure.py` (not by the checker): lexical units keep space-delimited words atomic, CJK clause breaks at `，。；：` are preferred only while they retain ≥ **75 %** of the greedy fill (`_PREFERRED_BREAK_MIN_FILL = 0.75`, `P/scripts/text_measure.py:51`), Japanese line-start prohibitions at `:39-46`.

---

## 4. Compaction steps, and why they matter downstream

Both compactors are **migration/diagnostic** tools, not standard post-processing: “New authoring code calls the tree-level implementation before its first write; the CLI is not a standard post-generation step” (`P/scripts/compact_svg_coordinates.py:5-7`, `compact_svg_styles.py:5-7`).

### 4.1 Coordinates — `compact_svg_coordinates.py`

* Scope is deliberately three attribute names only: `data-pptx-frame`, `data-pptx-bounds`, `transform` (`:42-50`).
* Rewrite: tokenize on `[\s,]+`, require every token to match a number regex (`:83-90`), then format each with at most **2 decimals**, strip trailing zeros and a bare `.`, normalize `-0`/`""` → `0` (`:93-101`). Quadruples keep 4 tokens (`:104-108`); transforms are rewritten per function — `translate` (1–2 args), `rotate` (center), `matrix` (**only `e/f`**), etc. (`:111-160`).
* **Never touched**: path/points geometry, normalized crop ratios, nested `viewBox` ratios, gradient offsets, opacity, scale arguments, rotation angles, matrix `a/b/c/d` — `P/scripts/docs/svg-pipeline.md:561-563`, guard rails visible in `:118-160`.
* `--keep-native-frames` compacts `data-pptx-bounds`, translation values, rotation centers and matrix `e/f` while preserving canonical authored-preset / inline native frames (`P/scripts/docs/svg-pipeline.md:553-556`).
* Stats: `native_frames / bounds / transforms / changed_attributes` (`:53-80`).
* Default run is a dry-run JSON report; `--inplace` atomically replaces only changed files (`P/scripts/docs/svg-pipeline.md:553-554`).

### 4.2 Styles — `compact_svg_styles.py`

* Inheritable attribute set is imported, not duplicated: `from svg_to_pptx.drawingml.utils import INHERITABLE_ATTRS` (`:37`, `:43`).
* Definition subtrees are excluded from promotion: `clipPath, defs, filter, linearGradient, marker, mask, pattern, radialGradient, symbol` (`:44-54`).
* Refusal guards: values containing `!important`/`var(`, CSS-wide keywords (`inherit/initial/revert/revert-layer/unset`), context-dependent values (`context-fill/context-stroke/currentcolor`) — `:55-71`.
* What it does (`P/scripts/docs/svg-pipeline.md:577-583`): when **every** rendered `<text>` has a resolvable typeface, the most common page `font-family` becomes **one root declaration**; descendants keep only true exceptions; any supported inheritable presentation attribute or inline declaration that exactly repeats its effective parent value is removed; it **never invents** a paint, size, or weight default.
* Stats fields name the transformations: `root_font_defaults`, `root_style_declarations_normalized`, `container_style_declarations_normalized`, `group_defaults_promoted`, `shadowed_attributes_removed`, `redundant_attributes_removed`, `redundant_style_declarations_removed` (`:80-98`).

### 4.3 Why the downstream converter cares

1. **The canonical-authoring gate** compares authored bytes against the compactor's output. `--canonical-authoring` reports drift; the flags above are the only sanctioned normalizers (`checker.py:2536-2542`).
2. **Fingerprint stability.** Native Chart/Table fallbacks are fingerprinted over their subtree; a style rewrite changes those bytes, so `stamp_native_fallbacks.py --write` must be re-run for pages carrying Chart/Table fallbacks (`P/scripts/docs/svg-pipeline.md:591-593`).
3. **Shared atoms.** Structured template rosters are deliberately *not* compacted per slide: “per-slide compaction would make shared Master/Layout atoms diverge and shift native fallback hashes” (`P/scripts/docs/svg-pipeline.md:594-596`). Compaction is therefore a page-local operation by construction.
4. **Export gate binding.** Because the release report carries a SHA-256 per file (`checker.py:10243-10276`), any byte rewrite invalidates the gate; the workflow order is compile → compact → re-stamp → re-gate.
5. **Why the *converter* reads coordinates at all**: the native shape path re-derives DrawingML `xfrm` from `data-pptx-frame` (exact four-part ordinary-decimal spelling required, `P/scripts/docs/svg-contract.md:284`); excess precision is a correctness hazard where a re-formatted frame can fail the exact-string check, not just a size issue.

### 4.4 Savings — what is actually quantified

The repo publishes **no byte-percentage**. What is countable from the code:

* coordinate compaction changes at most **3 attributes per element** and shortens each to ≤ 2 decimals with trailing zeros stripped (`compact_svg_coordinates.py:98-101`); `0.5000000000 → 0.5`, `-0.0 → 0`.
* style compaction removes exactly one declaration per exact-repeat occurrence, and collapses *N* per-text `font-family` declarations into **1** root declaration per page (`:80-86`).

Anything beyond that (e.g. “X % smaller files”) would be fabricated; the real motivation is gate determinism and converter correctness, not payload size.

---

## 5. Visual review loop

**Role**: optional, opt-in, per-page rubric review by subagents; never auto-invoked; only after the static checker passes and before `finalize_svg.py` / `svg_to_pptx.py` (`P/workflows/stages/visual-review.md:11`). Token cost is stated up front: “on the order of 100–150K additional input tokens for a 20-page deck at K=5” (`:13`).

**What is captured**: one PNG per page at the root viewBox size into `<project>/.preview/<page>.png`, rendered by Playwright/Chromium with icons inlined and images resolved; each record carries canvas + raster dimensions and `ok` / `all_background` flags (`:28-36`, `P/scripts/visual_review.py:5-13`). Cairo was evaluated and rejected because it has no fallback chain and renders CJK as tofu (`visual_review.py:10-12`). Exit codes: `0` all rendered, `2` live-preview server unreachable, `3` renderer missing, `4` per-page failures (`:19-24`). Blank-page detection quantizes each channel to 4 bits and fails only when one bucket holds ≥ **99 %** of pixels (`:53-56`, `:97-100`).

**Dispatch discipline**: only records with `ok: true`, `all_background: false`, and a complete canvas are dispatched; everything else becomes a `render_failed` row that blocks stage completion until retried or handed off (`P/workflows/stages/visual-review.md:36`).

**What the reviewer looks for** — the rubric is the single source of rules (`:69`):

* Hard, fixed in place: **H1** out-of-bounds, **H2** text overflow past its container, **H3** text-text bbox intersection (tspans excluded), **H4** contrast `< 4.5` small / `< 3.0` at ≥ 24 px or text on a complex image with no scrim, **H6** element collision violating z-order semantics, **H7** declared chrome covered/missing/off-canvas, **H8** broken `<image>`, **H9** missing spec-required element. Detection order: `H1 → H2 → H7`, `H3 → H6`, `H4`, `H8 → H9` (`P/references/visual-review.md:19-29`).
* Soft, only when clearly bad: **S1** baseline gap `< 1.05×`, **S2** `> 150 px` hollow whitespace, **S3** missed declared anchor, **S4** alignment drift `> 4 px`, **S5** grid spacing variance `> 5 %`, **S6** CJK tracking `> 5 %`, **S7** competing decorative accents, **S8** emphasis mismatch, **S9** image-text relationship, **S10** `breathing` page with a ≥ 3-card grid (`:41-50`).
* Never touch: brand tokens, layout structure, content, other files, non-atomic edits; font size may only move within the role anchor **± 2 px** (`:54`) — the same ±2 px that `FONT_SIZE_ANCHOR_TOLERANCE_PX` encodes statically (`checker.py:859`).

**Mapping findings back to fixes** (the “Permitted fix” column is the whole point): H2 → reduce font-size or break the line; H3 → reposition/resize; H4 → add a `<rect>` scrim, raise text to ≥ 24 px so the 3.0 threshold applies, or deepen an existing decoration gradient — but if either color is a brand token, **do not edit** and escalate to `.review/brand_review.json` (`:22`, `:31-33`); H6 → open spacing; H7 → restore only declared chrome; H8 → fix `href` / choose `meet` or a safer crop; H9 → recreate from spec.

**Loop mechanics**: default budget 1 iteration; Soft rules ≤ 2 fixes per iteration; a fix that introduces a new Hard hit is rolled back via `cp` from `.review/backup/<page>.iter<N>.svg` and the page becomes `needs_human`; clean exit = zero Hard hits and ≤ 1 Soft remaining (`:64-72`). Output is `| page | role | status | hard_hits | soft_hits | fixes_applied | needs_human_reason |` with status `ok | fixed | needs_human | render_failed | prereq_failed` (`P/workflows/stages/visual-review.md:57`).

---

## 6. Port plan to TypeScript for `dsh-ppt`

### 6.1 What `dsh-ppt` already provides

| Capability | Evidence |
|---|---|
| Real browser layout (`playwright-core 1.62.1`) | `E:/code/dsh-ppt/package.json:77`; `src/browser.ts:226-249` |
| Exact rects relative to slide origin | `src/browser.ts:62-67` (`SlideLeafBox`), `:74` (`SLIDE_SIZE = 1280×720`), `:76` (`FULL_BLEED_TOLERANCE_PX = 1`) |
| Off-slide detection, ±1 px | `src/browser.ts:237-239` |
| Real text-overflow detection | `src/browser.ts:246-248` (`scrollWidth > clientWidth + 1` / same for height) |
| Font allowlist + resolved-family readout | `src/browser.ts:240-245`, `:257-264`; font resolution/catalog `src/fonts.ts:139,264,324,446` |
| DOM parsing for non-rendered paths (`happy-dom 20.0.11`) | `package.json:76` |
| Raster probing (`sharp`) | `package.json:102`; used in `src/quality.ts:6` |
| Existing findings contract | `src/quality.ts:22-27` (`{ code, severity: 'warning'|'error', message, page? }`) |
| Occupancy/duplicate-layout heuristic | `src/browser.ts:88-101` |

Consequence: **`dsh-ppt` does not need the font-table estimator for anything it can render.** The Python estimator exists because the checker must predict DrawingML output without a browser; a TS port can measure the real DOM and keep the estimator only as a fallback for (a) very large decks where a page render is too expensive, (b) `happy-dom`-only offline runs, (c) parity tests.

### 6.2 Target module layout

```
src/svg-quality/
  contract.ts      // §1 checklist as data: allowed/forbidden elements & props, constants
  metrics.ts       // estimator port: clusterWidths, headroom, monospace, letter-spacing
  census.ts        // SVG → SvgCensus (happy-dom parse; playwright measure when available)
  rules/           // one file per rule family; each exports a Rule
  index.ts         // runSvgQuality(): orchestrates, classifies blocking/introduced, fingerprints
  report.ts        // schema 1:1 with checker.py:10192-10225 (minus template/receipt fields)
```

### 6.3 Per-check feasibility

Legend: **B** = better than Python (real measurement), **P** = parity port of the formula, **N** = needs new code, **—** = skip or defer.

| # | Check (Python owner) | Feasible | How in TS | Notes |
|---|---|---|---|---|
| 1 | viewBox canonicality + match (`checker.py:2576`) | **B** | `census.viewBox` from `SVGSVGElement.viewBox.baseVal`; compare to expected string | warn vs error split identical |
| 2 | forbidden elements/props (`svg_contracts.py:197`) | **B** | walk DOM once; set lookups from `contract.ts` | remove the regex-on-source path; DOM attribute names are authoritative (Python already prefers parsed names, `:206-210`) |
| 3 | geometry length grammar (`:730`) | **B** | `parseFloat` + explicit regex `^(?:\d+(?:\.\d+)?\|\.\d+)$` on raw attribute text | must read **raw attribute strings**, not `baseVal` (which coerces) |
| 4 | font-size form + DrawingML range (`:1060`) | **B** | same regex + `× 0.75` pt; range 1..4000 | reuse `FONT_PX_TO_HUNDREDTHS_PT = 75` semantics |
| 5 | text width vs container (module) (`checker.py:4777`) | **B** | `Range.getBoundingClientRect()` per `<text>`/line; compare to nearest ancestor with `data-pptx-bounds` | replaces the estimator entirely when Playwright is up; keeps ±1 px / 5 % policy |
| 6 | text vs page viewBox (`checker.py:4371`) | **B** | rect vs `0 0 W H`; always error | identical policy, exact geometry |
| 7 | module overlap > 1 px both axes (`:4747`) | **B** | pairwise rect intersection; `> 1` on **both** axes | O(n²) fine (n ≈ 6–12 per page) |
| 8 | missing `data-pptx-bounds` (`:4679`) | **P** | pure DOM predicate; error vs warning by page kind | trivial |
| 9 | text↔text overlap (H3) (`visual-review.md:22`) | **N** | rect intersection, excluding tspans of the same `<text>` | **new static rule**; currently rubric-only, browser-only |
| 10 | contrast ratio (H4) (`visual-review.md:22`) | **N** | `getComputedStyle(fill)` + nearest opaque background; WCAG `(L1+0.05)/(L2+0.05)`, thresholds 4.5 / 3.0 at ≥ 24 px | **net-new**; must resolve ancestor background stack and image-under-text (needs `sharp` sampling of the `.preview` PNG, as `quality.ts` already has sharp) |
| 11 | min font size | **N** | `parseFloat(computed.fontSize)` vs a deck-profile floor | deliberately *not* in Python (`shared-standards-core.md:246`); make it a **profile opt-in** with `caption`/`metadata` role exemption, not a universal floor |
| 12 | off-canvas shapes/images (`:4455`) | **B** | rect of every visible `rect|image|circle|ellipse|path` vs viewBox | Python only range-checks OOXML; DOM gives real bounds |
| 13 | image href resolution (`:5220`) | **P** | resolve against project root, `exists` check, allow `data:` | keep `image_sources.json` attribution as a project-level rule |
| 14 | image resolution ratios (`:866`) | **P** | `sharp().metadata()` vs frame size; > 2× upscale warn, > 4× downscale + ≥ 1 MB warn | sharp already a dep |
| 15 | preset geometry metadata (`:5475`) | **P** | reuse `data-pptx-*` validators; the registry lives in Python — port the registry or shell out | defer unless `dsh-ppt` emits preset groups |
| 16 | clip/marker/gradient/use contracts (`svg_contracts.py:631-729`) | **P** | DOM walks; ≤ 64-chain / ≤ 10 000-instance guards | port only if the TS authoring path emits these |
| 17 | spec_lock anchor drift (`checker.py:6690`) | **P** | markdown parse + ±2 px / sparse-3rd-occurrence rule | `dsh-ppt` has no `spec_lock.md`; keep for imported projects |
| 18 | fragmented paragraph heuristic (`:5002`) | **B** | needs baseline gaps and per-line x — DOM gives both directly | much lower false-positive risk than the Python heuristic |
| 19 | structure/slot contracts (`:9346`) | — | template-mode only | out of scope for a generate-only port |
| 20 | roundtrip text capacity (`:1646`) | — | import-edit path | out of scope |

### 6.4 Function signatures

```ts
// metrics.ts — parity port; only used when no browser is available
export interface TextRun {
  text: string
  fontSize: number            // px
  fontFamily?: string
  fontWeight?: 'normal' | 'bold' | number
  fontStyle?: 'normal' | 'italic'
  letterSpacing?: number      // px
  inlineDx?: number
}
export function clusterWidths(text: string, fontSize: number, opts: Pick<TextRun,'fontFamily'|'fontWeight'|'fontStyle'>): number[]
export function estimateLineWidth(runs: readonly TextRun[], opts: { includeHeadroom: boolean }): number
export function lineBox(fontSize: number, inlineFormula?: { ascentEm: number; descentEm: number }): { ascent: number; descent: number } // 0.85 / 0.35 em

// census.ts — measurement layer
export interface TextBox { id?: string; text: string; rect: Box; fontSize: number; anchor: 'start'|'middle'|'end'; container?: Box }
export interface SvgCensus {
  page: number
  viewBox: { x: number; y: number; width: number; height: number }
  modules: Array<{ id?: string; rect: Box; boundsAttr?: string }>
  texts: TextBox[]
  shapes: Array<{ kind: string; rect: Box; visible: boolean }>
  images: Array<{ href: string; rect: Box }>
  fonts: string[]
  measured: boolean            // false ⇒ rects came from metrics.ts, not the DOM
}
export function censusFromDom(svg: string, page: number): SvgCensus                 // happy-dom
export function censusInBrowser(runtime: BrowserRuntime, page: Page, pageNo: number): Promise<SvgCensus>  // playwright

// rules/index.ts
export interface RuleContext { census: SvgCensus; pageKind: 'final'|'reference'|'template'; profile: QualityProfile }
export interface Rule {
  id: string                                        // SVG101 …
  severity: 'error' | 'warning'
  category: 'geometry'|'text'|'paint'|'image'|'structure'|'readability'
  check(ctx: RuleContext): Finding[]
}
export function runSvgQuality(input: { pages: ReadonlyArray<{ page: number; svg: string }>; profile: QualityProfile }): Promise<SvgQualityReport>
```

`Finding` reuses `dsh-ppt`'s existing shape (`src/quality.ts:22-27`) so the SVG layer drops straight into `PptQualityReport.layers.automatic_visual.findings`.

### 6.5 Highest-value checks for catching broken slides

Ranked by “broken slide caught per unit of implementation”:

1. **Text overflow vs its container (SVG006)** — the single dominant failure of generated slides; the DOM path (`Range` rect + `scrollWidth`) is exact and needs no heuristics. Python spends ~600 lines (`checker.py:3501-4978`) on what the DOM answers directly.
2. **Text/geometry off-canvas (SVG008/SVG009)** — page-edge clipping is silent in every renderer; measured rects make it unambiguous.
3. **Overlap: text↔text (SVG011) and text↔shape (SVG012)** — currently only the rubric catches these; a static rect pass makes them free and deterministic.
4. **Contrast (SVG013)** — the only defect class no static check covers today; needs computed styles + a background stack, so it is the one genuinely new engine.
5. **Min font size (SVG014)** — trivially cheap, but must stay profile-scoped with role exemptions, matching the standards' explicit refusal of a universal floor.
6. **Image integrity + resolution (SVG015/SVG016)** — cheap, catches the “broken `<image>`” H8 class and wasted-bytes warnings.
7. **Module bounds presence/overlap (SVG007/SVG004)** — cheap and keeps parity with the upstream gate, but only matters if the TS pipeline emits `data-pptx-bounds`.
8. **Fragmented paragraph / bad line breaks (SVG017)** — high value for typography, lowest priority because a DOM pass can also simply *show* the wrong line breaks via the line-boxes it already collects.

### 6.6 Divergence risks in the port

* **Never trust `baseVal`** for grammar checks — it coerces `"12px"` and hides the very spelling the contract cares about (§1.5 item 35).
* **Text width policy must be copied exactly** if parity is required: ±1 px detection, 5 % warn/error with the exact-5 %-is-warning quirk (`checker.py:4338-4346`), headroom on module but not page.
* **CJK width**: a real browser uses the actual font; the Python model uses 1.00 em. Expect the estimator to be *wider* than reality for CJK — never the other way — so a port that switches to real measurement will clear pages the Python gate flagged. Treat that as an intentional relaxation, and gate it behind a profile flag.
* **`happy-dom` does not lay out.** Any rule run without Playwright must fall back to `metrics.ts`, and the report must say `measured: false` so consumers do not read an estimate as a measurement.
* **Compaction is not needed** in a DOM-authoring pipeline; the equivalent obligation is to emit canonical spellings at write time (unitless decimals, uppercase hex, no `px` suffix), which is cheaper than a post-hoc normalizer.

---

## 7. Ready-to-implement rule table

Severity follows the upstream policy: `error` blocks, `warning` is advisory (`P/scripts/docs/svg-pipeline.md:1234-1235`). `{…}` are format placeholders.

| Rule id | Description | Formula / threshold | Severity | Message template |
|---|---|---|---|---|
| SVG001 | Root viewBox missing or non-canonical | `viewBox` must parse as 4 finite numbers; `x,y = 0`; `W,H` positive integers | error (missing) / warning (non-canonical) | `Root viewBox {raw!r} is not canonical; write viewBox="0 0 {W} {H}".` |
| SVG002 | viewBox mismatches declared canvas | string compare against lock/format/first page | error | `viewBox mismatch: {source} requires '{expected}', got '{actual}'.` |
| SVG003 | Root transform present | `svg[transform]` exists | error | `Root <svg> must not carry a transform; move it to a child group.` |
| SVG004 | Forbidden element | tag ∈ {style, foreignObject, textPath, script, iframe, animate\*, set} | error | `Forbidden <{tag}> element: {reason}.` |
| SVG005 | Forbidden attribute/property | name ∈ {class, on\*, mask, mix-blend-mode, isolation, backdrop-filter}; or inline prop ∉ allowlist | error | `{element} uses unsupported {kind} {name!r}; native export would ignore it.` |
| SVG006 | Text overflows its container | measured text rect vs module rect; `> 1 px` on an axis triggers, ratio `> 5 %` ⇒ error | warn ≤5 % / error >5 % | `{text} exceeds {container} on the {axis} axis: content ({l},{t})-({r},{b}), container ({cl},{ct})-({cr},{cb}), overflow {h%}/{v%} (error above 5%); {repair}.` |
| SVG007 | Text overflows the page | text rect vs `0 0 W H`, `> 1 px` | error | `{text} exceeds the root viewBox on the {axis} axis: …; move or reflow the text until its estimated bounds stay on-page.` |
| SVG008 | Shape/image outside the page | shape rect vs viewBox, `> 1 px` | error | `{element} lies outside the root viewBox ({l},{t})-({r},{b}); move or clip it into the canvas.` |
| SVG009 | Negative size / radius | `width,height,r,rx,ry,stroke-width < 0` | error | `{element} {attr}={value} must be non-negative.` |
| SVG010 | Module bounds missing | visible direct-root `<g>` without `data-pptx-bounds`, excluding compact preset atoms | error (final/template) / warning (reference) | `Detected {n} visible root-level <g> module(s) without explicit data-pptx-bounds ({sample}); every final-page root <g> declares its layout subcanvas.` |
| SVG011 | Module overlap | intersection `> 1 px` on **both** axes | error | `{a} data-pptx-bounds overlaps {b} data-pptx-bounds by {w}px x {h}px; keep module zones disjoint beyond the 1px tolerance.` |
| SVG012 | Text↔text overlap | rect intersection area `> 0` after excluding tspans of the same `<text>` and `opacity: 0`/`display:none` | warning | `{a} overlaps {b} by {w}px x {h}px; reposition or resize so distinct text blocks do not collide.` |
| SVG013 | Text↔opaque shape collision | text rect ⊂ shape rect on ≥ 60 % of the text area, shape painted after the text in document order | warning | `{text} is covered by {shape} (z-order); move the shape behind the text or off the text block.` |
| SVG014 | Contrast too low | `(Lmax+0.05)/(Lmin+0.05) < 4.5`, or `< 3.0` when `font-size ≥ 24 px` | warning | `Text {text} has contrast {ratio}:1 against {bg}; raise it above {4.5\|3.0}:1 or add a scrim.` |
| SVG015 | Font size below profile floor | `fontSize < profile.minFontPx` (default 0 = off); exempt roles `caption`, `metadata` | warning | `{text} uses {size}px, below the {floor}px floor for role {role}; enlarge, shorten, or split the block.` |
| SVG016 | Font not in the delivery allowlist | resolved family ∉ profile.fonts | error | `{element} uses unauthorized font {family}; export needs an installed or approved face.` |
| SVG017 | `font-size` form invalid | not `^(?:\d+(?:\.\d+)?\|\.\d+)$`; or outside 1..4000 pt (`×0.75`) | error | `Unsupported font-size value(s): {values}. Use a finite positive unitless px value inside 1..4000pt.` |
| SVG018 | Geometry length form invalid | unit ∉ {"", px}; expression/`calc`/`var`/`%`/scientific/leading `+` | error | `{element} {attr}={raw!r} is not a finite unitless decimal; write {attr}="{value}".` |
| SVG019 | Non-canonical paint spelling | `rgba()`, lowercase hex, `transparent` | warning | `{element} {prop}={raw!r} is converter-compatible; generated SVG should prefer {prop}="{canonical}" so the authoring gate stays clean.` |
| SVG020 | `!important` in inline style | substring match | error | `{element} inline property {name!r} cannot use !important.` |
| SVG021 | Unpaired channel opacity | `fill-opacity` without `fill`, etc. | error | `{element} declares {alpha} without a matching {color} on the same element.` |
| SVG022 | Broken image reference | `href` missing, or relative target does not resolve | error | `Image {href!r} in {element} does not resolve under the project root.` |
| SVG023 | Image upscaled | `framePx / intrinsicPx > 2.0` | warning | `{href} is upscaled {ratio}× ({w}×{h} px into {fw}×{fh}); supply a larger source or shrink the frame.` |
| SVG024 | Image downsampled wastefully | ratio `> 4.0` **and** intrinsic ≥ 1 MiB | warning | `{href} is downsampled {ratio}× from {bytes} bytes; recompress or crop to the display size.` |
| SVG025 | Unknown/duplicate definition id | duplicate `id` in the document, or `url(#id)` with no target | error | `Definition id {id!r} is {duplicate\|unresolved}; each conditional definition needs one unique target.` |
| SVG026 | `<use>` chain too deep / too many | chain `> 64`, or `> 10 000` `<use>` in one file | error | `Local <use> expansion exceeds the {64-instance chain \| 10 000-instance} limit.` |
| SVG027 | Marker outside the 5 native shapes | shape ∉ {triangle, stealth, arrow, diamond, oval} | error | `Marker {id!r} has no native line-end mapping; use a 3/4-vertex polygon, an open 3-vertex path, or a circle/ellipse.` |
| SVG028 | Paragraph split across sibling `<text>` | baseline gap ratio ∈ [0.9, 2.05], same x within 0.5 px, ≥ 12 total chars, ≥ 8 in the longest line, no terminator/list marker | warning | `{a} and {b} read as one paragraph split across sibling <text> elements; use positioned <tspan> lines inside one <text>.` |
| SVG029 | Continuation tspan does not repeat parent x | `abs(tspan.x - text.x) > 0.5` | warning | `{text} continuation lines must repeat the parent x; a hanging indent needs its own <text>.` |
| SVG030 | Sibling root group has no stable id | visible direct-root `<g>` with empty/missing `id` | warning | `{element} is an anonymous top-level group; give it a descriptive, page-unique id so animation and trace anchors stay stable.` |
| SVG031 | Blank render | dominant 4-bit color bucket ≥ 99 % of pixels | error | `Page {n} rendered essentially blank ({share}% one color); check <use> references and image assets.` |
| SVG032 | Declared chrome displaced | declared page-number/header/footer rect intersects another module or exits the canvas | warning | `Declared {chrome} is {covered\|missing\|off-canvas}; restore only that declared chrome.` |

---

## Appendix A — constants index

| Constant | Value | Owner |
|---|---|---|
| `COORDINATE_DECIMAL_PLACES` | `2` | `P/scripts/compact_svg_coordinates.py:38` |
| `FONT_PX_TO_HUNDREDTHS_PT` | `75` | `dml_utils.py:46` |
| `_TEXT_WIDTH_HEADROOM_BASE / CAPS` | `1.06 / 1.12` | `elements.py:2066-2067` |
| `_SERIF_TEXT_WIDTH_HEADROOM_BASE / CAPS` | `1.12 / 1.36` | `elements.py:2068-2069` |
| `_MONOSPACE_DEFAULT_ADVANCE_EM` | `0.60` | `elements.py:2287` |
| `_TEXTBOX_PADDING_MIN/MAX_PX`, `_RATIO` | `0.5 / 2.0 / 0.04` | `elements.py:2051-2053` |
| line ascent / descent | `0.85 / 0.35 em` | `checker.py:3484-3485` |
| native frame height allowance | `+0.30 em` | `elements.py:2118` |
| `FONT_SIZE_ANCHOR_TOLERANCE_PX` | `2.0` px | `checker.py:859` |
| `SPARSE_UNDECLARED_FONT_SIZE_MAX_OCCURRENCES` | `2` | `checker.py:860` |
| `IMAGE_UPSCALE/DOWNSIZE` | `2.0 / 4.0`, min `1 MiB` | `checker.py:866-868` |
| `<use>` limits | `64` chain, `10 000` per file | `P/scripts/docs/svg-contract.md:132` |
| EMU per px | `9 525` | `P/scripts/svg_to_pptx/canvas_contract.py:61` |
| contrast thresholds | `4.5` / `3.0` @ ≥ 24 px | `P/references/visual-review.md:22` |
| blank-render threshold | `0.99` | `P/scripts/visual_review.py:56` |

## Appendix B — where to read more

| Topic | File |
|---|---|
| Canonical surface (model-facing form) | `P/references/shared-standards-core.md` |
| Closed grammar + mapping tables (machine) | `P/scripts/docs/svg-contract.md` |
| Effects vocabulary, elevation tiers, scrim recipes | `P/references/svg-effects.md` |
| Marker vocabulary | `P/references/semantic-svg.md` |
| Pipeline/gate/export contract | `P/scripts/docs/svg-pipeline.md` |
| Review rubric (H1–H9, S1–S10) | `P/references/visual-review.md` |
| Prompt-corpus budget lint | `P/scripts/docs/prompt_audit.md` |

> `prompt_audit.md` is maintainer-only and not part of the SVG gate: it lints the agent-facing Markdown corpus (token budgets per load set, registry projections, duplicate adjudication) and is “intentionally not wired into CI or pre-commit hooks” (`P/scripts/docs/prompt_audit.md:3`, `:20-32`). It matters for a port only as a reminder that every new reference doc needs a declared load set (`:38`).
