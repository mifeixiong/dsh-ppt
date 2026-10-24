# ppt-master 深读报告：PPTX→SVG 往返、模板工作区、图像/图标资产管线

- 目标仓库：`E:\code\_recon\ppt-master`（GitHub `hugohe3/ppt-master`），只读分析，未修改任何文件。
- 快照：`78fcef9b065ee4d6f588c320f3bb7f5712d1f794`（2026-10-24）。
- 引用约定：`scripts/` = `skills/ppt-master/scripts/`，`wf/` = `skills/ppt-master/workflows/`，`ref/` = `skills/ppt-master/references/`，`tpl/` = `skills/ppt-master/templates/`。行号均为该快照下的实际行号。
- 阅读范围：`scripts/pptx_to_svg.py` + `scripts/pptx_to_svg/*.py`（22 模块）、`authoring_roundtrip.py`、`pptx_intake.py`、`pptx_workspace.py`、`apply_template.py`、`pptx_template_import.py`、`mirror_template_materialize.py`、`beautify_inventory.py`、`beautify_identity.py`、`icon_sync.py`、`analyze_images.py`、`image_gen.py`、`image_search.py`、`image_treat.py`、`wf/edit-native-pptx.md`、`wf/create-template.md`、`wf/create-template/*.md`、`wf/profiles/beautify-pptx.md`、`wf/profiles/image-to-pptx.md`、`wf/stages/apply-template-workspace.md`、`wf/stages/web-image-review.md`、`scripts/docs/{conversion,template-tools,svg-pipeline}.md`、`tpl/README.md`、`tpl/icons/README.md`、`ref/pptx-structure-interface.md`。为对照第 6/7 节，另查了本机 `E:\code\dsh-ppt`（`@yejiming/dsh-ppt` 0.1.0）的 `src/{ir,pptx,themes,tools,quality,ppt-image}.ts` 与 `package.json`。

---

## 1. PPTX → SVG：抽取了什么，保真如何判定，哪些表达不了

### 1.1 入口与三种视图模式

CLI 是 `scripts/pptx_to_svg.py`，核心 API 是 `convert_pptx_to_svg(pkg, output_dir, ConvertOptions)`（`scripts/pptx_to_svg/converter.py:482`）。参数很克制（CLI 共 8 个开关）：`--images-subdir`、`--sounds-subdir`、`--embed-images`、`--keep-hidden`、`--inheritance-mode {both,layered,flat}`、`--strict`、`--roundtrip`（`scripts/pptx_to_svg.py:88-148`）。模块 docstring 明确写了设计立场：这是 `svg_to_pptx.py` 的语义对偶，"reads OOXML directly and emits declared SVG/native-marker subsets **without claiming an arbitrary lossless PPTX round trip**"（`scripts/pptx_to_svg.py:30-32`）。

三种继承视图（`converter.py:521-522` 的 `emit_layered/emit_flat`）：

| 模式 | 产物 | 用途 |
|---|---|---|
| `layered` | `svg/master_*.svg`、`svg/layout_*.svg`、`svg/slide_NN.svg` + `svg/inheritance.json` | 模板作者看"哪些是共享、哪些是本页独有" |
| `flat` | 每页自包含的 `svg/slide_NN.svg`（把可见的 Master/Layout 非占位形状内联） | 预览、截图、与 `svg_to_pptx` 的往返保真 |
| `both`（默认） | 两套都出 | `--roundtrip` **强制要求** `both`，因为"editable flat authoring view and layered source backing are both complete"（`converter.py:504-508`） |

`--roundtrip` 还强制 `images_subdir=images`、`sound_subdir=sounds`、禁止 `--embed-images`（`converter.py:509-517`），并把输出写进固定语义路径（见 1.10）。

### 1.2 包与继承：先建关系图，再逐页解析

`OoxmlPackage`（`scripts/pptx_to_svg/ooxml_loader.py:208`）用 `zipfile` 直读 part，`PartRef`/`SlideRef` 保存 xml + rels + 父链（`ooxml_loader.py:117-143`）。`_rels` 解析在 `ooxml_loader.py:55`，part 路径规范化在 `:30`。关键继承事实是三条：

1. `part_show_master_sp(part)` 读该 part 的 `p:cSld@showMasterSp`（`ooxml_loader.py:161`）；
2. `inherited_shape_visibility(slide)` 把"Slide→Layout→Master"的可见性拆成两级：Layout 形状看 Slide 的 flag，Master 形状要 Slide 与 Layout **两个** flag 同时为真（`ooxml_loader.py:170`）；
3. 背景是独立平面，不参与 `showMasterSp`（`slide_to_svg.py:2254` 的 `_emit_background` / `:2293` 的 `_emit_part_background`；文档同步在 `scripts/docs/template-tools.md:21`）。

占位符继承是重点工程。`shape_walker.walk_sp_tree` 在进入每个 `spTree` 前先构建三张表：`_build_placeholder_xfrm_table`（Layout→Master 的几何回填）、`_build_placeholder_lst_style_table`（`lstStyle` 文本级别样式）、`_build_placeholder_body_property_table`（`bodyPr`），并通过 `_placeholder_identity` 用 `(type, idx)` 归一化占位身份（`scripts/pptx_to_svg/shape_walker.py:357-560`）。`ShapeNode` 携带 `placeholder`、`inherited_lst_styles`、`inherited_body_properties`、`effective_rotation`（`shape_walker.py:64-83`）。这样"slide 上的空占位符没有 `a:xfrm`"这一最常见的 PPTX 写法不会丢几何。

`shape_walker.py:1-15` 列出识别对象：`p:sp` / `p:pic` / `p:cxnSp` / `p:grpSp`（递归，解析 `a:chOff`/`a:chExt` 帧）/ `p:graphicFrame`（表/图/SmartArt）/ `mc:AlternateContent`（取支持的 Choice，保留 baked Fallback 预览）。

### 1.3 主题：颜色走 `clrMap` + `clrScheme`，字体走 major/minor + EA/CS + CJK 脚本

`ColorPalette` 是唯一颜色权威（`scripts/pptx_to_svg/color_resolver.py:220-264`）：先读 `theme1.xml` 的 `a:themeElements/a:clrScheme`（严格模式要求 12 个槽位、顺序、无未知属性，`color_resolver.py:302-340`），再读 master 的 `p:clrMap` 把 `bg1/tx1/bg2/tx2` 重映射到 `lt1/dk1/...`，并提供 `SCHEME_ALIASES`（`color_resolver.py:101-118`）。解析 6 种颜色类型（`srgbClr/schemeClr/sysClr/prstClr/hslClr/scrgbClr`）+ 修饰符（lum/sat/hue/alpha/gray/complement/inverse），输出 `(#RRGGBB, alpha)`（`color_resolver.py:1-9`、`:461` 的 `resolve_color`）。内置 190 条 `ST_PresetColorVal` 表（`:27-97`）。严格结构失败时**降级但不猜**：清空 scheme、记录 `theme-color-scheme-normalized` 诊断，再走 `_load_scheme_compatible`（`:240-264`、`:270`）。

字体摘要在 `converter._extract_theme_info`：`a:clrScheme` 每个槽位解析成 hex（`converter.py:148-167`）；`a:fontScheme` 的 `majorFont/minorFont` 分别取 `a:latin`、`a:ea`、`a:cs`，再取 `a:font@script` 中 `Hans/Hant/Jpan/Hang` 四种 CJK 脚本（`converter.py:169-191`，脚本集合在 `:95`）。输出键形如 `majorLatin`、`minorEastAsia`、`minorScriptHans`。每个 master 单独算一份 `master_themes[master.path] = {themePath, colors, fonts}`（`converter.py:575-589`），转换为 `flat` 视图时同页两次渲染会各自取自己 master 的 palette（`converter.py:595-658`）。主题原文还被 base64 进报告：`sourceDocument.theme.ooxml = {encoding, sha256, payload}`（`converter.py:1808-1813`）——这点对"只读 theme 做 dsh-ppt 主题"很有用：一个字段就拿到完整 `theme1.xml` 字节。

### 1.4 几何：数据驱动的 preset 目录 + 公式求值 + custGeom + 组变换

- `prstGeom`：不硬编码形状表，而是走共享的 `pptx_shapes` 注册表（`presetShapeDefinitions.xml` + `presetShapeSemantics.json`，`scripts/pptx_shapes/data/`）。`convert_prst_geom` 产出 `GeomResult{tag, attrs|path_d, layers, preset metadata}`，并在 SVG 上带"rendering-neutral"的 preset 名与 `a:avLst` 公式元数据，让反向转换不必从外观猜（`scripts/pptx_to_svg/prstgeom_to_svg.py:1-12`、`:71`）。**目录外的 preset 落到显式标记的 bounding-box fallback，绝不伪装成 `rect`**（同 docstring 第 7-8 行）。
- `custGeom`：`moveTo/lnTo/cubicBezTo/quadBezTo/arcTo/close` → `M/L/C/Q/A/Z`；`a:path@w/h` 定义形状局部坐标系，公式先在局部求值再投影到绝对帧（`scripts/pptx_to_svg/custgeom_to_svg.py:1-14`、`:36`、`:74-146`）。`arcTo` 是 center+sweep 角 → SVG endpoint 参数化（`:6-8`）。
- 组：`_adjust_for_group(child_xfrm, group_xfrm)` 用 `chOff/chExt` 做仿射补偿（`shape_walker.py:147`）；`_convert_group` 输出 `<g transform>`（`slide_to_svg.py:1708`）；`effective_rotation` 单独保留祖先旋转，避免效果判定时二次施加（`shape_walker.py:79-81`）。
- 连接符：`CONNECTOR_PRESET_TYPES` + `_convert_connector`（`slide_to_svg.py:1691`），线端箭头由 `ln_to_svg._build_arrow_marker` 生成 `<marker>`（`ln_to_svg.py:373`）。
- 单位：`EMU_PER_PX = 9525`（96 dpi），字号"百分之一磅"，角度 1/60000 度，百分比 1/100000（`scripts/pptx_to_svg/emu_units.py:5-23`）。画布取 `pkg.slide_size_px` 并用 `format_canvas_px_from_emu` 生成带精度的 `width/height/viewBox`（`slide_to_svg.py:274-277`、`:327-335`）。

### 1.5 文本：insets/anchor/wrap、项目符号、竖排、autofit、换行重排、公式

`convert_txbody`（`scripts/pptx_to_svg/txbody_to_svg.py:126`）的处理序列：解析段落/run → `_apply_norm_autofit` → 读 `lIns/tIns/rIns/bIns/anchor/wrap/vertOverflow`（`:157-175`）。几个易被忽略但决定观感的点：

- **autofit 只复现"PowerPoint 已经算好的结果"**：`_apply_norm_autofit` 读 `a:normAutofit@fontScale` 与 `@lnSpcReduction`（1/100000），直接缩放 run 字号与行高（`txbody_to_svg.py:802-829`）；`spAutoFit`（框随文长）与 `noAutofit` 只出现在"已知合法子元素"集合里（`slide_to_svg.py:784`），并不做版面重算。
- **换行是自己重排的**：`_wrap_paragraph_into_lines` 用 `_char_width`/`_advance_width` 估算 CJK 与拉丁字宽后按 `max_width` 断行（`txbody_to_svg.py:1339-1499`、`:1410`），而不是信任源文件的视觉行。于是"文本是否溢出"由估算器决定，这也是后面质量门用同一套指标的原因。
- `wrap="none"` 给 `+inf` 宽度、`_should_keep_single_line` 走快路径（`:1499`）；`vertOverflow=clip/ellipsis` 才裁切，默认按 DrawingML 语义"溢出仍显示"（`txbody_to_svg.py:170-180`、`:213-251`）。
- 竖排：`is_vertical_txbody` + `convert_vertical_txbody`，含东亚 upright/sideways 分段与 `_rotated_bbox`（`txbody_to_svg.py:262-560`）。
- 项目符号：`_resolve_bullet_prefix` 支持 `buAutoNum` 的 arabic/alpha/roman（`:1255-1305`），并把 bullet 作为首个 run 前缀参与排版（`:1427-1445`）。
- 字体栈：`_resolve_theme_typeface` 按 `lang`/文本内容推断 theme script（`Hans/Hant/Jpan/Hang`），`_build_font_stack(latin, ea, cs)` 生成 CSS 回退链（`:1090-1205`）。
- 公式：OMML → LaTeX JSON + 线性 SVG 预览；`import_formula` 只接受编译器闭合词表，颜色只归一化 `m:r/a:rPr` 与 `m:ctrlPr/a:rPr` 的直接 `solidFill`（`scripts/pptx_to_svg/formula_import.py:100`、`:154`，文档 `scripts/docs/conversion.md:377-435`）。

### 1.6 填充、描边、效果

`resolve_fill` 分派 `noFill/solidFill/gradFill/blipFill/pattFill`（`scripts/pptx_to_svg/fill_to_svg.py:79`）。渐变是重点：校验 `lin`/`path` 结构、`scaled`、`rotWithShape`、`tileRect`、`fillToRect`、焦点、stop 位置与颜色，非规范结构**显式报错而不是猜**（`fill_to_svg.py:410-645`）；`pattFill` 需要前景/背景两色并用 `_hex_distance` 近似出图案（`:654-847`）。`resolve_stroke` 处理宽度/虚线/端点/箭头与退化渐变投影（`ln_to_svg.py:75`、`:301`）。`convert_effects` 只支持 `outerShdw` 与 `glow`，其余效果写成 `data-pptx-effect-*` 元数据 + 诊断（`scripts/pptx_to_svg/effect_to_svg.py:71-112`、`:322-430`）。

### 1.7 图片

`pic_to_svg` 的策略写得很清楚（`scripts/pptx_to_svg/pic_to_svg.py:1-28`）：优先 `asvg:svgBlip` 的 SVG 关系，`a:blip` 的位图只作兼容预览回退；无 `srcRect` 时输出一个 `preserveAspectRatio="none"` 的 `<image>`；有 `srcRect`（或单张超大 tile 覆盖帧）时用嵌套 `<svg viewBox="0 0 1 1">` + `overflow:hidden` 表达裁剪，使浏览器与 PowerPoint 语义一致；**重复平铺仍走旧的纯图片回退**，因为原生图片裁剪子集表达不了重复图案。实现细节：`_single_cover_tile_crop`（`:397`）、`_apply_blip_image_effects`（alpha/亮度/对比度，`:523`）、`_normalize_office_media` 与 `_convert_office_vector_to_png`（EMF/WMF 借本地工具链转 PNG，`:334-374`）、`_sniff_mime` 与 `_build_href`（外部文件 vs base64，`:639-666`）。`_is_valid_svg_media` 会拒绝伪 SVG（`:325`）。

### 1.8 图表与表格：JSON 权威 + 预览，而非像素

`chart_to_svg.extract_native_chart_payload`（`scripts/pptx_to_svg/chart_to_svg.py:58`）从 `c:chart` 解析出**规范化数据对象**（类别/系列/轴/样式/标签/组合/股票/散点气泡/ChartEx 的 treemap、sunburst、histogram、pareto、box-whisker、waterfall、funnel），语义校验函数极多（`_validate_chart_semantics:1860`、`_validate_plot_series_identifiers:1248`、`_validate_stock_semantics:471` 等）。表格走 `tbl_to_svg.convert_tbl`（`scripts/pptx_to_svg/tbl_to_svg.py:279`），做物理行列拓扑校验、规范矩形合并、单元格边框/填充/富文本 run 子集校验（`_canonical_native_merge_status:637`、`_table_has_unsupported_style:716`）。

输出形态是"预览 + 声明"：`<g data-pptx-replace-with="chart|table" data-pptx-native-authority="json">` 内嵌 `<metadata type="application/json">` 权威载荷（`scripts/docs/conversion.md:439-460`）。无法表达时按三级降级：`data-pptx-fallback-kind="normalized"`（确定性可读重绘）→ `"placeholder"`（占位框，`slide_to_svg.py:2202` 的 `_render_graphic_preview`、`:1767` 的 `_convert_graphic_fallback`）→ 诊断。CLI 对 placeholder 单独告警并提示 `--native-charts-and-tables` 才能重建（`scripts/pptx_to_svg.py:217-232`）。

### 1.9 附带的三个 sidecar

1. `animations.json`：`{version:1, defaults:{transition:{effect:"none",duration:0}}, slides:{}}`，每页可含 `transition` 与 `animation`（`converter.py:285-296`、`:1867-1886`）。写入前用 `validate_transition_config` + `validate_animation_config_errors` 校验，不合法直接抛错而不是产出坏 sidecar。
2. `notes/slide_NN.md`：`import_speaker_notes` 抽讲稿（`scripts/pptx_to_svg/notes_import.py`），`converter.py:1571` 落地；非 roundtrip 还写 `notes/total.md`（`converter.py:1831-1838`）。
3. `validation/conversion-report.json`：稳定字段 `schemaVersion/source/mode/summary/artifacts/sourceDocument/diagnostics`（`converter.py:1847-1858`，文档 `scripts/docs/conversion.md:320-327`），`mode` 只有 `strict|tolerant`。

### 1.10 保真如何判定：四道门 + 一套诊断码

1. **结构化诊断计数**：`ImportDiagnostic{code,message,fallback,part_path,slide_index,shape_id,shape_name,shape_kind,severity}`（`scripts/pptx_to_svg/import_diagnostics.py:7-30`）。`append_diagnostic` 去重，使 layered/flat 双视图不重复计数（`:33-40`）。`summary.warnings = len(diagnostics)`（`converter.py:1851-1854`）。健康样本的验收是个硬断言：`report['summary'] == {'slides':1,'warnings':0}`（`scripts/docs/conversion.md:576-582`）。
2. **strict vs tolerant 是唯一"保真档位"**：tolerant 的恢复顺序被写死为"先省属性 → 再换对象为可见诊断占位 → 背景可丢、页面不丢；ZIP/XML 损坏与必需结构缺失仍然致命"（`scripts/docs/conversion.md:309-318`）。`--strict` 只用于解析器开发与契约验证。
3. **几何/文本容量门**：`svg_quality_checker.py --roundtrip --json` 用共享字体族/字号/文本宽度/画布指标，只对"新增或被改的 source-ref 对象"施加水平容量检查；超出最近的 `data-pptx-frame`（导入）或 `data-pptx-bounds`（自撰）即 blocking（`scripts/docs/svg-pipeline.md:253-262`）。
4. **交付体检与回读**：`pptx_delivery_check.py` 只读包、报 OPC 完整性、可移植性、媒体体积、隐藏页、是否有动效（`scripts/pptx_delivery_check.py:1-11`、`:727` 的 `audit_pptx_delivery`）；再配合 `source_to_md/ppt_to_md.py` 回读出页文本、标题、讲稿数（`wf/edit-native-pptx.md:161`）。

### 1.11 明确表达不了的东西（有代码/文档依据）

- **任意无损往返**：模块自述即否定（`scripts/pptx_to_svg.py:30-32`）。
- **动画/切换的"其它时序"**：只重建"当前生成注册表 + 有限行为树"的子集，203 个效果里 199 个可精确反向，4 个（`emphasis_change_font`、`emphasis_change_font_style`、`emphasis_transparency`、`emphasis_bold_reveal`）因调度跨度不可分而永远诊断；repeat/reverse/rewind、acceleration/bounce、after-effects、动画音效、段落/图表/SmartArt build 全部 `animation-not-reconstructed`（`scripts/docs/conversion.md:357-375`）。切换不认识的 effect、legacy `p:transition@spd`、`advClick="0"` 等一律诊断，且"绝不拿 fade 顶替"（`:351-355`）。
- **SmartArt / 复杂效果 / 媒体帧**：保留为原子代理 `<image data-pptx-source-proxy="native-restore">`，可留可删不可编辑（`wf/edit-native-pptx.md:52`）。
- **表格样式族**：只保证 `{5C22544A-...}` 这一内置样式族的 `wholeTbl/firstRow/band1H/band2H` + 主题色/字体 + 直接覆盖子集（`scripts/docs/conversion.md:504-507`）；其它样式族、非规范合并、非纯色填充、结构换行/域/制表符/项目符号等只能回退成形状。
- **公式**：不是通用 Office Math 转换器，只还原"规范化语义读回"，不还原作者原始 LaTeX 拼写，丢失无意义空白（`:419-435`）。
- **图片**：重复平铺、部分 blip 效果（艺术效果、裁剪外的几何）落到旧回退或诊断；外部链接图缺失直接失败（`scripts/docs/template-tools.md:26`）。
- 其它：不建模 `spAutoFit` 重排、不做竖排之外的复杂文种排版、`--roundtrip` 下不允许改画布尺寸、不允许增删 Master/Layout（`wf/edit-native-pptx.md:175`）。

### 1.12 工作区布局（`--roundtrip`）

路径常量集中在 `scripts/pptx_workspace.py:33-51`，CLI docstring 给出全貌（`scripts/pptx_to_svg.py:11-28`）：

```text
<out>/
  authoring-svg-flat/            # 唯一可编辑的 SVG 页源（+ authoring_summary.json / authoring_manifest.json）
  icons/imported/                # 按需的复杂矢量装饰（data-icon="imported/<name>"）
  authoring-svg-flat_vector_asset_inventory.json
  animations.json                # 归一化切换/对象动效
  images/                        # 位图 / SVG / EMF / WMF，含 images/source-object-previews/
  sounds/ audio/ video/          # 语义媒体
  notes/                         # 导入讲稿
  native-payloads/               # 不透明原生载荷（od 关系）
  analysis/                      # native_structure.json、roundtrip_manifest.json、roundtrip-svg/{layered,flat}
  validation/conversion-report.json
  sources/source.pptx            # byte-identical 源包
```

写盘不是"边算边写"，而是**先 stage 后原子发布**：`_write_artifacts` 在目标父目录建 `.name.convert-XXXX` 临时树，`publish_staged_workspace` 再叠合与清理被管理路径（`converter.py:1770-1790`、`:1239`、`:924` 的 `_managed_svg_paths`、`:1175`）。`reject_removed_workspace_layout` 会拒绝旧版布局（`pptx_workspace.py:44-51` 列出被移除条目）。`roundtrip_manifest.json` 的 `directories` 明确声明每个子目录语义（`converter.py:1745-1758`）。

---

## 2. 往返编辑模型：不变页如何原样保留，改动页如何重撰，`--roundtrip` 如何合并/打补丁

### 2.1 三层产物

1. `sources/source.pptx`：不可变源包（`pptx_workspace.py:33`）。
2. `analysis/roundtrip-svg/{layered,flat}/slide_NN.svg` + `master_*/layout_*`：不可变"lossless"分层背板（`pptx_workspace.py:41-43`；`converter.py:1672-1696` 写 hash）。
3. `authoring-svg-flat/`：**唯一可编辑页源**，投影得更紧凑，带 `data-pptx-source-ref` 与代理（`wf/edit-native-pptx.md:44-48`）。

`roundtrip_manifest.json` 每页记录 `sourcePart/layoutPart/masterPart/layeredSvg(+sha256)/flatSvg(+sha256)/animationSha256/narrationAudio`，并把非媒体派生的本地引用、`materialized` 资源路径分开列（`converter.py:1662-1701`）。`_annotate_roundtrip_slide_roots` 把 `data-pptx-layout/-master/-layout-name/-master-name/-show-master-shapes/-show-inherited-shapes` 六个属性插进 SVG 根标签（`converter.py:389-453`），这是反向导出认回 Layout/Master 的唯一凭据。

### 2.2 未改页：passthrough / cloned_passthrough（"byte-for-byte" 的真实含义）

导出端把每页归为四类，凭据是 `svg_to_pptx/pptx_package/cli.py:3089-3105`：

- `passthrough`：identity 页且无 `page_plan.json`，直接复用源 slide part 的原始 XML；
- `cloned_passthrough`：有 plan 但该页被"引用"（未改），在 clone 出来的 part 上复用；
- `patched`：保留 source shape XML，只有顺序/讲稿/切换/动效/旁白时序变化；
- `rebuilt`：可见的自撰内容变了，或它引用的 materialized 资源字节变了。

因此"byte-for-byte"精确指**形状 XML 级别的原样复用**，不是整包字节相等：页序、关系 id、以及叠加层（notes/timing）可以变而不触碰形状。clone 的独立性在 `scripts/pptx_ooxml/clone.py:1-25` 说明：克隆会递归复制每一页的**私有**依赖（tags、per-slide theme override、SmartArt 图），但**故意共享** layout/master/theme/notesMaster 与 `ppt/media/` blob。

`wf/edit-native-pptx.md:157` 给了这个模型的语义边界："`rebuilt` = §4.3 标记为 edited 的页 + 引用了变更资源的页；**纯交付任务必须显示 `rebuilt=0`**"。

### 2.3 改动页：重撰 → 基线对比 → 未变对象原生还原

`authoring_roundtrip.materialize_flat_authoring_roundtrip`（`scripts/authoring_roundtrip.py:2136`）是编辑后的"落地器"，流程六步：

1. **载入并用指纹绑定**：`roundtrip_source_fingerprint` 对 `authoring-svg-flat/*.svg` + `page_plan.json` 做聚合 sha256（`authoring_roundtrip.py:97-117`）；质量门也复用它，所以"校验后改文件"会让导出收据变成 `quality_gate=stale`（`scripts/docs/svg-pipeline.md:275` 附近）。
2. **校验清单契约**：`authoring_manifest.json` 必须 `schema=AUTHORING_SCHEMA`、`projection_kind=flat`、`authoring_root="."`、`source_ref_attribute` 正确（`:333-350`），`source_root` 必须落在 workspace 内且等于 roundtrip manifest 的 `flatSvg` 目录（`:351-416`）。
3. **重算基线（baseline）**：把源背板 SVG 再投影一次到 flat 形式，得到"若你什么都没改应该长这样"的树（`:920` `_generate_baseline_bundle`）。并且**先证明基线自身可信**：重新抽取的矢量资产 key 集合必须与 inventory 完全一致（`:2191-2198`），source-ref 闭包必须与 manifest 完全一致（`:1782-1789`），不能有重复 ref（`:1790-1797`），source-proxy 名册必须一致（`:1798-1813`）。
4. **按对象判"改没改"**：对每页算 `normalized_authoring_subtree_sha256(current_root, current_assets)` 与基线同值相比（`:1754-1760`），页级一致则该页整体未改；页级不一致则在对象级用 `authoring_source_ref_is_unchanged` / `normalized_authoring_subtree_sha256`（`:1012`、`:1168`）判定。**未变对象恢复原始 round-trip 元数据**（含文本 `txBody` 原样、原生占位 restore、效果元数据）、**变化对象按普通 SVG 转换**但保留 shape id（`wf/edit-native-pptx.md:107`；`authoring_roundtrip.py:1632` 的 `_restore_unchanged_text_body`、`:1668` 的 `_native_restore_placeholder`、`:1522` 的 `_restore_preserved_effect_metadata`）。
5. **defs 合并**：`_definition_changes` 判 `defs` 是否变，`_merge_defs` 合并、`_prune_unreferenced_definitions` 剪掉没被引用的（`:1301`、`:1421`、`:1371`），避免每次编辑都累积死 defs。
6. **写出并校验名册**：输出目录必须为空（`:2156-2159`），落地后页数必须等于 plan 页数（`:2220-2223`），最后产 `ppt-master.authoring-roundtrip-materialization.v1` 报告，含 `totals{source_ref_count, unchanged_refs, edited_refs, deleted_refs, authored_unreferenced, expanded_vector_uses}`（`:2224-2259`）。

### 2.4 `--roundtrip` 的合并/补丁语义

`page_plan.json`（`schema=ppt-master.roundtrip-page-plan.v1`）是唯一的"输出名册"：`pages[]` 每项只有 `{source_slide, svg?}`，是**完整非空输出顺序**；`svg` 省略即用该源的 `slide_NN.svg`（`wf/edit-native-pptx.md:62-76`）。它带来三个后果：

- **引用/重排/重复/省略**都不改形状：不出现的源页被丢弃，仅它独占的 audio/video/不透明载荷会丢并打提示（`wf/edit-native-pptx.md:76`）。
- **合并页只能"选骨架 + adopt 对象"**：一个输出页有且只有一个 `source_slide`；跨页取对象必须 `svg_authoring_view.py --adopt-object`，因为 source-ref 是页内局部的；adopt 会把对象"实体化"（继承呈现属性与祖先变换），**丢失原生身份**并把该页变 `rebuilt`（`:78`）。
- **新页也要骨架**：复制最接近的源页、换名、登记同一个 `source_slide`、清空 Slide-local 内容再写（`:84`）。

补丁本身不是文本 diff，而是"每页一份 `RoundtripSlidePatch`"：`visual_changed` 决定 `patched` / `rebuilt`（`cli.py:3094-3100`）。`_discard_rebuilt_shape_links` 会在 clone 阶段清掉被重建形状指向源的链接（`scripts/pptx_ooxml/clone.py:651`），防止 patch 后出现"形状已换、关系还指向旧 part"的僵尸引用。

### 2.5 校验的不变量（含 `rebuilt=0`）

| 不变量 | 位置 | 失败表现 |
|---|---|---|
| 每页必须被四类之一分类，且总数吻合：`direct+cloned+patched+rebuilt == len(roundtrip_pages)` | `cli.py:3099-3112` | 报 "summary could not classify every output page" 并返回 1 |
| 交付型任务 `rebuilt=0` | `wf/edit-native-pptx.md:157,159` | 视为契约违背（第二轮的交付轮目标） |
| 质量门指纹未过期 | `scripts/docs/svg-pipeline.md:275` | 收据 `quality_gate=stale` |
| 被引页不得被写：`passthrough|cloned_passthrough|patched`，绝不 `rebuilt` | `wf/edit-native-pptx.md:107` | 收据桶与计划不符 |
| source-proxy 原子：可留可删、不可编辑，外链图代理不可删，继承来的必须留 | `wf/edit-native-pptx.md:52` | 导出失败 |
| 未知/重复 source-ref、proxy 名册漂移、基线资产 key 漂移 | `authoring_roundtrip.py:1782-1827`、`:2191-2198` | `AuthoringRoundtripError` |
| 同页跳转目标必须恰好出现一次（被省略/重复则失败，并列出全部页） | `authoring_roundtrip.py:1740-1753` | 报包含目标页号的错误 |
| 被删除对象若仍是源动效 target，必须显式覆盖该页动效 | `wf/edit-native-pptx.md:141` | "Edited slide removed source animation target(s)" |
| 源页独占的 video/audio/不透明载荷不得被 plan 丢掉 | `cli.py:3049-3083` | 列出 output page 与 part，返回 1 |
| 生成页名册必须等于 plan | `authoring_roundtrip.py:2220-2223` | 报名册不匹配 |

### 2.6 讲稿 / 时序 / 切换：叠加层，不碰 slide

- **讲稿**：`notes/<输出 SVG stem>.md`。规范页有文件即替换源讲稿，删文件即移除；复制页若无自有文件则继承源讲稿（`wf/edit-native-pptx.md:137`）。硬规则"只写口语"：导出时去 Markdown 标记、`notes_to_audio.py` 跳过标题行但逐字朗读其余，所以 `[tag]`、时长行会被念出来（同段）。
- **旁白**：`audio/<stem>.*`，`--recorded-narration audio --use-narration-timings` 才写入自动前进；`notes_to_audio.py` 从 `page_plan.json` 解析名册，复制页继承（`:139`）。
- **切换**：`-t <effect> [--transition-duration]` 是全局替换；逐页用 `animations.json` 行覆盖；行里省略 `transition` 就保留源切换（`:151`、`:141`）。`--roundtrip` 导出默认读工作区 `animations.json`，删掉它会让导出失败而不是"恢复源动效"（`scripts/docs/svg-pipeline.md:227`）。
- **对象动效**：`-a <preset>`（默认 `none`）只管新对象策略；`animations.json` 行按输出 stem 键控（`wf/edit-native-pptx.md:141`）。
- 这些叠加发生在 OOXML 生成阶段（`svg_to_pptx/pptx_package` 写 `p:transition` / `p:timing` / notesSlide），**只要 `visual_changed=false`，页就停在 `patched`**，形状 XML 不动。

### 2.7 边界

支持：引用/选择/重排/重复/省略不变页；改文本、涂装、图片、原生表格单元格、图表数据（图表/表格须 `--native-charts-and-tables`）；以规范紧凑 SVG 新增元素；把 SmartArt/复杂效果/嵌入媒体留成原子代理；讲稿/旁白/自动前进/切换/动效作为叠加层。不支持：在复制页上删除继承的源讲稿（要给副本自己的文件）、编辑 source proxy、改画布尺寸、给已有 PPTX 增补 Master/Layout（`wf/edit-native-pptx.md:175`）。

---

## 3. 模板工作区格式：磁盘契约、选择/确认、安装、对设计的约束

### 3.1 四种 kind，各自拥有不同"段"

`tpl/README.md:7-12` 给出正交定义：Brand 拥有 identity（色/字/logo/voice/icon 风格）、Style 拥有 direction/method（沟通方法、视觉语言、构图节奏）、Layout 拥有 brand-neutral structure（画布、Master/Layout 图、页型、slot、SVG 名册）、Deck 拥有"应用场景 + 集成 identity + 结构"。**它们是并列 kind，不是继承层级**；PowerPoint 包对象只是编译目标（`tpl/README.md:14`）。

### 3.2 磁盘契约与命名硬规则

```text
<template_workspace>/
├── templates/            # Design Spec；Layout/Deck 另放 SVG 名册与 native_payloads.json.gz
├── images/               # 可选位图；SVG href 用 ../images/<name>
├── icons/imported/       # 可选导入矢量，唯一副本，data-icon="imported/<name>"
└── exports/              # 可选评审证据，永不作为模板输入
```

"容器消歧、文件名载其余"（`tpl/README.md:40`）：library root 保留 `templates/design_spec.md`（kind/id 由 `<kind_dir>/<template_id>/` 表达）；project root 用扁平 `templates/` 并每 kind 一个 `design_spec.<kind>.<id>.md`，文件名里的 kind/id 必须等于 frontmatter 的 `kind` / `<kind>_id`；两种形态**不混用**；一个 `templates/` 只持有一个 active roster（Layout 存在时优先于 Deck，但两份 spec 可共存）。空的可选目录不创建，`exports/` 一律忽略（`tpl/README.md:40`）。选根目录即选中它暴露的所有 kind（`wf/stages/apply-template-workspace.md:18`）。

### 3.3 Spec 的 frontmatter schema 与正文骨架

Deck（`wf/create-template/create-deck.md:25-51`）：

```yaml
deck_id: <slug>      kind: deck      category: brand|general|scenario|government|special
summary: <一行应用家族+结果>          keywords: [3-5 tags]
primary_color: "#XXXXXX"
canvas_format: ppt169   canvas_width: 1280   canvas_height: 720   canvas_viewbox: "0 0 1280 720"
replication_mode: standard|fidelity|mirror      native_structure_mode: structured
page_count: <N>
```

正文固定章节 `I. Template Overview / II. Color Scheme / III. Typography / IV. Signature Design Elements / V. Page Roster / VI. Assets / VII. Placeholder Overrides`，条件省略规则写在同一文件（`:53`）。Layout 只有结构相关的 `IV/V/VII`（`wf/create-template/create-layout.md:40-48`）。Brand 是 identity schema（`I. Brand Overview / II. Color Scheme / III. Typography / IV. Logo / V. Voice & Tone / VI. Icon Style / VII. Visual Assets`，`wf/create-template/create-brand.md:46-90`）。Style 只 `style_id/kind/summary/keywords` + `I..VII` 方法学正文（`wf/create-template/create-style.md:40-88`）。

`replication_mode` 是**机器溯源**字段，来自自然语言意图，绝不作为用户选项（`tpl/README.md:24`、`wf/create-template.md:188`）。禁止写 `template_id`/`output_scope`/`target_project` 这类泛化键（`wf/create-template.md:188`）。

### 3.4 索引是发现权威

四个索引文件 `tpl/{brands,styles,layouts,decks}/*_index.json` 是**唯一发现来源**，README 只写散文不枚举模板（`scripts/register_template.py:1-45`）。条目 schema：brand `{summary, primary_color}`；style `{summary, keywords[]}`；layout `{summary, canvas_format, page_count, page_types[]}`；deck `{summary, canvas_format, page_count, primary_color}`（同处）。`register_template.py` 从 `design_spec.md` frontmatter（优先）或散文兜底 + 实际 `templates/*.svg` 名册派生条目，`--rebuild-all` 修索引漂移，`--dry-run` 只校验身份与路径（`scripts/docs/template-tools.md:135-142`）。Brand/Style 工程内工作区不注册，只用 `svg_quality_checker.py <workspace>/templates --template-mode` 校验（`register_template.py:40-45`）。

### 3.5 结构载荷契约（Layout/Deck 的 SVG 名册）

每个模板 SVG 都是"已解析 Master+Layout+Slide 上下文的完整 Slide 原型"，standalone 的 Master/Layout 定义 SVG 无效（`ref/pptx-structure-interface.md:32`；`wf/stages/apply-template-workspace.md:81`）。`ref/pptx-structure-interface.md:34-57` 列全了必须/可选元数据：

| 元数据 | 位置 | 语义 |
|---|---|---|
| `data-pptx-master` / `-name` | 根 `<svg>` | 绑定生成的 Master key 与选择器名 |
| `data-pptx-layout` / `-name` | 根 `<svg>` | 绑定 Layout key 与选择器名 |
| `data-pptx-show-master-shapes` | 根 | 该 Layout 的 `showMasterSp`，同 key 的所有页必须一致 |
| `data-pptx-show-inherited-shapes` | 根 | 该 Slide 的 `showMasterSp` |
| `data-pptx-layer="master|layout|slide"` | 直接语义原子 | 归属；普通 `<g>` 禁用，唯一例外是校验过的紧凑 preset `<g>` |
| `data-pptx-placeholder` + `data-pptx-bounds` + `data-pptx-idx` | slot `<g>` | 可复用槽；bounds 是"设计区"正数帧、≤2 位小数 |
| `data-pptx-carrier="true"` | slot 的直接子元素 | 真正成为 Slide 占位载体 |
| `data-pptx-binding="proxy"` | 复合 object slot | 建隐藏透明绑定代理 |
| `data-pptx-editable="false"` | master/layout 元素或 slide 背景 | 显式声明"有意在普通编辑面之外" |

硬规则：结构化路线上每个 SVG 必须带四个根身份属性；Master/Layout 原子与 slot 必须是**直接根子元素**且有唯一稳定 `id`；`id` 只标识元素，**归属由 `data-pptx-layer` 决定**（`ref/pptx-structure-interface.md:59`）。绘制顺序 = PowerPoint 绘制顺序（Master 背景 → Layout 背景 → Slide 背景 → 其余 Master 原子 → 其余 Layout 原子 → slot 与 Slide-local），只有"直接的全画布纯色 `<rect>`"能拥有 scoped 背景（`:61-63`）。slot bounds 必须来自设计区/栅格/safe area，**不得来自文本长度或字形宽度**（`:65`），并且"bounds 是容量不是留白配额"（`:67`）。

### 3.6 选择 → 确认 → 安装

1. **选择**：Generate Step 4 Stage 1 确认"至少一个精确模板工作区"；label 只有 `library`（等于索引派生的 `templates/<kind_dir>/<id>/`）与 `explicit`（用户/上游给的未注册精确根），label 只影响发现溯源（`wf/stages/apply-template-workspace.md:20-25`）。原始 PPTX **不是**模板工作区（`:29`）。
2. **确认后安装**：`apply_template.py <project> --root R1 [--root R2 ...] [--dry-run] [--skip-validation]`（`wf/stages/apply-template-workspace.md:71-75`）。它"不选择任何东西"，只做安装半场。
3. **安装内容**：每 kind 最多一根、可四种共存（`:27`）；先在各根上跑 `svg_quality_checker.py --template-mode --canonical-authoring`（`:44-48`）；解析结构 owner（Layout 优先，否则 Deck）；把每个 spec 映射到 `<project>/templates/design_spec.<kind>.<id>.md`，并在 H1 下**恰好插一行** `> **Installed from**: \`<root>\` (library|explicit)`（`:56-62`）；owner 的 SVG 名册与非位图结构文件、每个根的 `images/` 与 `icons/` 各拷一次；拒绝重复 kind、重复根、目标已存在且字节不同（`:77`；工具文档 `scripts/docs/template-tools.md:123-133`）。
4. **原子性与收据**：先在目标文件系统 stage 完整 `templates/images/icons` 树，校验每个映射文件与最终集合，再用目录 rename 发布；失败回滚先前所有 rename（含被移除的 Deck 文件与旧收据）。成功后写 `<project>/template_install.json`：`project`、`roots`（根/标签/kinds/spec 身份/源 sha256）、`installed_specs`、`active_roster`、`files`（相对路径→sha256）、`selection_sha256`（绑定 UI 的 Stage-1 快照；无 UI 则 `null`），若存在 `confirm_ui/template_selection.json` 则根的字节必须与它一致（`scripts/docs/template-tools.md:129-133`）。**"一行 provenance 文本不够"，Confirm UI 会校验这份机器收据**（同处）。
5. **边界**：安装后所有角色只读 `<project>/templates/` 与 project-local `images/`/`icons/`；库根只是安装输入（`wf/stages/apply-template-workspace.md:79`）。

### 3.7 模板感知如何约束设计

段优先级在读取时解析，而不是安装时合并（`wf/stages/apply-template-workspace.md:83-104`）：Identity：Brand → Deck → 待定；Structure：Layout → Deck → free design（Style 不拥有画布/原型/结构）；Application context：仅 Deck；Direction：Style。**"拥有的段治理视觉权重，不只治理取值"**——Style 的留白倾向不能把 Brand 的主色降级为点缀（`:96`）。

工程化约束在 lock 层：`spec_lock.md` 必须声明 `pptx_structure.mode: structured`、唯一 `pptx_masters`、显式注册的 `pptx_layouts` 名册、每页唯一 `page_pptx_layouts`，Master/Layout 行形如 `<key>: <master> | <picker name> | <prototype source>`；一个 Layout key 只属一个 Master 且全局唯一；结构化路线必须有数字型 `title`/`body` 字号行作为 Master 文本样式（`ref/pptx-structure-interface.md:30`）。`template_reuse_scope: strict|adaptive|mirror` 决定"严格保留原型契约 / 只在允许范围内实现 Layout 且不改复用 key / 保留已验证源身份"（`:32`）。`page_layouts` 选的是完整原型，`template:<basename>` 指向已安装 spec（`:30`）。Strategy 侧只允许"用原型 + 记录导出值"，不允许反向修改已确认的 Stage 1（`ref/strategist-template.md:15,37`）。

---

## 4. 资产管线

### 4.1 图标库契约

- **规模与命名**：`tpl/icons/` 共 12,027 个 SVG，五库：`chunk-filled`(641, 0 0 16 16)、`tabler-filled`(1,055)、`tabler-outline`(5,138)、`phosphor-duotone`(1,518, 0 0 256 256)、`simple-icons`(3,675 品牌 logo)（`tpl/icons/README.md:7-11`）。**没有全量索引 JSON**：目录即索引，`tpl/icons/tabler-outline/` 实为 5,138 个 `.svg` 文件；检索靠文件名 glob（`tpl/icons/README.md:35-40`）。
- **引用语法**：`<use data-icon="<library>/<name>" x y width height fill/>`，`data-icon` 是 `<library>/<文件名去 .svg>`，**大小写敏感**（它在解析真实文件）；裸名、缩写命名空间、`templates/icons/` 路径、未同步的库文件一律失败而不是回退（`:26-31`）。规范化建议 32–48px @1280 宽画布并按画布宽缩放（同处）。
- **同步语义**：`icon_sync.py <project> <lib/name> ...` 把全局库拷进 `<project>/icons/<lib>/`（`shutil.copy2`，`scripts/icon_sync.py:68-91`）；缺失名**先于导出**非零退出（`:129-146`）；项目里已有同名视为"已满足"（支持自撰 `custom/` 图标，`:86-88`）。一批里混用两个"文体库"直接报错，`simple-icons` 可与人共存（`:116-127`；库集合定义 `:38-44`）。
- **"一库原则"**：一个 deck 至多一个主文体库，缺某个图标时在库内换更近的对象，而不是换库；`simple-icons` 不算文体库，只在需要真实品牌/产品标识时准备（`tpl/icons/README.md:44-46`）。
- **导入矢量**：`create-template` 保留 `imported/` 命名空间，唯一副本在 `<workspace>/icons/imported/`，以 `data-icon="imported/<name>"` 引用，不得复制到 `templates/` 下当手编库（`tpl/icons/README.md:21`；导入时由装饰抽取自动生成并带 `data-pptx-asset-role="decoration"`，`scripts/docs/template-tools.md:27`）。
- **落地**：`finalize_svg.py`（`--only embed-icons`）在所有占位符处内联，预览、校验与原生导出都只解析这个 project pool（`tpl/icons/README.md:21,31`；实现 `scripts/svg_finalize/embed_icons.py`）。
- **检索硬规则**：按"可绘制对象"检索而非抽象概念（`idea`/`growth`/`warning` 多数库没有），基名跨库不可移植（`alert-*` vs `warning-*`、`arrow-trend-*` vs `trending-*`），不得加载全量索引或枚举大族（`tpl/icons/README.md:42`）。

### 4.2 AI 生图 manifest 契约

CLI：`image_gen.py "prompt" [--aspect_ratio 16:9 --image_size 1K -o images/]`、`--reference-image`（编辑模式）、`--manifest project/images/image_prompts.json`、`--list-backends`（`scripts/image_gen.py:49-55`）。后端由 `IMAGE_BACKEND` 选择，内置 14 个（gemini/openai/minimax/stability/bfl/ideogram/qwen/zhipu/volcengine/tencent/modelscope/siliconflow/fal/replicate/openrouter），配置源优先级为"进程环境 > .env（cwd → skill → repo → ~/.ppt-master）"（`scripts/image_gen.py:5-45`）。

Manifest schema（`scripts/image_gen.py:588-597`）：顶层 `{"items":[...]}`，可选 `project`/`generated_at`/`deck_rendering`/`color_scheme`/legacy `deck_style_anchor`；每项**必需** `filename`、`prompt`、`aspect_ratio`、`status`，可选 `image_size`、`model`、`alt_text`、`purpose`、`type`、`page_role`、`text_policy`、`slice_grid`、`slice_names`、`last_error`。枚举被硬校验：`aspect_ratio` ∈ 21 个值、`image_size` ∈ `512px/1K/2K/4K`、`status` ∈ `pending/generated/failed/needs_manual`、`page_role` ∈ `local/hero_page/full_page`、`text_policy` ∈ `none/embedded`（`:97-104`、`:532-536`、`:655-712`）。`image_size` 经 `normalize_image_size` 归一后再比对，避免大小写/别名漏检（`:686-691`）。`status` 可重试集合 `{pending, failed}`（`:533`）。manifest 还会被渲染成人类可读的 `_manifest.md`（`render_manifest_md`，`:1148`）；`_run_manifest` 负责并发、失败落 `failed/needs_manual` 并回写 manifest，路径用 `_materialize_manifest_image` 原子落盘（`:878`、`:901`）。`_guard_confirmed_non_api_path` 在已确认的图像获取路径为非 API 时拒绝跑 API 后端（`:485`）。

### 4.3 网络图搜契约与审核门

`image_search.py` 是"许可优先"的检索器：默认向每个 provider 要 `all` 允许匹配（CC0/PD/Pexels/Pixabay/CC BY/CC BY-SA），按分数选可下载者，并记录是否需署名；`--strict-no-attribution` 只要 no-attribution 且找不到就失败（`scripts/image_search.py:1-26`）。provider 注册表：openverse / wikimedia / pexels / pixabay（`:88-93`）。

两种模式：
- **best-only**：直接下原图到 `--output`，并向 `image_sources.json` 追加一条记录——它是下游渲染署名的**唯一真相源**（`write_sources_manifest`，`:1441`）；
- **thumbnail shortlist**：只存缩略图与 `candidates.json`，等人工/视觉审核后用 `--promote` 再下原图（`promote_candidate`，`:1515`）。

质量与安全护栏都在代码里：`_validate_downloaded_quality`（尺寸/有效性）、`_fit_pixel_budget`（像素预算）、对多帧 JPEG 归一化、对 Pillow 解压炸弹错误单独识别、`_dedupe_ranked_candidates` 去重（`:384-540`、`:805-831`）。

**审核门**是独立 stage：`--save-candidates` 产出 `Needs-Selection` 行之后、任何 `--promote` 之前，派**一个**reviewer 处理当前批次全部待审页（`wf/stages/web-image-review.md:13-16`）。审核契约是 5 道有序门：①只接受 `no-attribution|attribution-required`，拒绝不可读预览/尺寸不够；②确认主体/身份；③按锁定意图查方向、焦点、裁切安全、可用安静区；④查视角/动作/情绪；⑤在通过的候选里优先"更低预期裁切损失 + 更高可用分辨率 + 不需署名"（`:29-35`）。硬规则"不做最不坏"：没有一个候选过全门就返回 `no-pass`，不得放宽锁定的 Reference/Crop Policy（`:39`）。回执是一张 ≤200 词的表，`selected` 只能指向本页候选之一；owner 校验文件名后 `--promote` 并核对原图尺寸与 provenance；`no-pass` 先翻下一页，再换查询（`:45-53`）。

### 4.4 图像处理与体检

- `image_treat.py` 生成**非破坏性 PNG 派生**，保留显示尺寸、alpha 掩膜与匹配的 web provenance；固定顺序：brightness → contrast → tone（desaturate/grayscale/duotone）→ Gaussian blur → `--fit` 降采样（`scripts/image_treat.py:1-17`）。它拒绝覆盖已存在的输出（`_assert_output_absent:201`、`_assert_manifest_output_absent:484`），并在 provenance 里重写署名文本（`:428-440`）。
- `analyze_images.py` 只报客观参数（尺寸、比例分类、透明像素、`image_manifest.json` 的显示比例/使用次数），产出 `analysis/image_analysis.csv`，**不解析画布也不给版式建议**（`scripts/analyze_images.py:1-14`、`:224`、`:388`）。
- `slice_images.py` 负责 contact sheet 切分（`--grid/--names/--trim/--alpha`），image-to-pptx 用它切"layer plate"（`wf/profiles/image-to-pptx.md:80`）。

---

## 5. Beautify 档：1:1 约束、保留什么、身份如何被核验

**定位**：`beautify-pptx` 是 Generate 的一个 profile（不是独立 route），保留**内容**、重做**版式**：文本逐字、源调色板/字体作为"预选建议"、版式/层级/留白/视觉处理重新做成一个原生新 deck——不是给原件打补丁（`wf/profiles/beautify-pptx.md:7`）。与 `edit-native-pptx` 正好互为反向：后者保留原生设计改内容，前者保留内容改设计（`:21`）。

**1:1 硬约束**：

1. **内容冻结**：每条源文本字符串精确保留（不增/不删/不改写/不重排）；自由度只在版式、层级、间距、节奏；run 级强调（源加粗/上色的词）属于要保留的层级，用有效调色板重绘（`:19`）。
2. **不加源没有的页 chrome**：页码、页脚、running head 都不加（`:19`）。
3. **页数/页序 1:1**：每个源 slide 恰好一页、顺序一致；§IX 必须逐字 1:1（`:133`、`:146`）。
4. **不搬运、只重绘视觉**：图表/表格/图片从数据重建，绝不按字节拼接；数据值冻结，只有渲染属于新 deck（`:51`）。
5. **与 image-to-pptx 互斥**（`:21`、`wf/profiles/image-to-pptx.md:29`）。

**保留什么**：`sources/<stem>.md`（每源页一块、顺序）是冻结内容契约；`images/` + `image_manifest.json`（`occurrences[].slide_index`）绑定图；`beautify_inventory.json` 是逐页账本：`text_blocks`、`tables`、`charts`、`diagrams`（SmartArt 节点+层级+源布局）、`images`（含 geometry 与 `usage_count`），并机械预置空 `ignored` 与 `needs_confirmation` 供人判断（`:47`、`:62-70`）。读取必须**有界**：先 `--summary`，再 `--page N`，只在结构歧义时 `--with-geometry`（`:70`）。

**身份如何被核验**：

- `beautify_identity.py`（纯读，`scripts/beautify_identity.py:11-13`）输出 `{source, slide_count, canvas{width_px,height_px,aspect}, theme{palette{background,background_alt,text,text_alt,hyperlink,accent1..6,primary}, fonts{title,body{latin,ea,cs}}, sizes{title,body,body_levels...}}, observed{colors,fonts,sizes_pt}, layout_sizes_pt}`（`:213-262`）。`primary` 直接取 `accent1`（`:237-238`）；字体对含 `a:latin/ea/cs` 与 CJK 脚本补充面（`:49-71`）。
- 画布先据 `canvas.aspect` 定 `ppt169`/`ppt43`/精确 px，保证 1:1 与回贴对齐（`wf/profiles/beautify-pptx.md:35`）。
- **theme vs observed 的取舍被显式摆到用户面前**（`:94`），并且 `theme.sizes.body` 是一级占位默认值，常"读大"，必须与页面实际正文块交叉验证（`:49`、`:129`）。
- **`body_size` 是最容易错的一环**：从 `observed.sizes_pt` 的主频值 `× 4/3` 转 px（20pt→26.67），再按画布宽/`canvas.width_px` 缩放；**不要第二遍换算，不要 `body_size_pt`**（`:129`）。seed 链：observed → theme.sizes.body → 消费模式基线（text 20 / balanced 24 / presentation 32 px）（同段）。
- 输出核验：`beautify_inventory.py <inventory> --verify <export.pptx>` —— 每条冻结字符串（段落、表格单元、图表类别与系列名、SmartArt 节点）都必须以"去空白包含"出现在**它自己那一页**，并打印"源中不存在的字符数"（非零=加了文本，profile 禁止）；任一缺失即退出 1（`:147`；实现 `scripts/beautify_inventory.py:270-301`、`:234` 的 `_frozen_strings`）。另外还查：页数等于源、图表/表格是有效调色板下的原生 SVG、文本与形状使用有效色/字（`:147`）。
- `pptx_delivery_check.py` 提供包级体检（OPC 完整性、媒体体积、隐藏页、动效），beautify 的交付检查复用它（`scripts/pptx_delivery_check.py:1-11`）。

**v1 天花板（文档自己写明）**：拥挤页只能在页内改善（不做信息减压，需人工拆页）；回贴只保证确认过的调色板+字体声明，不保证坐标对齐或字体可用；combo/双轴/瀑布图与合并单元格表格是"尽力而为"并需标注（`wf/profiles/beautify-pptx.md:100`）。范围外：翻页重排、批量/多 deck 美化、把图表/表格/图片按字节搬运（`:160-162`）。

---

## 6. 对 dsh-ppt 可行的子集（TypeScript，pptxgenjs + fflate + happy-dom + playwright）

先对齐 dsh-ppt 现状（`E:\code\dsh-ppt`，`@yejiming/dsh-ppt` 0.1.0）：依赖 `fflate 0.8.3`、`pptxgenjs 4.0.1`、`happy-dom 20.0.11`、`playwright-core 1.62.1`、`sharp`、`fontkit`、`zod`（`package.json`）。管线是 `HTML(happy-dom) → ElementIR → pptxgenjs`，再对产出的 pptx 做 **fflate 解压/改写/重压**（`src/pptx.ts:4,157`、`src/transitions.ts`、`src/animation.ts`、`src/quality.ts:105`）。已有 `ppt_themes`（内建 12 主题目录，`src/themes.ts:28-75`、`src/tools.ts:617`）、`ppt_create`（`src/tools.ts:1081`）、`ppt_image`（`src/tools.ts:1172`）。**没有任何 PPTX 导入/主题提取能力**：`inspectPptxPackage` 只数页、读 slideSize、列 entries（`src/pptx.ts:157`）。

### 6.1 价值/成本排序

| 排序 | 能力 | 价值 | 成本 | 说明 |
|---|---|---|---|---|
| 1 | (c) 模板工作区 JSON → dsh-ppt 主题 | 高（补上"无主题即从零设计"的短板） | 低（纯 JSON + zod schema） | 复用 `PptTheme` 形状即可落地，无需新 OOXML 解析 |
| 2 | (a) PPTX 主题/intake 读取器 → brand palette+fonts JSON | 高（客户品牌自动进主题） | 中低（1 个 XML part + 2 个可选） | `theme1.xml` 解析 ~200 行 TS |
| 3 | (d) 图标包 | 中高（版式填充/装饰词汇） | 中（索引 + 同步 + resolver） | 目录即索引；只需 manifest + 内联 |
| 4 | (b) PPTX→HTML/SVG 页导入用于重撰 | 最高价值但成本最高 | 高（1.5k+ 行等价逻辑） | 只做"扁平页快照 + 可编辑文本层"子集 |

### 6.2 (a) PPTX 主题/intake 读取器 → 可直接当 dsh-ppt theme 的 JSON

**输出目标形状**（对齐 `src/themes.ts:28-75`）：

```ts
type BrandTheme = {
  id: string; name: string; concept: string; scenes: string[];
  palette_source: string;                       // "pptx:<file>!ppt/theme/theme1.xml#<name>"
  palette: { background: string[]; surface: string[]; accent: string;
             accent_inverted: string; text: string[] };
  typography: { display: {family:string;weight:number}; body: ...; latin: ...; code: ... };
  composition_cycle: string[]; background_cycle: string[];
  rhythm_limits: { max_grouped_frame_slides: number; max_same_composition_run: number };
  decoration: string[]; layout_notes: Record<string,string>;
}
```

**必读 part**

| part | 读什么 | 映射 |
|---|---|---|
| `ppt/theme/theme1.xml` | `a:themeElements/a:clrScheme/{dk1,lt1,dk2,lt2,accent1..6,hlink,folHlink}` 的 `srgbClr@val` 或 `sysClr@lastClr` | `lt1→palette.background[0]`、`dk1→text[0]`、`dk2→text[1]`、`lt2→surface[0]`、`accent1→palette.accent`、`accent2..6→surface[]/accent_inverted` 候选 |
| 同上 | `a:fontScheme/a:majorFont|minorFont` 的 `a:latin/@typeface`、`a:ea`、`a:cs`、`a:font[@script='Hans'|'Hant'|'Jpan'|'Hang']` | `display.family=major.latin`（有 CJK 正文时优先 `major.ea`/`Hans`）、`body.family=minor.*`、`latin.family=major.latin`、`code` 留默认 |
| `ppt/presentation.xml` | `p:sldSz@cx/@cy` | 画布：`12192000×6858000 → 1280×720`（与 dsh-ppt 常量一致，`src/ir.ts:1-5`） |
| `ppt/slideMasters/slideMaster1.xml`（可选） | `p:clrMap`、`p:txStyles/p:titleStyle|bodyStyle` 的 `a:lvl1pPr/a:defRPr@sz` | `clrMap` 把 `bg1/tx1` 映射到 `lt1/dk1`（**必须**，否则浅色主题全反）；`sz` 给 `typography` 权重与字号锚点 |
| `ppt/slides/slide*.xml`（可选，统计） | `a:solidFill/a:srgbClr@val` 频次、`a:rPr@sz` 频次 | `observed` 修正：当主题与实际使用严重偏离时降级 `palette_source` 为 `pptx-observed` |

**fflate 解析法**：`unzipSync` 拿到 `Record<string, Uint8Array>` → `strFromU8(files['ppt/theme/theme1.xml'])` → 用正则/轻量 tokenizer 取属性（**不要引入 XML DOM**；主题 XML 结构固定，正则足够且避免 happy-dom 的 namespace 开销）。若坚持 DOM，可用 `happy-dom` 的 `DOMParser` 但需自己处理未声明前缀；实践上正则 + `/**\/` 去注释更快更稳。`fflate` 只解一次，用 `filter` 选项只取需要的 4 个 part 可把大 deck 的解压内存降一个量级。

**必须实现的 4 个正确性细节**：(1) `clrMap` 别名（`bg1→lt1` 等）；(2) `sysClr@lastClr` 回退（`dk1` 常是 `sysClr val="windowText"` 只有 `lastClr`）；(3) `accent_inverted` 必须真的对 `background` 做 WCAG 对比（dsh-ppt 的 `relativeLuminance` 已有，`src/themes.ts:77+`），否则深色主题会给出不可用 accent；(4) 字体回退链要含 CJK（`ea`）否则中文 deck 全落到默认西文字体。

**可以跳过**：`themeOverride`（每页覆盖）、`a:fmtScheme`（效果/背景填充样式——dsh-ppt 用不上）、`a:objectDefaults`、`p:embeddedFontLst`、`extraClrSchemeLst`。**不要做**：把 `theme1.xml` 原样塞进生成的 pptx（pptxgenjs 自己会写 theme；两条 theme 路径冲突会产生两个 `themeN.xml`）。

### 6.3 (b) PPTX→HTML/SVG 页导入用于重撰（最小可用子集）

**目标**：不追求 bbox 级还原，只产出"一页一张 HTML（绝对定位 div）或一张 SVG + 一段结构化文本清单"，让现有 `ElementIR` 管线（`src/ir.ts:7-30`）能吸收并重撰。

**必读 part**

| part | 用途 |
|---|---|
| `ppt/presentation.xml` + `_rels` | 画布 + slide 顺序（`p:sldIdLst` 的 `r:id` → `slideN.xml`） |
| `ppt/slides/slideN.xml` | `p:spTree`：`p:sp`（`a:off/a:ext`、`a:prstGeom@prst` 或 `a:custGeom`、`p:txBody`）、`p:pic`（`a:blip@r:embed` + `a:srcRect`）、`p:graphicFrame`（跳过） |
| `ppt/slides/_rels/slideN.xml.rels` | `r:embed` → `../media/imageN.png` |
| `ppt/slideLayouts/slideLayoutN.xml` + `slideMasters/slideMaster1.xml` | **只在需要 `showMasterSp` 与占位几何回填时读**；MVP 可跳过，代价是缺背景/装饰 |

**解析法**：
1. `unzipSync` 全包（或按需 3 个 part）。用 `strFromU8` + 正则切片 `p:spTree`。
2. 对每个 `p:sp`：读 `a:xfrm/a:off@x,y` 与 `a:ext@cx,cy` → `/9525` 得 px；`a:prstGeom@prst="rect|roundRect|ellipse"` → `div{left,top,width,height,borderRadius|border-radius:50%}`；其它 preset → 输出带 `data-unknown-prst` 的占位 rect（**这正对应 ppt-master 的 bbox fallback 立场**，`prstgeom_to_svg.py:7-8`）。
3. 文本：取 `p:txBody/a:p/a:r/a:t` 拼段，`a:pPr@algn` → `text-align`，`a:rPr@sz`（百分之一磅）→ `fontSizePx = sz/100*4/3`，`a:rPr/a:solidFill` → `color`；`a:bodyPr@anchor` → `align-items`。**不要**复刻 autofit（`fontScale` 可以乘，`spAutoFit` 直接忽略）。
4. 图片：`r:embed` → `media/` 字节 → base64 或落盘；`a:srcRect` 用 `clip-path: inset(l% t% r% b%)` 表达。
5. 画布：`viewBox`/`style.width` 用 slideSize 换算出的 px，保证与 dsh-ppt 的 1280×720 常量一致。

**可以跳过**（MVP 明确不做）：`grpSp` 递归（先按整体 bbox 当一个块）、`custGeom` 曲线（当 rect）、组合图表/表格/SmartArt（当 `manual_required` 占位）、动画/切换（另走独立 sidecar 通道，见第 7 节第 6 项）、EMF/WMF（sharp 解不了，占位）、`mc:AlternateContent` 的 Choice（取 Fallback 预览图更省事）。**关键结论**：pptx-master 的 22 个模块里真正不可省的是 `ooxml_loader`（关系解析）+ `shape_walker`（占位继承）+ `color_resolver`（scheme+clrMap）三件；其余都是保真度增量。

### 6.4 (c) 模板工作区 JSON（dsh-ppt 主题格式）

**最小契约**（借鉴 `tpl/README.md:30-40` 的目录契约 + `PptTheme` 的形状，但只保留 dsh-ppt 能消费的字段）：

```jsonc
{
  "schema": "dsh-ppt.template.v1",
  "kind": "brand|style|layout|deck",
  "id": "acme-corp", "name": "Acme Corporate",
  "canvas": { "width": 1280, "height": 720, "format": "ppt169" },
  "identity": {                       // ← (a) 的产物直接落这里
    "palette": { "background": ["#FFFFFF"], "surface": ["#F5F7FA"], "accent": "#0B5FFF",
                 "accent_inverted": "#7FB2FF", "text": ["#111418", "#5B6470"] },
    "typography": { "display": {"family":"Source Han Sans SC","weight":700},
                    "body": {"family":"Source Han Sans SC","weight":400} },
    "logo": { "images": ["images/logo.svg"], "policy": "top-left | none | footer" }
  },
  "pages": [ { "id":"cover", "page_type":"cover", "layout":"center",
               "image": "exports/cover.png", "slots": ["title","subtitle"] } ],
  "notes": "one-line usage guidance for the agent",
  "provenance": { "source":"pptx:<sha256>", "mode":"extracted|authored|mirror" }
}
```

磁盘布局直接照抄 ppt-master 的 workspace 契约：`<theme_dir>/templates/design_spec.<kind>.<id>.md`（人读）+ `theme.json`（机读）+ `images/` + `icons/`，`exports/` 忽略。**安装语义**：dsh-ppt 侧不做"目录拷贝"，而是把 `theme.json` 合并进 `ppt_themes` 的目录（运行时 register），并保留 `provenance.source` 以便审计。

**实现要点（成本最低的一条路）**：先只支持 `brand` 与 `style` 两种——它们不需要 SVG 名册，也就绕开了 pptx-master 最重的结构契约（`ref/pptx-structure-interface.md:34-57` 的 10 个属性）。等到 (b) 能产出可复用页时再引入 `layout/deck` 的 `pages[]`。

**可以跳过**：`data-pptx-*` 全套（dsh-ppt 用 HTML/CSS 而非 SVG slot 契约）、`page_plan.json`、`replication_mode`、索引 JSON 四件套（12 主题规模用手写 registry 更划算）。

### 6.5 (d) 图标包

**最小契约**：`icons/manifest.json`（`{lib: {count, viewBox, license}}`）+ 每库一个 `index.json` 数组（`name → {viewBox, keywords[]}`），因为 dsh-ppt 是 TypeScript 运行时，无法像 ppt-master 那样靠 `rg --files` 检索；关键词表是把"抽象概念→可绘制对象"这条硬规则（`tpl/icons/README.md:42`）编码进数据。

**落地**：
1. 选 1–2 个库起步（`tabler-outline` 5,138 与 `simple-icons` 3,675 覆盖 80% 场景；注意 `simple-icons` 许可与商标边界，`tpl/icons/THIRD_PARTY_NOTICES.md`）。
2. `icon_sync` 的语义翻译为：`resolveIcon(lib, name)` 校验 `library/name` 完整形式（对应 `icon_sync.py:48-65`），未命中即抛错不回退；一批只许一个文体库（`icon_sync.py:116-127`）。
3. 渲染：`<img src="data:image/svg+xml;base64,...">` 或 `<svg>` 内联；pptxgenjs 需要位图时用 `sharp` 转 PNG（sharp 已是依赖）。
4. 校验：复用现有质量门检查 `data-icon` 未解析数（相当于 `finalize_svg.py --only embed-icons` 的角色）。

**可以跳过**：`imported/` 命名空间与装饰抽取（`extract_svg_assets` 那一套），除非做 (b) 的完整版。

---

## 7. dsh-ppt 最值得加的 8 个能力（按优先级）

### 1) `ppt_theme_from_pptx`：从客户 PPTX 抽主题并注册为 PptTheme
**价值**：把"客户品牌"从口头描述变成可验证色板；直接补 `ppt_themes` 只能列 12 个内建主题的短板（`src/themes.ts:428`）。
**实现**：新工具 `ppt_theme_from_pptx({path, name?, scene_tags?})`。`unzipSync(data, {filter: f => /^ppt\/(theme\/theme1\.xml|presentation\.xml|slideMasters\/slideMaster1\.xml)$/.test(f.name)})` → 正则抽 `clrScheme`/`fontScheme`/`sldSz`/`clrMap` → 组装 §6.2 的 `BrandTheme` → `validateTheme()`（已存在于 `src/themes.ts`）→ 写入 profile 级 `themes.custom.json`，`listThemes` 合并内建与自定义。返回 `{theme_id, palette_source, contrast_findings, warnings}`；对比度不足时**降级为 `scene` 建议而不是拒绝**（与 `themeFindings` 一致）。
**验收**：对一个真实商业 deck，`palette.accent` 等于 `accent1`，中文正文 `family` 落到 `ea` 而不是 `latin`，`palette_source` 可审计到 part + sha256。

### 2) `ppt_template_import`：模板工作区 JSON 导入/安装 + 收据
**价值**：把 §6.4 的契约变成一等公民，让"品牌模板"可跨会话复用，而不是每轮从对话里重建。
**实现**：两个动作合一个工具：`action=import`（读 `<dir>/theme.json` + `design_spec.*.md`，校验 schema 与 id 唯一，`images/` 逐个存在性检查）与 `action=install`（写入 profile themes 目录，产出 `template_install.json`：`{roots, kinds, installed_specs, files: {rel→sha256}, selection_sha256|null}`）。照抄 ppt-master 的"先 stage 后 rename + 失败回滚 + 字节相同标 `[same]`"（`scripts/docs/template-tools.md:129-133`）；重复 kind 直接拒（`wf/stages/apply-template-workspace.md:27`）。
**验收**：同一根安装两次第二遍全部 `[same]`；重复 kind 时在写盘前失败。

### 3) `ppt_brand_intake`：PPTX intake 摘要（页数/画布/主题/媒体/占位）
**价值**：让 agent 在动手前知道"源 deck 有什么"，是 (b) 的前置侦察，也是 beautify 类需求的入口。
**实现**：`inspectPptxPackage` 扩展为 `{pages, slideSize, theme:{palette,fonts}, counts:{shapes,text,images,charts,tables,notes}, mediaBytes}`——只需遍历 `ppt/slides/slideN.xml` 的正则计数（`p:sp`/`p:pic`/`c:chart`/`a:tbl`/`p:txBody`），不建树。返回体积受 `DEFAULT_LIMITS` 约束（`src/limits.ts`）。
**验收**：对 30 页 deck < 200ms，计数与 PowerPoint 选择窗格一致（误差 0）。

### 4) `ppt_icons`：图标检索 + 内联 + 一库原则
**价值**：版式装饰与"概念→对象"翻译，是 `ppt_themes.decoration` 的落地物。
**实现**：`manifest.json` + 每库 `index.json{name,viewBox,keywords}`；工具 `ppt_icons({query, lib?, limit})` 返回 `{lib, name, viewBox, svgPath}`，并在 `html_create`/`ppt_create` 侧把 `data-icon="lib/name"` 内联成 `<svg>`；`data-icon` 解析失败即 `PPT_ICON_MISSING` 抛错（对应 `icon_sync.py` 的非零退出语义）。
**验收**：`idea` 这类抽象词返回空并提示"换成 bulb/target/trending-up"；混用两库被拒。

### 5) `ppt_import_pages`：PPTX 页 → HTML 可编辑页（(b) 的最小版）
**价值**：唯一能真正"基于客户既有 deck 重撰"的能力；也是 beautify 的前置。
**实现**：§6.3 的 5 步，输出 `<workspace>/import/pages/page_NN.html` + `source.json`（每元素：`{kind,box,text?,style?,imageRef?,unsupported?}`）。落到 `ElementIR`（`src/ir.ts:7-30`）后复用现有 `ppt_create` 全链路。**先做"文本+矩形+图片"三件**，其余一律 `unsupported`（渲染成灰框 + 报告），绝不猜。
**验收**：导入重出后页数一致、每页文本集合与回读一致（对齐 `beautify_inventory.py --verify` 的"去空白包含"判据）。

### 6) `ppt_read_motion` / `ppt_write_motion`：切换与动效的独立通道
**价值**：dsh-ppt 已有写侧（`transitions.ts`/`animation.ts` 改写已产包），缺读侧；补齐后"保留客户 deck 的切换"才可能。
**实现**：读 `ppt/slides/slideN.xml` 的 `p:transition`（`p14:dur`、`advTm`、sound 关系）与 `p:timing` 的有限行为树，产出 `{page, transition:{effect,duration,advance_after_ms,advance_on_click}, animations:[{target_shape_id,effect,duration,delay,start}]}`；不可识别的形态返回 `unsupported` 而不是 fade 顶替（对齐 `scripts/docs/conversion.md:351-355`）。写回沿用现有 `rewritePptxTransitions/rewritePptxAnimations`。
**验收**：roundtrip 一个含 3 种切换的 deck，读→写后 PowerPoint 中切换不变；不可识别项被显式列出。

### 7) `ppt_page_plan`：页码/顺序/重复/省略的输出名册
**价值**：把"客户第 4 页要复用两次""删掉第 6 页"这类需求从对话变成结构；是 import-pages 与 ppt_create 之间的胶水。
**实现**：`page_plan.json` 照抄 ppt-master 的 schema（`wf/edit-native-pptx.md:62-76`）：`{schema, pages:[{source_page, html?}]}`；校验"完整非空顺序/无未知文件/无重复 source_page 冲突"。导出时按 plan 重排 `ElementIR` 页数组，并拒绝"引用了被省略页的跳转链接"（对应 `authoring_roundtrip.py:1740-1753`）。
**验收**：重复页产出两页独立内容；引用被删页的链接报错并指名页号。

### 8) `ppt_pptx_audit`：交付前包体检（含 rebuilt/保真分桶）
**价值**：现在只有 `quality.ts` 的四道 gate，缺"这个包能不能安全交付"的结构体检；对齐 `pptx_delivery_check.py`。
**实现**：`unzipSync` 后检查：`[Content_Types].xml` 覆盖每个 part、每个 `.rels` 的 target 存在、无 `__MACOSX`/绝对路径、媒体总体积、隐藏页（`p:sld@show="0"`）、字体可用性（`fontkit` 已依赖）、动效存在性；输出 `{errors[], advisories[], summary{pages,mediaBytes,hiddenSlides,hasMotion}}`。再加一栏"页级分桶"：`verbatim | text_edited | rebuilt`，供 agent 自检"我到底改了多少页"——这正是 ppt-master 的 `passthrough/patched/rebuilt` 收据（`cli.py:3114-3125`）在 dsh-ppt 里的等价物。
**验收**：故意删一个 media 文件 → 报 `OPC_TARGET_MISSING` 且指到具体 rels 行；纯交付轮 `rebuilt=0`。

---

## 附：关键文件索引（便于复核）

| 主题 | 文件 |
|---|---|
| 转换主编排 | `scripts/pptx_to_svg/converter.py`（`convert_pptx_to_svg:482`、`_write_roundtrip_manifest:1602`、`_write_conversion_report:1791`） |
| 单页合成 | `scripts/pptx_to_svg/slide_to_svg.py:229`、`:1767`、`:2202`、`:2254` |
| 形状遍历/占位继承 | `scripts/pptx_to_svg/shape_walker.py:64`、`:357-560`、`:551` |
| 颜色 | `scripts/pptx_to_svg/color_resolver.py:220`、`:302`、`:461` |
| 几何 | `scripts/pptx_to_svg/prstgeom_to_svg.py:71`、`custgeom_to_svg.py:36`、`formula_import.py:100` |
| 文本 | `scripts/pptx_to_svg/txbody_to_svg.py:126`、`:802`、`:1410` |
| 图片 | `scripts/pptx_to_svg/pic_to_svg.py:1-28`、`:397`、`:523` |
| 图表/表格 | `scripts/pptx_to_svg/chart_to_svg.py:58`、`tbl_to_svg.py:279` |
| 诊断 | `scripts/pptx_to_svg/import_diagnostics.py:7` |
| 工作区常量 | `scripts/pptx_workspace.py:33-51` |
| 往返落地 | `scripts/authoring_roundtrip.py:97`、`:323`、`:1714`、`:2136` |
| 导出分桶 | `scripts/svg_to_pptx/pptx_package/cli.py:3089-3125`、`pptx_ooxml/clone.py:1-25` |
| 模板安装 | `scripts/apply_template.py:1-25`、`scripts/docs/template-tools.md:123-133` |
| 模板导入 | `scripts/pptx_template_import.py:1-22`、`scripts/template_import/*` |
| mirror 落地 | `scripts/mirror_template_materialize.py:1-17` |
| 注册/索引 | `scripts/register_template.py:1-45` |
| 图标 | `scripts/icon_sync.py:38-127`、`tpl/icons/README.md` |
| 生图/图搜/处理 | `scripts/image_gen.py:588`、`image_search.py:1-35`、`image_treat.py:1-17` |
| Beautify | `scripts/beautify_identity.py:213`、`beautify_inventory.py:87/270`、`wf/profiles/beautify-pptx.md` |
| dsh-ppt 对照 | `E:\code\dsh-ppt\src\{pptx,themes,tools,ir,quality}.ts`、`package.json` |
