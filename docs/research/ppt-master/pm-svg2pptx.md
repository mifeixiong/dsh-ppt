# ppt-master SVG → 原生 PPTX 转换引擎：深度实现分析

> 分析对象：`E:\code\_recon\ppt-master`（GitHub `hugohe3/ppt-master`），只读，未做任何修改。
> 分析时间：2026-10-24。基线：工作区快照，无 git 元数据依赖。
> 规模：`scripts/svg_to_pptx/` 下 51 个 `.py`，本报告涉及的核心代码约 **61,900 行**（`wc -l` 统计：`builder.py` 8740、`elements.py` 5686、`cli.py` 3949、`utils.py` 3810、`template_structure.py` 3759、`converter.py` 2601 …）。

**路径缩写（全文一致）**

| 缩写 | 实际路径（相对仓库根） |
|---|---|
| `S/` | `skills/ppt-master/scripts/` |
| `S2P/` | `skills/ppt-master/scripts/svg_to_pptx/` |
| `DM/` | `skills/ppt-master/scripts/svg_to_pptx/drawingml/` |
| `NO/` | `skills/ppt-master/scripts/svg_to_pptx/native_objects/` |
| `PKG/` | `skills/ppt-master/scripts/svg_to_pptx/pptx_package/` |
| `DOC/` | `skills/ppt-master/scripts/docs/` |
| `REF/` | `skills/ppt-master/references/` |

---

## 0. 结论先行（7 条）

1. **不是"渲染成图"，是"结构化重写"**：整条链路把 SVG DOM 逐个元素翻译成 DrawingML 片段，**没有任何栅格化兜底**。PIL 只用于位图降采样/重编码（`DM/elements.py:4662-4719`），从不参与矢量转换。遇到不认识的可见元素直接抛 `SvgNativeConversionError`（`DM/converter.py:1961`）。
2. **转换器是"字符串拼装器 + 严格前置校验器"的组合**：`convert_*` 函数返回 `ShapeResult(xml: str, bounds_emu)`（`DM/context.py:49-55`），没有任何 DOM/对象树中间层；正确性靠 `project_*_errors()` 系列（30+ 个）在转换前把不可表达的输入拒掉。
3. **坐标系统一为"SVG px × 9525 = EMU"**，页尺寸单独由 viewBox 契约决定（`S2P/canvas_contract.py:46-61`），换算用 `Decimal` 四舍五入到整数 EMU，避免浮点累计误差。
4. **文本是最复杂的一块**（约 600 行单函数 `convert_text`，`DM/elements.py:3158-3761`），核心创新是用**捆绑字体的 ascent/descent 度量**反推 PowerPoint 首行基线，再反解 frame 的 `off.y`（`DM/text_baseline.py:67-127`）。
5. **图表/表格/公式走"标记协议 + 内嵌 JSON + 原生部件注册表"**：`<g data-pptx-replace-with="chart|table|formula">` + 子 `<metadata type="application/json">`，由 `PackagePartRegistry` 分配 `ppt/charts/chartN.xml`、`ppt/embeddings/*.xlsx` 并登记 Content-Type（`S/pptx_ooxml/package.py:36-80`）。
6. **打包策略是 python-pptx 造壳 → 解包 → 逐页写 slide XML → 校验关系 → 重打包**（`PKG/builder.py:7234-7235`、`:8632-8636`），与"unzip → patch → rezip"的后处理范式同构，这正是 dsh-ppt 可以直接复用的骨架。
7. **分组语义被显式打断两次**：单子元素 `<g>` 折叠成叶子（`DM/converter.py:1418-1435`），但顶层语义组保留 `p:grpSp` 以便整组动画（`:1494-1500`）；组透明度因为 DrawingML 无组 alpha，被乘进每个后代（`DM/context.py:103-106`）。

---

## 1. 流水线架构

### 1.1 入口与调用链

```
python3 scripts/svg_to_pptx.py <project> [-s final] [-o out.pptx] [--roundtrip]
  └─ S/svg_to_pptx.py:23-31        薄包装：sys.path 注入、UTF-8 stdio、require_skill_integrity()
      └─ svg_to_pptx.__getattr__   S2P/__init__.py:20-37   延迟导入，避免循环依赖
          └─ main()                PKG/cli.py:2073+        argparse + 项目契约 + postflight
              └─ create_pptx_with_native_svg()   PKG/builder.py:6730-6790
                  └─ convert_svg_to_slide_shapes()  DM/converter.py:2018
```

三个公开 API（`S2P/__init__.py:13-17`）：

| API | 实现位置 | 职责 |
|---|---|---|
| `main()` | `PKG/cli.py:2073` | CLI：解析参数、读 `spec_lock.md`、发现 SVG roster、调用 builder、写 trace、跑 postflight |
| `convert_svg_to_slide_shapes()` | `DM/converter.py:2018` | **纯函数式**：单个 SVG 文件 → `(slide_xml, media, rels, anim_targets, package_files, content_type_overrides)` |
| `create_pptx_with_native_svg()` | `PKG/builder.py:6730` | 编排：造壳、循环、注入过渡/动画/备注/旁白、校验、打包 |

`svg_to_pptx.py` 本身只有 31 行，是一个"防呆入口"：先 `require_skill_integrity()`（防篡改），再 `raise SystemExit(main())`（`S/svg_to_pptx.py:29-31`）。

### 1.2 阶段表（S0–S9）

| 阶段 | 位置 | 输入 → 输出 | 关键行为 |
|---|---|---|---|
| **S0 发现** | `PKG/discovery.py`（135 行）、`PKG/cli.py` | 项目目录 → `list[Path]` | 认定 `svg_output/`（默认）或 `-s <dir>`；`--roundtrip` 读 `authoring-svg-flat/`（`S/svg_to_pptx.py:4-14`） |
| **S1 造壳** | `PKG/builder.py:7234-7251` | — → 解包目录 | `Presentation()`（python-pptx 默认模板）存盘 → `zipfile` 解到 temp dir → 读 `[Content_Types].xml` |
| **S2 建索引** | `DM/converter.py:1705-1758` | 根元素 → `defs{}`、`source_shape_id_map` | `<defs>` 扁平化为 `{id: Element}`；导入形状 id 预留（防抢号） |
| **S3 预处理** | `DM/converter.py:2127-2196` | SVG 树 → 同树（就地改写） | 危险归一化（可选）、标记属性冲突检查、compact preset 物化、`data-pptx-frame` 与 inline geometry 物化 |
| **S4 前置校验** | `DM/converter.py:240-520`（`_require_project_*`，30 个） | 树 → 错误列表 | 长度/变换/描边/透明度/涂色/defs/渐变/滤镜/蒙版/marker/图片比例/裁剪… 任一非空即抛 |
| **S5 递归转换** | `DM/converter.py:2481-2519` → `convert_element`（1869）→ `_CONVERTERS`（1551-1564） | 元素 → `ShapeResult` | 按 tag 分派到 11 个转换器；`<use>`/tspan 已在 S3 前被展开器处理 |
| **S6 背景提升** | `DM/converter.py:1575-1702` | 首层全画布 rect → `p:bg` | 避免整页矩形被用户框选误操作；仅首层、无 transform/filter/clip、无圆角 |
| **S7 汇编** | `DM/converter.py:2571-2592` | 片段列表 → `p:sld` | `p:cSld/p:spTree` 固定骨架，`p:nvGrpSpPr` id=1 保留 |
| **S8 打包** | `PKG/builder.py:7690-8020`、`:8484-8636` | slide XML + media + rels → zip | 逐页写 `ppt/slides/slideN.xml`、`.rels`，登记 Content-Type，追加过渡/动画/旁白 |
| **S9 校验** | `PKG/builder.py:8603-8688` | zip → 通过/异常 | `verify_internal_relationships`（悬空 rel 即"文件损坏"）、模板/过渡/Morph/动画四道包校验，最后 `shutil.move` 原子替换输出 |

S8 的顺序有硬约束，代码里写得很明白（`PKG/builder.py:7764-7767`）：

> OOXML schema requires `<p:transition>` to precede `<p:timing>` inside `<p:sld>`. Both use the same `</p:sld>` string-replace anchor, so transition must be injected first and timing second.

### 1.3 模块职责

| 模块 | 行数 | 职责（一句话） |
|---|---|---|
| `DM/converter.py` | 2601 | 调度器：`<g>`/`<a>`/背景/defs/主循环/slide 汇编 |
| `DM/elements.py` | 5686 | 全部叶子转换器：rect/circle/ellipse/line/path/polygon/polyline/text/image/nested-svg + clipPath + 图片优化 |
| `DM/styles.py` | 782 | 涂色（solid/gradient/pattern）、描边（dash/cap/join/marker/gradient stroke）、特效（outerShdw/glow）、opacity 提取 |
| `DM/paths.py` | 847 | SVG path tokenizer/parser、绝对化、规范化（Q→C、A→C）、矩阵变换、→`a:custGeom` |
| `DM/utils.py` | 3810 | 单位、颜色、字体、变换矩阵、度量估计、**全部 `project_*_errors` 校验器**、文本宽度估计 |
| `DM/text_properties.py` | 796 | 字重/字号/字距/装饰/text-anchor 的封闭枚举与解析 |
| `DM/text_baseline.py` | 127 | 用 `font_metrics.json` 反推 DrawingML 首行基线 |
| `DM/theme_fonts.py` / `theme_colors.py` | 502 / 283 | 把锁定字体/颜色提升为 `+mj-lt`/`+mn-lt`/`schemeClr` 槽位 |
| `DM/hyperlinks.py` | 162 | 形状级超链接 → `a:hlinkClick` + rel |
| `S2P/use_expander.py` | 585 | 内存中展开 `<use data-icon>` 与本地 `#id` 引用（替代磁盘 finalize） |
| `S2P/tspan_flattener.py` | 84 | 位置型 `<tspan>` 提升为独立 `<text>`（委托 `svg_finalize`，保持双管线一致） |
| `S2P/canvas_contract.py` | 226 | viewBox 契约（原点必须 0 0、正尺寸、EMU 在 914400..51206400） |
| `S2P/geometry_properties.py` | 140 | 把 `data-pptx-geometry` 内联声明物化成可转换属性 |
| `S2P/shape_boolean.py` | 1355 | 布尔运算（pathops）生成 custGeom（供 preset 合成） |
| `S2P/text_outline.py` | 1121 | 文本转轮廓（当字体不可嵌入时的等价路径） |
| `S2P/animation_config.py` | 1910 | `animations.json` 侧车、pptx `p:timing` 生成 |
| `NO/*` | 11 个文件 | chart/table/formula 的 OOXML 生成 + marker 校验 + 体积/哈希防线 |
| `PKG/*` | 17 个文件 | 包编排、模板 master/layout、备注/旁白、包校验、CLI |

### 1.4 中间表示（唯一的数据结构）

```python
# DM/context.py:49-55
@dataclass
class ShapeResult:
    xml: str                                        # 一段 DrawingML 片段（p:sp/p:pic/p:grpSp/…）
    bounds_emu: tuple[int, int, int, int] | None = None   # 供父级 grpSp 求包围盒
```

**没有元素级 dataclass**。解析后的"元素"就是 `xml.etree.ElementTree.Element`，附加信息全部放在属性上（`data-pptx-*`）。这是刻意的：转换是**一次遍历、无回溯**的，任何需要的上下文都靠 `ConvertContext` 下推。

`ConvertContext`（`DM/context.py:58-141`）字段分五组：

| 组 | 字段（节选） | 说明 |
|---|---|---|
| 几何累积 | `translate_x/y`、`scale_x/y`、`transform_matrix`、`use_transform_matrix`、`viewport_width/height` | **双模**：标量模式（translate+scale）与矩阵模式；首次进入矩阵时把标量折叠进矩阵基（`:220-232`，注释解释了 `<image>` 只读矩阵会导致元素"跑到原点"的 bug） |
| 样式继承 | `inherited_styles`、`text_font_sizes`、`text_letter_spacings`、`filter_id`、`opacity_multiplier` | SVG 可继承属性白名单见 `DM/utils.py:52-57` |
| 资源/包 | `defs`、`media_files`、`rel_entries`、`package_files`、`content_type_overrides`、`package_parts`、`rel_id_counter` | 每个 slide 一份，media 由 `_register_image_media` 去重 |
| 身份 | `id_counter`（从 2 起，1 留给 spTree，`:66`）、`reserved_shape_ids`、`claimed_shape_ids`、`referenced_shape_ids`、`source_shape_id_map` | 导入形状 id 必须"认领"而非新分配（`claim_shape_id`，`:143-172`） |
| 策略 | `text_flow`（preserve/reflow/split，`:19-46`）、`native_objects_enabled`、`image_optimize` 系列、`theme_font_spec`、`theme_color_spec`、`primary_language`、`trace_events` | 影响产物但不影响坐标 |

`child()`（`:195-297`）是唯一的上下文派生入口，**60 个字段逐个显式复制**——这种"啰嗦"换来的是没有隐式共享状态导致的跨页污染（`anim_targets` 例外：子上下文故意新建空列表，只有根上下文被 builder 读取，`:282-284`）。

### 1.5 解析、单位、viewBox→EMU

**解析库**：标准库 `xml.etree.ElementTree`（`DM/converter.py:13`、`:2117`）。没有 lxml、没有 svgpathtools、没有 cairosvg。命名空间用字符串前缀裁剪（`elem.tag.replace(f'{{{SVG_NS}}}', '')`）。

**长度解析**（`DM/utils.py:396-441`）：

```python
# 支持的单位与基准（96 DPI 约定）
'' | 'px' → number
'%'       → percent_base * number / 100   （x→宽, y→高, r→min(w,h)，见 :662-672）
'pt'      → number * 96/72
'pc'      → number * 16
'in'      → number * 96
'cm'      → number * 96/2.54
'mm'      → number * 96/25.4
'q'       → number * 96/101.6
'em'|'rem'→ number * font_size
其它       → ValueError（fail closed）
```

注意两条**分级策略**：
- 通用解析 `parse_svg_length` 接受完整单位集（`:396`）；
- **项目几何契约** `parse_project_geometry_length`（`:444-462`）只接受 `unitless | px`，且数字拼写必须是普通十进制（拒绝 `+1`、`1e3`、`1.`），因为生成端只写这一种形式——这是"读兼容 vs 写规范"分离的典型做法。

**核心常量**（`DM/utils.py:45-49`）：

```python
EMU_PER_PX = 9525                 # 1 CSS px @96dpi
FONT_PX_TO_HUNDREDTHS_PT = 75     # 1px = 0.75pt
DRAWINGML_TEXT_FONT_SIZE_MIN = 100      # 1.00 pt
DRAWINGML_TEXT_FONT_SIZE_MAX = 400_000  # 4000 pt
ANGLE_UNIT = 60000                # 1/60000 度
```

**字号量化**（`:324-342`）——先乘 75，再 **round 到 0.1pt**：

```python
size = int(round(scaled / 10.0)) * 10      # :335
```

即 40px → 3000（30.0pt）；19.7px → 1480（14.8pt）。这保证了"字重/字号相同"的 run 能被合并（`_coalesce_text_runs`），也让 `spcPts`/`lnSpc` 的数值可预测。

**viewBox→EMU**（`S2P/canvas_contract.py:30-61`）：

```python
@dataclass(frozen=True)
class ProjectViewBox:
    width: Decimal; height: Decimal
    @property
    def emu_dimensions(self):                     # :46-51
        w, h = self._scaled_emu_values()          # width*9525, height*9525（Decimal, prec>=28）
        return int(w.to_integral_value(ROUND_HALF_UP)), int(h.to_integral_value(ROUND_HALF_UP))
```

- 原点必须精确 `0 0`（`:116-119`），宽高必须为正（`:120-123`），并校验落到 PowerPoint 允许的 slide 尺寸区间 `914400..51206400 EMU`（`:17-18`、`:125`）。
- **元素坐标直接用同一比例**：`px_to_emu(px) = round(px*9525)`（`DM/utils.py:319-321`）。因此 1280×720 的 viewBox 恰好映射成 12,192,000 × 6,858,000 EMU（13.333in × 7.5in），元素坐标与页尺寸**共享同一线性比例**，不存在二次缩放。
- 页尺寸由**项目 canvas 契约**给出（`PKG/builder.py:7119`：`width_emu, height_emu = canvas.emu_dimensions`），不是从每个 SVG 的 `width`/`height` 属性读——SVG 只是 viewBox 的载体。

**百分比在元素里的基准**（`DM/utils.py:662-672`）：`x/w → viewport_width`，`y/h → viewport_height`，`r → min(w,h)`。SVG 规范里 `r` 的百分比基准是"归一化对角线"，这里用 `min()` 做了工程近似（属于有意的偏差，非 bug——代码注释未声明，此处为**推断**）。

### 1.6 输出契约

```python
# DM/converter.py:2092-2104
(slide_xml, media_files, rel_entries, anim_targets,
 package_files, content_type_overrides)
```

| 返回值 | 类型 | 去向 |
|---|---|---|
| `slide_xml` | `str` | 直接写入 `ppt/slides/slideN.xml` |
| `media_files` | `{filename: bytes}` | 写入 `ppt/media/`；文件名含内容哈希，天然去重 |
| `rel_entries` | `[{id, type, target}]` | 追加到 slide 的 `.rels` |
| `anim_targets` | `[(shape_id, svg_id)]`（z 序） | builder 生成 `p:timing` |
| `package_files` | `{包内路径: bytes}` | 原生图表 XML、内嵌 xlsx 等 |
| `content_type_overrides` | `{包内路径: MIME}` | 写入 `[Content_Types].xml` 的 `<Override>` |

这个 6 元组是整个引擎的"接缝"：`convert_svg_to_slide_shapes` 不知道 zip 的存在，`builder` 不知道 DrawingML 的细节。**dsh-ppt 若复刻，应保留这条边界**。

---

## 2. 特性 → DrawingML 映射表

**总原则**：`_CONVERTERS`（`DM/converter.py:1551-1564`）里没有的可见标签，一律 `raise SvgNativeConversionError(f'Unsupported visual SVG element <{tag}>')`（`:1961`）。**没有"降级成位图"这一档**：要么原生表达，要么报错。这对 dsh-ppt 是个重要的设计取向——可编辑性优先于"能出图"。

| SVG 特性 | 如何检测 | 产物（OOXML） | 不支持/边界时的行为 | 证据 |
|---|---|---|---|---|
| `<rect>` 直角 | 无 `rx`/`ry` 或 ≤0 | `<a:prstGeom prst="rect">` | `w<=0 \|\| h<=0` → 返回 `None`（静默跳过） | `DM/elements.py:1287-1288`、`:1342-1343` |
| `<rect>` 对称圆角 | `rx>0 && \|rx-ry\|<0.5`（比较**已缩放**值） | `prstGeom roundRect` + `<a:gd name="adj" fmla="val N"/>`，`N=round(r/short*100000)`，上限 50000 | 半径先 `min(rx, short/2)` 钳制 | `:1321-1333` |
| `<rect>` 非对称圆角 | `rx != ry` 且 >0 | `custGeom`：每 90° 一段三次贝塞尔 | 失去 `roundRect` 的黄色调整柄（注释明说） | `:1334-1341`、`_build_round_rect_custgeom` `:1175` |
| `<rect>` 带 `data-pptx-prst` | 属性存在 | 走预设几何 + `_shape_xfrm_from_preset_frame`（保留逻辑框而非渲染框） | `data-pptx-av-*` 提供 adjust 值 | `:1285`、`:1319`、`:1346-1353`、`:808-1035` |
| `<circle>` 普通 | 非甜甜圈 | `prstGeom ellipse`，框 = `cx±r, cy±r`（按 `scale_x/y` 变形成椭圆） | `r<=0` → `None` | `:1470-1478`、`:1565-1629` |
| `<circle>` 甜甜圈扇区 | `_is_donut_circle`：`stroke-dasharray` 恰好覆盖整个圆周且 dash<周长（`DM/utils.py:957-979`） | `custGeom` 环扇形：外弧→线→内弧→闭合；**描边色变填充色**，`a:ln` 置 `noFill` | dash 不是一对、transform 不是单个 `rotate` → `ValueError` | `:1479-1563`、`_build_arc_ring_path` `:1384`、`is_thick_circle_shorthand` `DM/utils.py:622` |
| `<ellipse>` | 标签分派 | `prstGeom ellipse` | 半径 ≤0 → `None` | `_CONVERTERS` `:1554`、`DM/elements.py:5110` |
| `<line>` 无 marker | `marker-start/end` 均缺失 | `custGeom` 单段 `moveTo+lnTo`；框按两端点 min/max | 退化轴保留 1 EMU（DrawingML 要求） | `:1631-1637`、`:1675-1681` |
| `<line>` 带 marker | `marker-start` 或 `marker-end` 存在 | `prstGeom prst="line"` + `a:headEnd`/`a:tailEnd`（类型+尺寸桶） | marker 形状分类失败 → 报错 | `:1668-1672`、`DM/styles.py:370-460` |
| `<path>` | `_CONVERTERS['path']` | 解析→绝对化→规范化 后转 `a:custGeom`（`M/L/C/Q→C/A→C/Z`） | 数字不合规、arc 参数非法 → `ValueError` | `DM/paths.py:249`、`:466`、`:689`、`:784`；`DM/elements.py:1798` |
| `<polygon>` | 标签 | `custGeom`：`M p0, L p1…, Z` | 点数 <3 → 报错 | `DM/elements.py:1886-1963`、`DM/paths.py:255` |
| `<polyline>` | 标签 | `custGeom` 折线（不闭合） | 同上 | `:1963-2035` |
| `<g>` | 标签 | 多子元素 → `<p:grpSp>`；单子元素 → **折叠**成叶子 | 空组 → `None` | `DM/converter.py:1204-1530`、折叠判据 `:1418-1435` |
| `<a>`（超链接） | 标签 | 透明：包装子元素并调用 `apply_shape_hyperlink` | 非法 url / `#slide-N` 越界 → 校验期报错 | `:1533-1542`、`DM/hyperlinks.py`、`S/hyperlink_contract.py` |
| `<use>` | **转换前展开** | 无（不进入 `_CONVERTERS`） | `collect_unsupported_visuals` 只在 `allow_data_icon_use` 时放行 `use[data-icon]` | `S2P/use_expander.py:11-24`、`DM/converter.py:1995-2003` |
| 嵌套 `<svg>` | 标签 | 先按 `data-pptx-crop` 规格求裁剪几何，再走图片管线 | 缺 `clip-path` / 属性越界 → 报错 | `_CONVERTERS['svg']`、`DM/elements.py:5190-5686` |
| `clipPath` | `clip-path="url(#id)"`，仅 `<image>` 或导入的图片载体允许 | 图片自身的 `prstGeom`/`custGeom`：circle/ellipse→ellipse，rect+rx→roundRect，path/polygon→custGeom | 出现在其它元素 → 报错；`<clipPath>` 内非唯一形状 → 报错；`clipPathUnits` 非 `userSpaceOnUse \| objectBoundingBox` → 报错 | `DM/elements.py:4102-4216`（校验）、`:4217-4314`（解析）、`:4131`、`:4258`、`:4156-4160` |
| `mask` | `mask=` 属性 / `<mask>` 定义 / style 内 `mask` | **不产生任何 OOXML** | **显式报错**：`"uses unsupported SVG mask presentation via …; replace it with clip-path, or pre-rendered alpha imagery"` | `DM/utils.py:2392-2419` |
| `<defs>` | 非可视标签 | 不输出；扁平化为 `ctx.defs{id: elem}` | 重复 id → `project_definition_errors` 报错 | `DM/converter.py:1549`、`:1705-1708`、`DM/utils.py:1852-1907` |
| `linearGradient` | `fill/stroke = url(#id)` 且 defs 内为 `linearGradient` | `<a:gradFill>` + `<a:gsLst>` + `<a:lin ang="…" scaled="1"/>`；角度 = `atan2(y2-y1, x2-x1)` 转 1/60000° | 缺 `offset`、坐标越界（`-0.105..1.105`）→ 报错 | `DM/styles.py:44-136`、`DM/utils.py:252-253`、`:2422-2460` |
| `radialGradient` | 同上 | `<a:gradFill><a:path path="circle"><a:fillToRect …/></a:path>`；焦点 `fx,fy` → `l/t/r/b` | 焦点在单位圆外 → 报错 | `DM/styles.py:138-159`、`:145-149` |
| `pattern` | `fill=url(#pat)` 且 defs 内为 `pattern` | `build_pattern_fill`：前景/背景色 → `a:pattFill prst=…` | 无法归类 → 回退 `<a:noFill/>` | `DM/styles.py:211-350`、`:182-191` |
| `filter` = 阴影 | `feDropShadow` / `feOffset+feGaussianBlur+feFlood+feComposite` | `<a:effectLst><a:outerShdw blurRad dist dir algn rotWithShape="0">` | 组合无法归类 → 报错 | `DM/styles.py:624-668`、`:695-704`、`DM/utils.py:2636-2797` |
| `filter` = 发光 | `feGaussianBlur+feFlood+feComposite`（无 offset） | `<a:glow rad=…>` | 同上 | `DM/styles.py:671-694` |
| `filter` 其它原语 | `PROJECT_FILTER_PRIMITIVES` 白名单 | — | 白名单外 → 报错 | `DM/utils.py:255-277`、`:2798-2984` |
| `opacity`（元素）/`fill-opacity`/`stroke-opacity` | `get_element_opacity` 等 | fill/stroke 的 `<a:alpha val=…>`；图片用 `<a:alphaModFix amt=…>` | 百分比形式只允许 `stop/flood-opacity` | `DM/styles.py:725-782`、`DM/elements.py:4912-4923`、`DM/utils.py:478-495` |
| 组 `opacity` | `<g opacity>` | **无原生对应**：乘进每个后代的 `opacity_multiplier` | 组内含活跃原生替换对象 → 报错（无解） | `DM/context.py:103-106`、`DM/converter.py:1310-1315` |
| `stroke-dasharray` | 属性/继承/style | 命中预设表 → `<a:prstDash val="dash\|sysDot\|lgDash\|lgDashDot"/>`；否则 `<a:custDash><a:ds d="…" sp="…"/></a:custDash>`（**以描边宽为 100000 基准的百分比**） | 只取前两个数（长数组被归一化为首对）；负值/非数 → 报错 | `DM/styles.py:510-530`、`DM/utils.py:196-202`、`:551-609` |
| `stroke-linecap` | 封闭枚举 `butt\|round\|square` | `a:ln cap="flat\|rnd\|sq"` | 其它值 → 报错 | `DM/styles.py:532-538`、`DM/utils.py:203-207` |
| `stroke-linejoin` | `bevel\|miter\|round` | `<a:round/>`、`<a:bevel/>`、`<a:miter lim="800000"/>` | 其它值 → 报错 | `DM/styles.py:540-550` |
| `marker-start/end` | 引用 `url(#id)` → `<marker>` | `a:headEnd/a:tailEnd`：`type`（triangle/stealth/diamond/oval/arrow）+ `w/h`（sm/med/lg 三档） | 形状不可分类、尺寸越界 → 报错 | `DM/styles.py:352-460` |
| `<text>` | 标签 | `<p:sp>` + `p:txBody`（`a:bodyPr/a:lstStyle/a:p/a:r`） | 空文本 → `None`（除非 `data-pptx-carrier="true"`，则写 U+200B） | `DM/elements.py:3158-3761`、`:3337-3348` |
| 位置型 `<tspan>`（有 x/y/dy） | 转换前 `flatten_positional_tspans` | 提升为独立 `<text>`（等价磁盘 `svg_finalize`） | 嵌套位置跳变 → 报错 | `S2P/tspan_flattener.py:43-62`、`:82-84` |
| 内联 `<tspan>`（仅样式） | 无定位属性 | 同一 `a:p` 内的多个 `a:r`（属性不同则切 run） | — | `DM/elements.py:2738-2858`、`:3032`（合并同属性 run） |
| `text-anchor` | `start\|middle\|end` | 三处联动：① `a:pPr algn=l\|ctr\|r`；② frame 的 `off.x` 反推；③ 组合时按估计宽度补偿 | 其它值 → 报错 | `:3451-3456`、`:3577-3579` |
| `dominant-baseline` / `alignment-baseline` / `direction` / `writing-mode` | 出现在 text/tspan 上 | — | **显式拒绝**（`_UNSUPPORTED_TEXT_PROPERTIES`） | `DM/text_properties.py:35-63` |
| `baseline-shift` | 仅 `tspan` 且必须是直接属性 | run 上的基线偏移（上下标） | 写在 `<text>` 上 / 写在 style 里 → 报错 | `DM/text_properties.py:88-109`、`:639-656`、`DM/elements.py:3230` |
| `letter-spacing` | 属性/继承 | `a:rPr spc="…"`（1/100 pt，符号保留） | 负字距导致 frame 宽度 ≤0 → 报错（带明确 message） | `DM/elements.py:2151-2158`、`:3676-3680` |
| `transform` = `rotate(a cx cy)` | 单个 rotate 操作 | 形状/文本 `rot=`；**枢轴补偿**：把 SVG 绕 (cx,cy) 旋转的位移折算进 `a:off` | 多操作/含 skew → 走矩阵路径或报错 | `DM/converter.py:1459-1482`、`DM/elements.py:3545-3575`、`DM/utils.py:880-903` |
| `transform` = `translate/scale/matrix` | `parse_transform_matrix` | 标量路径（translate+scale）或矩阵路径（逐点变换后重算 xfrm） | 含 shear 且目标无法表达 → `validate_dml_shape_matrix` 报错 | `DM/context.py:219-243`、`DM/utils.py:1321-1384` |
| `<image>` | 标签；`href`/`xlink:href` 二选一 | `<p:pic>`：`p:blipFill/a:blip` + `a:srcRect` + `a:stretch`，`p:spPr` 内 `prstGeom`（默认 rect） | 缺宽高/非法扩展名/字节与扩展名不匹配（含 EMF/WMF 头校验）→ 报错 | `DM/elements.py:4952-5103`、`:123-318`、`:374-413` |
| `preserveAspectRatio` | `align` + `meet\|slice` | `slice` → `a:srcRect` 裁剪；`meet` → 缩小图片框到图片比例（有真实 clip 时跳过） | 非法值 → 报错 | `:4997-5017`、`:5039-5085`、`DM/utils.py:208-219` |
| 超链接 | `a[href]` 或 `data-pptx-hyperlink` | `a:hlinkClick` + slide `.rels` 条目 | 目标类型/`#slide-N` 校验失败 → 报错 | `DM/hyperlinks.py`、`S/hyperlink_contract.py` |
| `display:none` | 元素或**任一祖先** | 不输出 | `visibility:hidden/collapse` 单独判定为 `visibility:*` 原因 | `DM/utils.py:1485-1510`、`DM/converter.py:1923-1930` |
| 空 `clipPath`（无可见形状） | `_visible_clip_shapes` 为空 | 元素整体跳过 | 记录 trace `reason='empty clipPath'` | `DM/elements.py:4085-4101`、`DM/converter.py:1924-1927` |
| `<title>/<desc>/<metadata>/<style>` | 非可视标签集 | 不输出 | — | `DM/converter.py:1549` |
| 其它可见标签（`foreignObject`、`symbol` 未展开等） | `_CONVERTERS` 未命中 | — | **抛异常**，不是跳过 | `:1960-1961` |

### 2.1 硬性拒绝清单（会被前置校验挡下的写法）

这些不是"渲染不出来"，而是**在转换开始前就失败**，且错误信息带文件名与元素标签：

1. **任何 `mask`**（`DM/utils.py:2397-2417`）——建议改 `clip-path` 或预渲染带 alpha 的位图。
2. **`clip-path` 出现在 `<image>` 之外**（`DM/elements.py:4131`）。
3. **`<clipPath>` 内含多个直接子形状**（`:4258`）。
4. **`clipPathUnits` 非 `userSpaceOnUse`/`objectBoundingBox`**（`:4156-4160`）。
5. **文本只接受 `translate` 列表或单个 `rotate`**（`DM/elements.py:3518-3521`）。
6. **`dominant-baseline`/`writing-mode`/`direction`** 等（`DM/text_properties.py:35-63`）。
7. **几何长度含 `pt/cm/em/%`**（项目契约只收 unitless/px，`DM/utils.py:444-462`）。
8. **原生标记的 bounds 缺失**（JSON-authoritative 时四值必填，`NO/__init__.py:584-593`）。
9. **`<g data-pptx-replace-with>` 但无 JSON**（`NO/marker_common.py:1043-1049`，错误信息甚至给出修复建议）。

这种"生成端只写一种形式、读端严格校验"的策略，使整条链路的下游（PowerPoint / LibreOffice）几乎不可能遇到半合法 XML——代价是对第三方 SVG 的兼容面很窄。**这是有意的取舍**：`DOC/svg-pipeline.md:9-17` 明确写"只有一条 PPTX 路径"，且"PowerPoint 的 Convert-to-Shape 不支持"。

---

## 3. 文本处理（深度）

`convert_text` 单函数 603 行（`DM/elements.py:3158-3761`），是全项目最密的代码。理解它要抓住三层：**run 模型 → 度量模型 → 框模型**。

### 3.1 run 模型

"run" 是一个普通 dict，不是 dataclass。父级属性模板在 `DM/elements.py:3221-3239`：

```python
parent_attrs = {
    'fill', 'fill_raw', 'font_weight', 'font_size', 'font_family', 'font_style',
    'text_decoration', 'letter_spacing', 'baseline_shift',
    '_scale_x', '_object_opacity', '_fill_opacity', '_stroke_opacity',
    'opacity', 'stroke_raw', 'stroke_width', 'stroke_opacity',
}
```

三个来源合并成一个 run 列表：
1. `<text>` 无 `<tspan>` → `_build_text_runs`（`:2819`）收集直接文本节点；
2. 内联 `<tspan>` → `_collect_inline_runs`（`:2753`）逐个 `_override_run_attrs`（`:2651`）；
3. 位置型 `<tspan>`（转换前已被 `tspan_flattener` 提升为独立 `<text>`），或在 `data-paragraph-line-height` 模式下由 `_collect_tspan_runs`（`:2738`）逐行收集。

然后 `_coalesce_text_runs`（`:3032`）把"相邻且属性完全相同"的 run 合并——这是字号量化到 0.1pt 的直接收益：量化后相同即可合并，减少 `a:r` 数量。

特殊 run：

| 哨兵字段 | 含义 | 产物 |
|---|---|---|
| `_line_break: True` | 段内硬换行 | `<a:br/>`，若前一 run 存在则携带同一 `a:rPr`（`:3104-3111`） |
| `_inline_formula_latex` | 该 run 是 OMML 公式 | `<a14:m>` 包裹 + MCE fallback 文本副本（`:3113-3143`、`:3752-3757`） |
| `_language_override` | 强制语言（公式用 `en-US`/主语言，`:3130-3134`） | `a:rPr lang=` |
| `HYPERLINK_RID_KEY` / `HYPERLINK_ACTION_KEY` | run 级超链接 | `a:hlinkClick`（换行 run 会刻意剥离，`:3303-3304`） |

`_build_run_xml`（`:3097-3155`）产出：

```xml
<a:r><a:rPr lang="…" sz="3000" b="1" …><a:solidFill>…</a:solidFill>
  <a:latin typeface="…"/><a:ea typeface="…"/><a:cs typeface="…"/></a:rPr>
<a:t xml:space="preserve">文本</a:t></a:r>
```

`xml:space="preserve"` 只在**首尾有空格或含连续双空格**时写（`:3150`）——这是"能省就省"的字节级优化，也避免了 `xml:space` 满天飞。

### 3.2 字体解析

`parse_font_family(font_family_str, primary_language)`（`DM/utils.py:3234`）返回三槽：

```python
{'latin': 'Microsoft YaHei', 'ea': 'Microsoft YaHei', 'cs': 'Arial'}
```

规则链：

1. **家族栈取首个**，去引号、小写归一再比对（`primary_font_family`，`:3734-3736`）。
2. **macOS/Linux 专属字体 → Windows 等价**：`FONT_FALLBACK_WIN`（`:97-150`）把 `PingFang SC`→`Microsoft YaHei`、`Hiragino Mincho ProN`→`SimSun`、`STKaiti`→`KaiTi`… 这是"跨机器打开不跑版"的核心。
3. **东亚字体识别**：`EA_FONTS` 集合（`:60-93`）含 60+ 家族（含 `DengXian`、`MingLiU`、`Yu Gothic`、`Malgun Gothic`）。
4. **通用族**：`GENERIC_FONT_MAP`（`:152-158`）把 `sans-serif/serif/monospace` 映射到具体族；`SYSTEM_FONTS`（`:94`）单独标记。
5. **每 run 按脚本选槽**：`resolve_text_run_fonts`（`:3645-3656`）对文本做脚本分类，CJK 走 `ea`，其余走 `latin`，RTL 走 `cs`。
6. **主题字体提升**（可选）：当项目锁定 `theme_font_spec` 且家族匹配时，`typeface` 写成 `+mj-lt`/`+mn-lt`（`DM/theme_fonts.py`），让 PPT 主题切换时文本跟着变。
7. **不安全的导出字体**：`unsafe_exported_font_faces`（`:3290-3298`）在字体无法嵌入/无对应时给出告警（配合 `S/pptx_embedded_fonts.py` 的 `EmbeddedFontError`）。

### 3.3 宽度测量（决定 frame 宽度的地方）

两级策略（`DM/utils.py:3763-3797`）：

**A. 有捆绑度量表时**：`get_font_advances(family, weight, style)` 读 `DM/font_advances.json`（`:3739-3760`），按 `regular|bold|italic|bold-italic` 四态取每字符 advance（em 比例），再乘 `font_size`。仅在**非 CJK、非 emoji、非组合符**时启用（`:3777-3782`）。

**B. 无度量表的回退**（`:3685-3708`）：

| 字符类 | 宽度（em） |
|---|---|
| 全角形式（U+FF00–FFEF 且 East Asian Width = H） | 0.5 |
| CJK（`is_cjk_char`） | 1.0 |
| 普通空格 | 0.3 |
| 固定宽空格表（em space 1.0、thin 0.2、hair 0.1…） | 查表（`:3658-3669`） |
| `mMwWOQ%` | 0.75 |
| `iIlj!|` | 0.3 |
| 数字 | 0.55（注释解释了为什么不能归入窄字符：LibreOffice 会忽略 `wrap="none"` 而换行） |
| 其它 | 0.55 |

**C. 簇（grapheme cluster）级修正**：`split_project_text_clusters`（`:3589-3644`）处理 ZWJ emoji、区域指示符（国旗）、virama（印度语系连写）、组合符；emoji 簇按 1em 计（`:3717-3721`），间距类组合符（`Mc`）额外 +0.3em（`:3724-3727`）。粗体非 CJK 再 ×1.05（`:3796`）。

**D. 头部余量（headroom）**（`DM/elements.py:2066-2069`）：

```python
_TEXT_WIDTH_HEADROOM_BASE = 1.06      # sans
_TEXT_WIDTH_HEADROOM_CAPS = 1.12      # 全大写时
_SERIF_TEXT_WIDTH_HEADROOM_BASE = 1.12
_SERIF_TEXT_WIDTH_HEADROOM_CAPS = 1.36
```

再按字号做插值（`_estimate_run_width_with_headroom`，`:2187-2237`）。这套系数是"经验调出来的"，目的是让 PowerPoint 用**自己的**字体渲染时不至于比估计更宽而换行。

### 3.4 基线数学（最有价值的一段）

SVG 的 `y` 是**基线**，DrawingML 的 `a:off.y` 是**框顶**，中间差一个"首行基线偏移"。PowerPoint 的算法依赖字体 ascent/descent，所以项目捆绑了 `DM/font_metrics.json` 并自己算（`DM/text_baseline.py:67-127`）。

```python
# 1) 取字体度量：优先 typo 度量，若 fsSelection 的 bit7(128) 置位则用 win 度量
source = 'typo' if metrics['fsSelection'] & 128 else 'win'          # :57
ascent, descent = metrics[source][:2]
ratio = Fraction(ascent, ascent + abs(descent))                      # :59

# 2) 每 run 取最大 ascent/descent（不同字号混排取包络）
ascent  = max(ascent,  size * ratio)                                 # :102
descent = max(descent, size * (1 - ratio))                           # :103

# 3) 自然行高固定为 1.2em（PowerPoint 的行距基数）
natural_height = Fraction(6, 5) * largest_size                       # :108
baseline = natural_height * ascent / (ascent + descent)              # :109

# 4) 有显式行距时改走另一支
if line_spacing_px is not None or line_spacing_ratio != 1.0:
    spacing = natural_height * ratio_spacing                         # :111
    if line_spacing_px is not None:
        spacing = Fraction(round(line_spacing_px * 75), 100)         # :113
        spacing = Fraction(_whole_points(spacing))                   # :117 ← 先round到整pt
    minimum_baseline = Fraction(3, 4) * spacing                      # :118
    baseline = max(minimum_baseline, spacing - (natural_height - baseline)) \
               if spacing <= natural_height else minimum_baseline    # :119-122

# 5) 结果 round 到整 pt，再换回 px（1pt = 4/3 px）
return float(_whole_points(baseline) * Fraction(4, 3))               # :127
```

三个工程细节值得抄：

- **全程 `Fraction` 有理数**，避免 0.5pt 边界上的浮点抖动；`_whole_points` 用 `+1/2` 后整除实现 round-half-up（`:62-64`），明确不走 Python 的 banker's rounding。
- **整点取整**：PowerPoint 的"兼容布局"会把首行偏移对齐到整 pt，所以先量化再反算 px（`:124-127`）。
- **无度量字体固定 4/5**（`:55-56`），保证未知字体也稳定，而不是崩溃。

`first_line_ascent` 随后用于 `box_y = y - first_line_ascent`（`DM/elements.py:3458`），这就是"SVG 基线 → DrawingML 框顶"的唯一转换点。

### 3.5 框几何与对齐

```python
padding = clamp(0.5px, 2.0px, font_size * 0.04)        # :3446, :2628-2633

text_width  = max(各视觉行宽度)  或  (_estimate_text_runs_width)      # :3351-3385
text_height = 首行前的 spcBef 之和 + Σ(行推进) + 末行 1.5em           # :3358-3383

box_x = x - text_width/2 - padding   (middle)                        # :3451-3456
box_y = y - first_line_ascent                                        # :3458
box_w = text_width + padding*2                                       # :3459
box_h = text_height + padding                                        # :3460  ← 只加一次
ext_cx = drawingml_text_frame_width_emu(text_width, font_size)        # :3670-3673
```

注意 `box_h` 只加**一次** padding：上边已经通过 `first_line_ascent` 把基线抬到框顶下方，再补一个 padding 会整体下移。

**导入帧的精确路径**：若元素带 `data-pptx-frame`（从 PPTX 导入的逻辑对象），不再"按字形收缩"，而是：

1. `_parse_preset_geometry_metadata` 解出 `(x,y,w,h)` 帧（`:3469-3472`）；
2. 用 anchor 与基线反解 `lIns/tIns/rIns`（`:3493-3504`）；
3. `a:bodyPr` 写 `wrap="none|square" lIns tIns rIns bIns="0" anchor="t" anchorCtr="0"` + `<a:noAutofit/>`（`:3695-3701`）。

这样导入的文本框位置**逐像素保持**，同时仍是可编辑的普通文本——这是"往返保真"的关键设计。

**旋转补偿**：`rotate(a cx cy)` 的枢轴若不在框中心，先算旋转后的中心落点再反推 `box_x/box_y`（`:3545-3575`）。否则竖排 y 轴标签会飞到别处——注释里直接举了这个例子。

### 3.6 段落 / tspan / 换行策略

三种 `text_flow`（`DM/context.py:19-46`）：

| 模式 | 触发 | 行为 |
|---|---|---|
| `preserve`（默认） | — | 每个视觉行一个 `<a:p>` 或用 `<a:br/>` 保留作者断行；`spAutoFit` |
| `reflow` | `--text-flow reflow` / 旧 `merge_paragraphs=True` | 合并为一段，交给 PowerPoint 按框宽换行；`noAutofit` |
| `split` | `--text-flow split` / `merge_paragraphs=False` | 每个视觉行独立 text frame |

段落模式的触发条件是 `data-paragraph-line-height` 存在（`:3244-3258`）。此时逐 `<tspan>` 收集，并按 tspan 上的三个标记决定结构：

```python
soft_break = child.get('data-paragraph-soft-break') == '1'    # :3277
line_break = child.get('data-paragraph-line-break') == '1'    # :3278
space_before = child.get('data-paragraph-space-before')        # :3309
```

`soft_break`（宽度不足导致的软换行）会**合并回上一段**，并有一个很讲究的规则：若断点两侧任一侧是 CJK，则**不插入连接空格**；否则补一个空格（`:3282-3306`）。这是中英混排文档的常见坑，代码直接给出了判据：

```python
boundary_is_cjk = (prev_text and is_cjk_char(prev_text[-1])) or \
                  (next_text and is_cjk_char(next_text[0]))
if prev and not prev_text.endswith(' ') and not next_text.startswith(' ') \
        and not boundary_is_cjk:
    prev.append({**prev[-1], 'text': ' ', 'letter_spacing': 0.0})
```

行距与段前距：

```python
line_spc_val = round(line_height_px * 75)                              # :3618 → 1/100 pt
ln_spc_xml = f'<a:lnSpc><a:spcPts val="{line_spc_val}"/></a:lnSpc>'    # :3619
spc_bef_val = round(extra_px * 75)                                     # :3624
```

**含公式的段落会刻意丢掉 `lnSpc`**（`:3631-3635`）——因为 OMML 的垂直度量与 `spcPts` 冲突。

### 3.7 CJK 专项

| 关注点 | 处理 | 证据 |
|---|---|---|
| 字符判定 | `is_cjk_char` 覆盖 Han / Hiragana / Katakana / Hangul 及扩展区 | `DM/utils.py:3299-3358` |
| 宽度 | CJK 记 1.0em（等宽方块字） | `:3691-3692` |
| 字体槽 | CJK 字符走 `ea` 槽，避免 PowerPoint 用拉丁字体回退 | `:3645-3656`、`text_baseline.py:95` |
| 换行连接 | CJK 边界不补空格 | `DM/elements.py:3290-3306` |
| 字体回退 | `PingFang/Noto/宋体/黑体` 全量映射到 Windows 常见字体 | `:97-150` |
| 语言标记 | 按字符脚本推断 BCP-47（`zh-CN/ja-JP/ko-KR`），或使用 `primary_language` | `:3411-3516` |
| 基线 | 中文行高按 1.2em + 字体 ascent 比例，跨字体取包络 | `text_baseline.py:83-109` |

### 3.8 溢出与 autofit

- **默认（`preserve`）**：`wrap="none"` + `<a:spAutoFit/>`（`:3725-3728`）→ PowerPoint 把**框**撑到文本大小。因此框宽只是"渲染前的估计"，最终尺寸由 PowerPoint 决定；这也是为什么宽度估计允许有 headroom 误差。
- **`reflow`**：`wrap="square"` + `noAutofit`，框宽固定为估计宽度，作为换行约束（`:3707-3718`）。
- **占位符载体**（`data-pptx-carrier="true"`）：强制 `noAutofit`，即使 preserve 模式也不撑框（`:3711-3718`）。
- **导入精确帧**：`noAutofit`（`:3700`）。
- **溢出检测不在转换器内**：由 `S/svg_quality_checker.py` 做"单行宽度 vs 最近框"的水平容量门禁（`DOC/svg-pipeline.md:252-262`），垂直换行不建模。转换器内只有 `validate_text_run_advances`（`DM/elements.py:2364-2380`）与"负字距导致非正 ext"的硬错误（`:3676-3680`）。

---

## 4. 图表 / 表格 / 公式

三者共用**一套标记协议**，但生成器完全独立（`NO/` 下 11 个模块，合计约 8,000 行）。

### 4.1 标记协议（authoring interface）

**唯一入口**：一个 `<g>` 元素，带 `data-pptx-replace-with`：

```xml
<g id="chart-revenue" data-pptx-replace-with="chart"
   data-pptx-native-authority="json">
  <metadata type="application/json">
    {"kind":"column","categories":["Q1","Q2"],"series":[…],
     "x":120,"y":160,"width":720,"height":360}
  </metadata>
  <!-- 下面是 SVG 视觉回退（fallback），必须与 JSON 数值一致 -->
  <rect …/><text>Q1</text>…
</g>
```

规则（全部有代码强制）：

| 规则 | 说明 | 证据 |
|---|---|---|
| 必须是 `<g>` | 非 g → `RuntimeError("Native PPTX replacement markers must be <g> elements")` | `NO/__init__.py:574-575` |
| kind 白名单 | `_NATIVE_KINDS`；`convert_native_object` 分支为 `formula` / `table` / `chart` | `NO/__init__.py:572-573`、`:759`、`:777`、`:786` |
| 载荷来源二选一 | `data-pptx-json`（或兼容 `data-pptx-data`）**或** 子 `<metadata type="application/json">` | `NO/marker_common.py:1034-1042` |
| JSON 必须是对象 | 非 dict → 报错；解析失败带 `exc.msg` | `:1051-1058` |
| bounds | 载荷 `x/y/width/height`，或组上 `data-pptx-x/…`，或从 fallback 几何推断；JSON-authoritative 时四值必填 | `NO/marker_common.py:979-1032`、`NO/__init__.py:584-593`、`DOC/native-data.md:17` |
| 旧拼写兼容 | `data-pptx-native`（=replace-with）、`data-pptx-kind`、`data-pptx-native-source`… 冲突即报错，并用 stderr 警告提示迁移 | `NO/marker_attributes.py:9-19`、`:26-50`、`:139-189` |
| fallback 新鲜度 | 激活 `chart/table` 时对 fallback 子树做哈希快照，JSON 改过但 SVG 没重绘 → 拒绝导出 | `NO/fallback_hash.py`、`DM/converter.py:2166-2173`、`NO/__init__.py:577-578` |

最后一条是这个设计里最"产品化"的一环：**它把"预览与数据必须一致"做成了可执行的契约**，而不是文档约定。

### 4.2 表格：`ppt-master.semantic-table.v2`

载荷骨架（`DOC/native-data.md:20-28`）：

```json
{
  "schema": "ppt-master.semantic-table.v2",
  "columns": ["指标", "2024", "2025"],          // 表头行（可选）
  "rows": [["营收", "1.2M", "1.8M"], …],
  "column_widths": [2,1,1], "row_heights": [1,1,1],
  "header_rows": 1, "strict_grid": false,
  "defaults": {"cell": {…}, "paragraph": {…}, "run": {…}},
  "cell_styles": {"kpi": {"bold": true, "color": "#B91C1C"}},
  "style": {"font_family":"…","font_size":18,"header_fill":"#1F2937",
            "band_row": true, "border_color":"#E5E7EB", …}
}
```

校验（`NO/table.py:632-656`）：

```python
payload = expand_semantic_table_payload(payload)     # v2 → 稠密矩形
col_count = _validate_table_lengths(payload, rows)   # 矩形化，短行补 ""
merge_layout = _resolve_table_merge_layout(...)      # row_span/col_span → 区域
_table_header_rows(payload, len(rows))
_validate_table_cell_formatting(payload, rows)
```

生成（`NO/table.py:1836-1900`）：`<a:tbl>` + `a:tblGrid/a:gridCol` + 每行 `a:tr` + 每格 `a:tc/a:txBody/a:tcPr`；合并格写 `rowSpan`/`gridSpan`/`hMerge`/`vMerge`（`:1844`、`:1871-1887`）；边框、填充、内边距、锚点分别由 `_table_border_xml`/`_table_fill_xml`/`_table_padding_attrs`/`_table_anchor` 生成（`:1862-1870`）。列宽/行高是**相对权重**，由 `_weighted_lengths` 归一到 `ext_cx/ext_cy`（`:1821-1834`）。

值得注意的两条"防跑版"规则：
- 单元格内边距会按解析出的行高**收缩**（`DOC/native-data.md:22`），否则 PowerPoint 会把行撑高；
- `preserve_source_style`（导入来源）时，缺失的 fill 写 `noFill` 而非默认色（`NO/table.py:1845-1866`）。

### 4.3 图表：两条 XML 家族

| 家族 | 命名空间 | 模块 | 支持类型 |
|---|---|---|---|
| Classic | `c:`（drawingml/2006/chart） | `chart_data.py`、`chart_xml.py`、`chart_style.py`、`workbook.py` | column/bar/line/area/pie/doughnut/pieOfPie/barOfPie/radar/scatter/bubble/combo/stock |
| ChartEx | `cx:`（office/drawing/2014/chartex） | `chartex.py` | treemap/sunburst/histogram/pareto/waterfall/funnel/boxWhisker |

URI/关系类型/Content-Type 常量在 `NO/marker_common.py:39-50`。类型清单与字段在 `DOC/native-data.md:32-43`（极详尽，逐字段列出 `gap_width`、`overlap`、`data_labels.position` 的合法值等）。

处理链（`NO/__init__.py:606-634`）：

```python
source_package = _decode_source_chart_package(payload)      # 导入往返：原样恢复
if source_package is None:
    chart_data = _chart_data(payload)                       # 归一化（类型/序列/轴/样式）
    _chart_plot_area_layout(chart_data, bounds)              # c:manualLayout
    _validate_chart_companion_boxes(payload, chart_bounds=…, include_title=…)
    if validate_chrome and native_import_source(elem) != "pptx":
        chrome_errors = _native_chart_chrome_errors(elem, payload)   # SVG-first 一致性
```

**"source_package" 往返**（`:121-200`）：导入的图表把原始 `ppt/charts/chartN.xml` + workbook + 样式/颜色部件以 base64 + sha256 打包进 JSON，导出时**逐字节还原**，只重写关系目标。硬防线：部件数 ≤32、总大小 ≤20 MB、路径必须落在 `ppt/charts|ppt/embeddings|ppt/theme`、禁止 `\`、禁止 `..`、禁止绝对路径（`:155-194`）。

**部件号分配**：`PackagePartRegistry`（`S/pptx_ooxml/package.py:36-80`）先 `reserve_source()` 占住模板/源包所有名字，再 `next_index()` 找第一个空号；`register()` 遇冲突直接报错并指出双方 owner（`NO/__init__.py` 的 `reserve_source_chart_parts` 在转换前调用，`DM/converter.py:2456-2457`）。

**内嵌工作簿**：`NO/workbook.py` 生成最小 xlsx（sheet + 缓存 `<c:numCache>`），PowerPoint 打开图表时可"编辑数据"。

### 4.4 公式：LaTeX 子集 → OMML

- 载荷：`data-pptx-replace-with="formula"` + JSON（`latex`、字号、颜色、对齐…），由 `FormulaSpec` 承载（`NO/formula.py:44`）。
- 解析：`formula_parser.py`（2181 行）做 tokenizer + 递归下降，产出 AST（`formula_ast.py`，592 行）；支持分式、根式、上下标、求和/积分、矩阵、重音、定界符等（`formula_profile.py` 定义"允许的构造集合"）。
- 生成：`formula_omml.py`（1049 行）输出 `<m:oMath>`；`formula_run_properties.py` 保证 run 级字体（`Cambria Math`）。
- **行内公式**：`tspan data-pptx-inline-formula="…"`（`NO/inline_formula.py:43`），在文本流里嵌入 `a14:m`，并按 MCE 规范生成"不带数学能力的阅读器"回退副本：

```python
# DM/elements.py:3602-3614
def _runs_xml(line_runs):
    return '\n'.join(
        _build_run_xml(_inline_formula_preview_run(r) if formula_previews else r, …)
        for r in line_runs)
# :3752-3757 整形状包一层 AlternateContent
shape_xml = wrap_inline_formula_shape(shape_xml, _shape_xml(ctx.next_id(), _paragraphs_xml(True)))
```

约束：行内公式所在 run 必须有**单一可见纯色填充**（`:3117-3120`），否则报错——因为 OMML 的 `m:rPr` 无法表达渐变/图片填充。

### 4.5 校验矩阵（谁在什么时候查什么）

| 校验 | 时机 | 位置 |
|---|---|---|
| marker 属性别名冲突 | 转换前（整树扫描） | `DM/converter.py:2137`、`NO/marker_attributes.py:41-49` |
| marker 状态（是否已废弃/占位） | 转换前 | `NO/marker_status.py` |
| JSON schema / 类型 / 取值范围 | 转换前 | `NO/__init__.py:580-637` |
| fallback 新鲜度哈希 | 转换前快照 + 使用时比对 | `DM/converter.py:2166-2173`、`NO/__init__.py:577-578` |
| SVG-first 视觉一致性（文字/颜色/标签） | 导出时（warnings） + `svg_quality_checker`（errors） | `NO/chart_style.py` 的 `_native_chart_chrome_*` |
| 包级（部件冲突、Content-Type、关系悬空） | 打包后 | `PKG/builder.py:8603-8688` |

---

## 5. 分组 / z 序 / 命名

### 5.1 `<p:grpSp>` 的生成与"恒等映射"

`convert_g`（`DM/converter.py:1204-1530`）只在**需要**时建组，产出骨架：

```xml
<p:grpSp>
  <p:nvGrpSpPr><p:cNvPr id="{group_id}" name="{…}"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
  <p:grpSpPr>
    <a:xfrm{rot_attr}>
      <a:off x="{off_x}" y="{off_y}"/><a:ext cx="{group_w}" cy="{group_h}"/>
      <a:chOff x="{group_x}" y="{group_y}"/><a:chExt cx="{group_w}" cy="{group_h}"/>
    </a:xfrm>
    {group_effect}
  </p:grpSpPr>
  {子形状 XML}
</p:grpSp>
```

关键设计：**`chOff == off`、`chExt == ext`**（注释 `:1210-1211`）。这样一来子形状的绝对坐标**不需要重写**，组只是"选择/动画的容器"。代价是组框必须由子元素的 `bounds_emu` 求并集得到：

```python
for child_result in child_results:
    b = child_result.bounds_emu
    min_x = min(min_x, b[0]); … max_y = max(max_y, b[3])        # :1442-1449
group_w = max(int(max_x - min_x), 1)                             # :1456-1457
```

这就是 `ShapeResult.bounds_emu` 存在的唯一理由——**为父组提供几何**。

### 5.2 折叠规则（什么时候不建组）

```python
if (len(child_results) == 1
    and (matrix_supported or not angle_deg)       # 矩阵或纯平移
    and not explicit_native_group                 # data-pptx-object="group"
    and (not should_animate_group
         or logical_native_shape_group            # 导入的预设形状
         or logical_picture_effect_group)):       # 图片特效载体
    return _restore_placeholder_sp_pr(child_results[0], elem)     # :1418-1435
```

四类"必须保组"的例外，每类都有实际理由：

| 例外 | 理由 |
|---|---|
| `matrix_supported` 为假但 `angle_deg` 非 0 | 需要组承载 `rot`（子元素无法各自绕组枢轴旋转） |
| `explicit_native_group`（`data-pptx-object="group"`） | 导入的组必须保持组，否则往返丢结构 |
| `should_animate_group` 且非"逻辑单形状/图片特效" | 动画要打在组上，共享一个时间轴 |
| 逻辑预设形状 / 图片特效载体 | 组只是导入时的运输容器，展平后仍是**一个** `p:sp`，展平能避免"一个源形状变成组" |

`logical_native_shape_group` 的判定（`:1406-1412`）是"`data-pptx-object ∈ {shape,connector}` 且带 `data-pptx-prst` 或 `geometry-kind=custom`"——即"这个组代表一个 PPT 形状"。注释（`:1401-1405`）写得很清楚：展平后要把动画目标**重定向到叶子 shape id**，否则动画指向不存在的组。

### 5.3 旋转枢轴补偿

两种情形分开处理：

**A. 矩阵路径**（`matrix_supported`）：把 `parse_transform_matrix(transform)` 下推给子上下文（`:1284-1291`），组自身 `rot=0`（`:1509` 用 `0 if matrix_supported`）。每个子元素在自己的 xfrm 里体现旋转/翻转。

**B. 枢轴路径**（纯 `rotate(a cx cy)`，子元素不吃矩阵）：子上下文 `dx=dy=0`（`:1292-1298`），组 `rot=a`，然后**把"绕 SVG 枢轴旋转"与"绕 bbox 中心旋转"的差值折进 `a:off`**：

```python
pivot_ex = (cx_svg + ctx.translate_x) * EMU_PER_PX                 # :1470-1471
bbox_cx  = group_x + group_w / 2
delta_x  = (bbox_cx - pivot_ex)*cos_t - (bbox_cy - pivot_ey)*sin_t + pivot_ex - bbox_cx
off_x    = int(round(group_x + delta_x))                            # :1479-1482
```

`chOff` 保持未偏移的 bbox（`:1524`），因为子元素仍在原 SVG 坐标。这段数学是"PPT 里旋转对象总是绕自身中心"这一限制的通用解法，**任何移植都值得照抄**。

### 5.4 命名

`shape_display_name`（`DM/elements.py:472-483`）四级优先：

```python
for attribute in ('data-pptx-shape-name', 'id', 'data-name'):
    value = (elem.get(attribute) or '').strip()
    if value: return value
return fallback          # f'Rectangle {id}' / f'TextBox {id}' / f'Group {id}' / f'Image {id}' / f'Line {id}'
```

设计意图写在 docstring 里（`:473-478`）：

> `data-pptx-shape-name` wins, then the SVG `id` (or `data-name`), so the Selection and Animation panes show `p08-rail-edge` rather than `Freeform 9`; unnamed objects keep the positional fallback.

这就是"作者意图可延续"的具体落地：**SVG 的 `id` 直接变成 PowerPoint 的对象名**，后续动画、Morph（`!!` 前缀）、选择窗格都按这个名字工作。对 dsh-ppt 的启发是：**生成端必须为每个语义块写稳定 id**，否则导出的 PPT 无法被脚本二次定位。

### 5.5 z 序与动画目标

- **z 序 = 文档序**。`for child in root:` 顺序 `shapes.append(result.xml)`（`:2481-2493`），`defs` 跳过（`:2483-2484`），被提升为背景的那个首层 rect 跳过（`:2485-2486`）。
- **没有"z-index"概念**，也不排序；这是 SVG 语义的直接映射，正确且可预测。
- **动画目标**在 z 序上收集（`ctx.anim_targets` 是 list），条件（`:1250-1255`）：

```python
should_animate_group = (
    ctx.depth == 0                                  # 只取根层
    and elem_id                                     # 必须有 id
    and (not is_chrome or elem_id in ctx.animation_group_overrides)
    and elem.get('data-pptx-layer') is None          # master/layout 层不可动画
)
```

- **无 `<g>` 时的降级**：若根层没有组、也没有 anim_targets，且顶层图元数量 ≤8（`_ANIM_FALLBACK_CAP`，`:2535`），则把顶层图元当作动画目标（`:2536-2541`）。注释解释了为什么限 8：

> Presenter-click animation should reveal semantic blocks, not atomized drawing primitives, so fallback is intentionally capped at a low count.

- **chrome 判定**：显式 `data-pptx-role`/`data-pptx-placeholder` 时用 `is_static_page_frame`，否则退回按 id 命名启发式（`is_chrome_id`，`:1241-1245`）。
- **导入 id 预留**：`reserved_shape_ids` + `claim_shape_id`（`DM/context.py:143-172`）保证"SVG 新元素不会抢走原生连接线引用的 id"，转换结束还会检查 `referenced - claimed` 非空则报错（`DM/converter.py:2520-2527`）。

### 5.6 与 PPTX 结构（master/layout）的关系

组本身只解决"幻灯片内"的层级。跨页共享的结构由 builder 的 `pptx_structure` 参数控制（`PKG/builder.py:6856-6864` docstring）：

| 模式 | 行为 |
|---|---|
| `flat` | 所有内容留在 Slide 本地，生成一个干净的项目自有 Master + Blank Layout |
| `baseline` | 把安全的共享背景与前导 chrome 提升到 Master，再按 page-role 抽 Layout 家族 |
| `structured` | 消费 SVG 里显式的 `data-pptx-layer="master|layout"` / `data-pptx-role` / `data-pptx-placeholder` 元数据 |
| `preserve` | 直接复用导入的源 PPTX 包 |

`data-pptx-layer` 同时是"不可动画"的标记（`converter.py:1254`），语义上一致：**能进 Master/Layout 的东西不属于本页时间轴**。

---

## 6. 数值与健壮性细节（可直接抄的部分）

### 6.1 常量总表

| 常量 | 值 | 位置 | 用途 |
|---|---|---|---|
| `EMU_PER_PX` | 9525 | `DM/utils.py:45` | 坐标唯一换算因子 |
| `FONT_PX_TO_HUNDREDTHS_PT` | 75 | `:46` | 字号 px→1/100pt |
| `DRAWINGML_TEXT_FONT_SIZE_MIN/MAX` | 100 / 400000 | `:47-48` | 字号合法区间（1–4000pt） |
| `ANGLE_UNIT` | 60000 | `:49` | 角度 1/60000° |
| `PPTX_SLIDE_EMU_MIN/MAX` | 914400 / 51206400 | `S2P/canvas_contract.py:17-18` | 页尺寸区间（1in–56in） |
| `THICK_CIRCLE_COVERAGE_TOLERANCE` | 1.0 px | `DM/utils.py:312` | 甜甜圈合并判定容差 |
| `_TEXTBOX_PADDING_MIN/MAX/RATIO` | 0.5 / 2.0 / 0.04 | `DM/elements.py:2051-2053` | 文本框内衬 |
| `_TEXT_WIDTH_HEADROOM_*` | 1.06/1.12（sans），1.12/1.36（serif） | `:2066-2069` | 宽度余量 |
| `_ANIM_FALLBACK_CAP` | 8 | `DM/converter.py:2535` | 无组时的动画目标上限 |
| `_MAX_LOCAL_USE_DEPTH` / `_INSTANCES` | 64 / 10000 | `S2P/use_expander.py:47-48` | `<use>` 展开防爆 |
| `_DRAWINGML_PERCENTAGE_MIN/MAX` | ±2^31 | `DM/elements.py:5245-5246` | 百分比量化边界 |
| 表格行/列上限 | 1000 | `DOC/native-data.md:22` | 语义表规模 |

### 6.2 量化与取整策略

| 量 | 规则 | 位置 |
|---|---|---|
| 坐标 → EMU | `round(px * 9525)`（Python round，偶数舍入） | `DM/utils.py:319-321` |
| 页尺寸 → EMU | `Decimal` 计算 + `ROUND_HALF_UP` | `S2P/canvas_contract.py:46-61` |
| 字号 → 1/100 pt | `int(round(px*75/10))*10`（0.1pt 网格） | `DM/utils.py:335` |
| 角度 → 1/60000° | `round(deg * 60000)`，0 时省略属性 | `:1364-1365` |
| 不透明度 | `quantize_ooxml_alpha`（0..100000） | `:1673-1679` |
| 渐变 stop / 焦点 | `quantize_ooxml_unit_ratio`（0..100000） | `:1664-1672` |
| dash 的 d/sp | `round(d / stroke_width * 100000)`，最小 1 | `DM/styles.py:524-525` |
| 文字宽度输出的几何格式 | 15 位小数去尾零，`-0`→`0` | `DM/utils.py:470-475` |

**两套取整并存**（`round` 与 `ROUND_HALF_UP`）看似不一致，但作用对象不同：元素坐标是浮点近似、页尺寸是契约值，用 Decimal 是为了让 1280×720 这类整数 viewBox **精确**等于 12192000×6858000，而不是 12191999。

### 6.3 校验器清单（`project_*_errors`）

| 校验器 | 检查什么 | 位置 |
|---|---|---|
| `project_geometry_length_errors` | 每个几何属性是否是合法项目长度、非负约束 | `DM/utils.py:1537-1552` |
| `project_transform_errors` | 每个 transform 是否可被标量/矩阵路径表达、是否含 skew | `:1250-1319` |
| `project_stroke_style_errors` | dasharray 数字拼写、cap/join 枚举、`vector-effect` | `:1098-1128` |
| `project_opacity_errors` | 各 opacity 属性是否 unitless/合法百分比 | `:1603-1623` |
| `project_paint_errors` | fill/stroke 涂色语法 | `:1836-1851` |
| `project_paint_reference_errors` | `url(#id)` 是否指向存在的 defs、类型是否匹配 | `:2268-2391` |
| `project_definition_errors` | defs 重复 id、非法子元素 | `:1871-1907` |
| `project_gradient_errors` | 坐标范围、stop 连续性、焦点圆约束 | `:2462-2635` |
| `project_filter_errors` | 原语白名单、参数范围、filter+clip 冲突 | `:2798-2984` |
| `project_mask_errors` | 任何 mask 用法 → 错误 | `:2392-2421` |
| `project_marker_errors` | marker 形状/尺寸可分类性 | `:2042-2222` |
| `project_image_aspect_ratio_errors` | `preserveAspectRatio` 语法 | `:1565-1577` |
| `project_clip_path_errors` | clip-path 只能用于 image、单形状、units | `DM/elements.py:4102-4216` |
| `project_image_errors` | 图片存在性、字节与扩展名一致、正尺寸 | `:416-469` |
| `project_nested_svg_crop_errors` | 嵌套 svg 裁剪属性组合 | `:5457-5492` |
| `project_freeform_geometry_errors` | path/points 数字拼写 | `DM/paths.py:319-337` |
| `project_text_property_errors` | 文本属性白名单/黑名单/声明位置 | `DM/text_properties.py:790` |
| `project_effect_status_errors` | 文本 run 特效与形状特效互斥 | `S/pptx_effects.py` |

统一在 `convert_svg_to_slide_shapes` 里串行调用（`DM/converter.py:240-520` 定义 `_require_*` 包装，`2198-2410` 实际执行），任一非空即组装成一条多行错误抛出——**一次报出所有问题**，而不是遇到第一个就停。

### 6.4 错误类

| 类 | 基类 | 语义 | 位置 |
|---|---|---|---|
| `SvgNativeConversionError` | `RuntimeError` | 单文件转换失败（带文件名前缀） | `DM/converter.py:138-140` |
| `CanvasContractError` | `ValueError` | viewBox/页尺寸不合法 | `S2P/canvas_contract.py:13` |
| `NativeMarkerAttributeError` | `ValueError` | 新旧 marker 属性冲突 | `NO/marker_attributes.py:22` |
| `NativePayloadError` | `ValueError` | 外部 payload 存储损坏/失配 | `S/native_payloads.py:72` |
| `GeometryStyleError` | `ValueError` | 内联几何声明物化失败 | `S2P/geometry_properties.py:41` |
| `ThemeColorError` / `ThemeFontError` | `RuntimeError` | 主题契约不合法 | `DM/theme_colors.py:81`、`theme_fonts.py:34` |
| `FormulaCompileError` | `ValueError` | LaTeX→OMML 失败 | `NO/formula_parser.py:164` |
| `PresetShapeError` | `ValueError` | 预设几何/公式求值失败 | `S/pptx_shapes/errors.py:18` |
| `UseExpansionError` | `ValueError` | `<use>` 无法安全展开 | `S2P/use_expander.py:72` |
| `TemplateStructureError` | `RuntimeError` | master/layout 契约不满足 | `PKG/template_structure.py:179` |
| `PptxPostflightValidationError` | `RuntimeError` | 包级后验失败 | `PKG/cli.py:986` |
| `EmbeddedFontError` | `ValueError` | 字体嵌入失败 | `S/pptx_embedded_fonts.py:33` |

分层的价值在于：**包装层只加"文件名 + 元素标签"，不吞原始异常**（`DM/converter.py:1939-1942` 用 `raise … from e`）。排查时能一路追到 `paths.py` 的 tokenizer。

### 6.5 确定性

- **id 分配**：`id_counter` 单调递增（从 2 起），分配顺序 = 遍历顺序（`DM/context.py:143-152`）。无随机、无时间。
- **rel id**：`rId2` 起（`rId1` 留给 slideLayout，`:90`）。
- **媒体命名**：内容哈希（`_register_image_media`），同一图片多次引用只写一份。
- **字典序**：需要稳定输出的地方显式 `sorted()`（如 trace 的 `adjustments`，`DM/converter.py:1907`）。
- **时间戳**：只在最后一刻写 `docProps/core.xml` 与 `[Content_Types]`（`PKG/builder.py:8614-8627`），不参与内容哈希。
- 结论：**同一输入两次导出，slide XML 逐字节相同**（除 docProps）。这让"重绘差异比较"成为可能——`authoring_roundtrip.py` 正是靠这一点做对象级 diff。

### 6.6 失败模式分层

| 情形 | 行为 | 位置 |
|---|---|---|
| 不可见元素（`display:none` / 空 clip） | **跳过**，记 trace | `DM/converter.py:1923-1930` |
| 退化几何（`w<=0` 的 rect、`r<=0` 的圆） | **返回 None**（静默） | `DM/elements.py:1287`、`:1477` |
| 空文本（非载体） | 返回 None | `:3337-3339` |
| 不支持的标签 | **抛异常** | `DM/converter.py:1961` |
| 不支持的属性/单位/枚举 | **前置校验抛异常** | 见 6.3 |
| 资源缺失（图片不存在） | **抛异常**（不降级为占位） | `DM/elements.py:395-412` |
| 原生对象载荷坏 | **抛异常**（含具体字段） | `NO/marker_common.py:1043-1058` |
| 包级关系悬空 | **抛异常**，理由直接写"PowerPoint will report the file as corrupt" | `PKG/builder.py:8603-8609` |

**没有中间档**：不存在"尽力渲染 + 警告"的路径。这一点与大多数 SVG 转换器（如 CairoSVG/Inkscape 导出）相反，但与"生成可编辑 PPT"的目标一致——半对的原生对象比缺失更糟。

---

## 7. 可直接移植到 TypeScript/Node（pptxgenjs 4.x + fflate）

### 7.1 结论：三层架构，只有中间层能靠 pptxgenjs

pm 的架构本身就是"**骨架包 + 逐页 XML + 重打包**"。在 TS 里最省力且能力最完整的复刻方式不是"全部用 pptxgenjs"，而是：

```
SVG ──parse/measure──▶ IR ──emit──▶ (A) pptxgenjs 调用（能表达的 60%）
                                    (B) rawPatch 列表（表达不了的 40%，带锚点）
                                        └─ fflate: unzip → 应用 patch + 写部件 → rezip
```

理由：pptxgenjs 是"高层 API + 自带序列化"，它**不暴露** `custGeom`、`grpSp`、`p:bg` 渐变、`a:br`、`m:oMath`、`c:chartEx`、`p:timing`、自定义部件写入。任何"先把 SVG 全转成 DrawingML 再塞给 pptxgenjs"的路线都会卡在这些点上。正确做法是**让 pptxgenjs 生成一个合法的空壳，再用字符串/XML patch 精修**——这正是 pm 用 python-pptx 做的事（`PKG/builder.py:7234-7251`）。

### 7.2 逐特性可行性表

难度：**E** 易（纯 API）、**M** 中（算好参数即可）、**H** 难（必须 raw OOXML）。"缺口"列写明 pptxgenjs 缺什么。

| 特性 | 难度 | pptxgenjs 4.x 可表达 | 缺口 / 需要的最小 patch |
|---|---|---|---|
| rect / roundRect / ellipse | E | `addShape(ShapeType.rect\|roundRect\|ellipse, {x,y,w,h,fill,line,rectRadius})` | 圆角只有对称一种；`adj` 需按 `round(r/min(w,h)*100000)` 手算成 `rectRadius`（英寸） |
| 非对称圆角 rect | H | 无 | 替换 `<a:prstGeom>` 为 `<a:custGeom>`（4 段贝塞尔，参数见 `DM/elements.py:1175-1265`） |
| line / connector | E | `addShape(ShapeType.line, {x,y,w,h,line:{color,width,dashType,beginArrowType,endArrowType}})` | 方向靠 `flipH/flipV`；标记尺寸只有预设档 |
| polygon / polyline / path | H | 无 custGeom API | 注入 `<a:custGeom><a:pathLst><a:path w h>…`；SVG path 需先 Q→C、A→C（`DM/paths.py:554-688`） |
| 分组 `<g>` | H | **无 group API** | 把连续 `<p:sp>` 包进 `<p:grpSp>`，补 `nvGrpSpPr` + `xfrm(chOff=off,chExt=ext)` + 重算 bbox（`DM/converter.py:1514-1530`） |
| 文本（单 run） | E | `addText(text, {x,y,w,h,fontFace,fontSize,color,bold,italic,underline,align,valign,charSpacing,lineSpacing,margin,isTextBox,wrap})` | `charSpacing` 单位是 pt，需 `px*0.75`；`margin:0` 才能等价 `lIns=0` |
| 文本（多 run / 混合样式） | M | `addText([{text,options},…])` 支持 run 数组 | run 内的 `letter-spacing` 是否逐 run 生效需实测；`a:ea`/`a:cs` 槽位可能只写 latin+ea |
| `a:br`（段内硬换行） | M | 文本里的 `\n` 生成**新段落** `<a:p>`，不是 `<a:br/>` | 若必须保留"同一段内的软换行"语义，需 patch 把 `<a:p>` 合并并插入 `<a:br/>`（`DM/elements.py:3104-3111`） |
| 首行基线定位 | M | 无直接 API，但**可自己算**：`y_box = y_svg - first_line_ascent`，再 `valign:'t'`, `margin:0` | 需要移植 `text_baseline.ts`（纯函数，无依赖）；否则文本整体偏移 0.1–0.3em |
| 文本框宽度（避免误换行） | M | `w` 由调用方给 | 需移植宽度估计 + headroom（`DM/elements.py:2066-2069`、`:2187`） |
| `text-anchor` | E | `align:'left'\|'center'\|'right'` + 自己算 x | PowerPoint 的 align 是**段内**对齐，框宽必须等于文本宽，否则视觉位置错 |
| 表格 | M | `addTable(rows, {x,y,w,colW,rowH,border,fill,color,fontSize,valign,align})`；4.x 支持 `rowspan`/`colspan` | 逐边框（`a:lnL/lnR/lnT/lnB` 不同色/宽）需 patch `a:tcPr`；banding 需自己算填充 |
| 经典图表 | E–M | `addChart(ChartType.bar\|line\|pie\|area\|scatter\|bubble\|radar\|doughnut, data, opts)`；combo 用多次 `addChart` | 精确 `c:manualLayout`、`gapWidth/overlap`、轴 crossing、数据标签位置 → 部分需 patch chart XML |
| ChartEx（treemap/waterfall/funnel/sunburst/histogram/pareto/boxWhisker） | H | **无** | 必须自建 `ppt/charts/chartExN.xml` + `cx:` 命名空间 + rel + `graphicFrame`；用 fflate 写部件并登记 Content-Type（照 `NO/chartex.py`、`NO/marker_common.py:39-50`） |
| 线性渐变填充 | M | `fill:{type:'gradient', stops:[{color,position}], angle}` | stop 的 alpha、`scaled="1"`、角度方向需核对；复杂方向建议直接 patch `<a:gradFill>` |
| 径向渐变 | H | 无（按 4.x 公开 API 仅线性） | 替换为 `<a:gradFill><a:path path="circle"><a:fillToRect …/>`（`DM/styles.py:138-159`） |
| 渐变描边 | H | 无 | `<a:ln><a:gradFill>…` |
| pattern 填充 | H | 无 | `<a:pattFill prst=… fgClr bgClr>` 或降级为纯色 |
| dash（预设） | E | `line:{dashType:'solid'\|'dash'\|'sysDot'\|'lgDash'\|'lgDashDot'\|…}` | 自定义 dash → patch `<a:custDash>`（`d=round(dash/width*100000)`） |
| linecap / linejoin | M | 无独立选项（部分版本有 `line.cap`） | patch `<a:ln cap="rnd|sq|flat">` + `<a:round/>\|<a:bevel/>\|<a:miter lim="800000"/>` |
| 外阴影 | E | `shadow:{type:'outer', color, blur, offset, angle, opacity}` | 校准：`blurRad ≈ 2×σ`、`alpha ≈ 0.75×`（`DM/styles.py:630-661`），否则视觉偏重 |
| 发光 glow | H | 无 | patch `<a:glow rad=…><a:srgbClr …/></a:glow>` |
| 元素/填充透明度 | E | `fill:{transparency:0-100}`、`line:{transparency}` | 元素级整体透明度（组 alpha）无对应，需逐后代乘（`DM/context.py:103-106`） |
| 图片 | E | `addImage({data\|path, x,y,w,h})` | — |
| `preserveAspectRatio` slice | M | `sizing:{type:'cover', w, h}`（4.x 有 `sizing`） | 精确 `a:srcRect`（四边百分比）需 patch；`meet` 用 `sizing:{type:'contain'}` |
| 图片裁剪为任意形状 | H | 无 | patch `p:spPr`，把 `prstGeom rect` 换成 ellipse/roundRect/custGeom（`DM/elements.py:4217-4314`） |
| 超链接（形状级） | E | `hyperlink:{url}` 或 `{slide:n}` | 页面内跳转的 `#slide-N` 越界校验要自己做 |
| 超链接（run 级） | M | run 选项里 `hyperlink` | 关系 id 与 `a:hlinkClick` 的 `action`/`r:id` 组合需核对 |
| 备注 | E | `addNotes(text)` | — |
| 页面背景（纯色/图片） | E | `slide.background = {color}` / `{data}` | 渐变背景 `p:bg/p:bgPr/a:gradFill` 需 patch |
| 切换 / 动画 | H | **无 API** | patch `p:transition`（必须在 `p:timing` 之前）+ `p:timing`（`PKG/builder.py:7764-7767`） |
| master / layout 家族 | H | `defineSlideMaster` 能力有限 | 建议"自带模板 pptx + 只替换 slide 内容"；或 patch `ppt/slideLayouts/*` |
| 原生图表部件 / 内嵌 xlsx | H | 无 | fflate 写 `ppt/charts/*`、`ppt/embeddings/*` + 改 `[Content_Types].xml` + slide rels（`NO/workbook.py`、`S/pptx_ooxml/package.py`） |
| OMML 公式 | H | 无 | patch `a:p`，插入 `<a14:m><m:oMath>…` + MCE `AlternateContent` 回退（`DM/elements.py:3602-3614`） |
| 形状名（objectName） | E | `objectName`（4.x） | 名称优先链：`data-pptx-shape-name > id > data-name`（`DM/elements.py:472-483`） |
| z 序 | E | 调用顺序即 z 序 | 与 SVG 文档序一致，不要额外排序 |
| 旋转（绕中心） | E | `rotate`（度） | 绕 SVG 枢轴旋转需自己做位移补偿（`DM/converter.py:1459-1482`） |

**统计**：约 60% 的特性可由 pptxgenjs 直接表达（E/M），40% 必须 raw patch（H）。其中"必须 patch 否则功能缺失"的硬需求是：**custGeom、grpSp、custDash/cap/join、径向渐变、ChartEx、OMML、transition/timing、任意形状裁剪**。

### 7.3 必须走后处理的 8 类（含锚点策略）

**锚点问题**：直接 `String.replace('</p:spPr>', …)` 会命中第一个形状——不可用。可行做法是**用唯一名字定位**：

1. 生成时给每个要 patch 的形状一个唯一 `objectName`（`svg-<page>-<id>`）；
2. 后处理时用 `indexOf('name="svg-p03-title"')` 找到 `<p:cNvPr>`；
3. 从其位置向后搜索最近的 `</p:spPr>`（XML 是良构的，`p:spPr` 内不会嵌套同名标签）；
4. 在该处插入/替换。

```ts
function patchShape(slideXml: string, objectName: string, fn: (spPr: string) => string) {
  const at = slideXml.indexOf(`name="${objectName}"`);
  if (at < 0) throw new Error(`shape ${objectName} not found`);
  const start = slideXml.indexOf('<p:spPr>', at);
  const end = slideXml.indexOf('</p:spPr>', start) + '</p:spPr>'.length;
  const block = slideXml.slice(start, end);
  return slideXml.slice(0, start) + fn(block) + slideXml.slice(end);
}
```

八类 patch 及其最小内容：

| # | 类别 | 替换/插入内容 | 参考实现 |
|---|---|---|---|
| 1 | **custGeom 几何** | `<a:prstGeom …/>` → `<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="r" b="b"/><a:pathLst><a:path w="W" h="H"><a:moveTo><a:pt x y/></a:moveTo><a:lnTo…/><a:cubicBezTo…/><a:close/></a:path></a:pathLst></a:custGeom>` | `DM/elements.py:1038-1265`、`DM/paths.py:784` |
| 2 | **grpSp 包装** | 在 `p:spTree` 内把 N 个 `<p:sp>` 用 `<p:grpSp>` 包起来，`off/ext` 取并集，`chOff=off`,`chExt=ext` | `DM/converter.py:1514-1530` |
| 3 | **描边增强** | `<a:ln>` 加 `cap=`、`<a:round/>`、`<a:custDash><a:ds d sp/></a:custDash>`、`<a:headEnd type= w= len=/>` | `DM/styles.py:494-583` |
| 4 | **径向渐变 / 渐变描边** | `<a:gradFill><a:gsLst>…</a:gsLst><a:path path="circle"><a:fillToRect l t r b/></a:path></a:gradFill>` | `DM/styles.py:44-161` |
| 5 | **图片裁剪几何** | `p:spPr` 内 `prstGeom rect` → `ellipse/roundRect/custGeom` | `DM/elements.py:4217-4314` |
| 6 | **OMML** | 在 `a:p` 中插入 `<a14:m><m:oMathPara><m:oMath>…</m:oMath></m:oMathPara></a14:m>`，并包 `mc:AlternateContent` 回退 | `NO/formula_omml.py`、`DM/elements.py:3752-3757` |
| 7 | **ChartEx / 原生部件** | fflate 写 `ppt/charts/chartEx1.xml`、`ppt/embeddings/Microsoft_Excel_Sheet1.xlsx`、改 `[Content_Types].xml`、slide `.rels` 加 `chartEx` 关系、slide XML 加 `<p:graphicFrame>` | `NO/chartex.py`、`NO/workbook.py`、`S/pptx_ooxml/package.py:36-140` |
| 8 | **切换 / 动画** | `</p:sld>` 前插 `<p:transition>`，再插 `<p:timing>`（顺序不可换） | `PKG/builder.py:7781-7800`、`S2P/animation_config.py` |

### 7.4 建议的 TS 模块切分（与 pm 一一对应）

```
src/svg2pptx/
  units.ts        // EMU_PER_PX=9525, FONT_PX_TO_HPT=75, ANGLE=60000, pxToEmu, pxToHpt
  length.ts       // parseSvgLength（%,px,pt,pc,in,cm,mm,q,em）, parseProjectGeometryLength
  transform.ts    // parseTransformMatrix, multiply, transformPoint, rectToXfrm（含 flipH）
  ir.ts           // type ShapeIR = RectIR|EllipseIR|LineIR|PathIR|TextIR|ImageIR|GroupIR|NativeIR
  parse.ts        // XML → IR（等价 DM/converter.ts + DM/elements.ts）
  measure/fonts.ts     // 字体回退表 + advance 表（font_advances.json 可直接复用）
  measure/clusters.ts  // grapheme/virama/emoji/CJK 判定
  measure/baseline.ts  // 基线反算（text_baseline.py 的逐行翻译）
  measure/width.ts     // headroom 插值 + 逐 run 宽度
  emit/pptxgen.ts      // IR → pptxgenjs 调用
  emit/rawPatch.ts     // IR → RawPatch[]（{shapeName, kind, payload}）
  patch/slide.ts       // patchShape / patchBackground / patchGroup
  patch/parts.ts       // fflate 写 chart/workbook/media + Content_Types + rels
  patch/timing.ts      // transition/timing
  pack.ts              // unzip → patch → rezip（fflate zipSync）
```

关键接口（建议签名）：

```ts
export interface ConversionResult {
  slideXmlPatches: RawPatch[];          // 由 patch/* 消费
  packageParts: Record<string, Uint8Array>;   // chart/xlsx/…（fflate 直写）
  contentTypeOverrides: Record<string, string>;
  rels: RelEntry[];
  animTargets: Array<{ shapeId: number; svgId: string }>;
  diagnostics: TraceEvent[];
}
```

这套签名与 pm 的 6 元组（§1.6）**一一对应**，只是把 `slide_xml` 换成"生成 + patch"两步。好处是：IR/测量/生成三段都能单测，唯一难点集中在 `patch/`。

### 7.5 单位与精度坑（逐条）

1. **EMU 必须是整数**：`Math.round(px * 9525)`。不要 `| 0`（截断会让 1px 的元素变 0）。
2. **字号网格**：`Math.round(px * 0.75 * 10) / 10 * 100` → 1/100pt 整数；否则相邻 run 无法合并，也会在 0.5pt 边界抖动。
3. **`spcPts`/`spcBef` 是 1/100 pt**：`Math.round(px * 75)`，不是 `*100`。这是最容易错的一个换算。
4. **`a:xfrm rot` 是 1/60000 度**，且 `rot=0` 时**省略属性**（pm 这么做，减少 diff 噪声）。
5. **角度方向**：SVG 与 DrawingML 都是屏幕坐标（y 向下、顺时针正），可直接 `atan2(dy,dx)`，无需取反（`DM/styles.py:610-621` 注释专门说明）。
6. **`flipH/flipV` 与负缩放**：当矩阵行列式为负时用 flip，而不是负的 `ext`（DrawingML 不接受负 ext）。
7. **图片 `a:srcRect` 是千分比**（0..100000），四边分别写 `l/t/r/b`；`slice` 的可见比例 = `1-(l+r)/100000`（`DM/elements.py:5013-5017`）。
8. **`xml:space="preserve"`**：首尾空格/双空格时必须写，否则 PowerPoint 吃掉空格。
9. **`p:cNvPr id` 必须唯一且 > 0**；每页独立编号，组也要占号（pm 用 `id_counter` 从 2 起，1 给 spTree）。
10. **关系 id**：`rId1` 通常被 slideLayout 占用；图片/超链接/图表从 `rId2` 起（`DM/context.py:90`）。
11. **Content-Type**：新增部件必须在 `[Content_Types].xml` 加 `<Override PartName=… ContentType=…>`，否则 PowerPoint 报"需要修复"。
12. **关系完整性**：删/改部件后必须保证没有悬空 rel——pm 在打包后专门跑 `verify_internal_relationships`（`PKG/builder.py:8603`），否则用户看到"文件已损坏"。

### 7.6 验证策略

1. **结构验证**：`fflate.unzipSync` → `XMLParser` 解析每个 `ppt/slides/*.xml`，断言能 parse、关键节点存在。
2. **回读验证**：用 python-pptx（或 `pptxgenjs` 读不回来，改用 LibreOffice）打开生成的 pptx，检查 slide 数、形状数、文本内容。
   - 本机已有 `office-pptx` / `office-render` 能力（LibreOffice Kit），可直接渲染成图做像素比对。
3. **往返验证**：dsh-ppt 若做"SVP→PPTX→SVG"闭环，可用 pm 的 `authoring_roundtrip` 思路：导出前后对 slide XML 做规范化 diff（忽略 `docProps`），只允许白名单差异。
4. **回归基线**：把每个特性的最小 SVG 存成 fixture，导出后对**规范化 XML**做快照（同 §6.5 的确定性保证）。

---

## 8. dsh-ppt 应当吸收的 Top 10 技术

排序依据 **价值/成本**（价值、成本均 1–5 分；比值降序）。每条给出机制、最小实现（文件/函数级）、以及在 dsh-ppt（pptxgenjs 4.x + fflate）里的落点。

---

### ① 首行基线反算（V5 / C1 = 5.0）

**机制**：SVG 的 `y` 是基线，DrawingML 的 `off.y` 是框顶。差值不是"字号的一半"，而是字体 `ascent/(ascent+descent)` 与 PowerPoint 1.2em 行高共同决定。pm 用捆绑的 `font_metrics.json` 精确反算，并对整点取整。

**最小实现**（`src/svg2pptx/measure/baseline.ts`）：

```ts
export function firstBaselineOffset(
  runs: Run[], defaultSize: number, metrics: FontMetricsTable, lineSpacingPx?: number,
): number {
  let ascent = 0, descent = 0, largest = 0;
  for (const r of runs) {                        // 只看第一视觉行
    if (r.lineBreak) break;
    const size = r.fontSize ?? defaultSize;      // 已量化到 0.1pt
    const { a, d } = metrics.ratio(r.family, r.weight, r.style);  // Fraction → number
    ascent  = Math.max(ascent,  size * a);
    descent = Math.max(descent, size * (1 - a));
    largest = Math.max(largest, size);
  }
  if (!largest) return 0;
  const natural = 1.2 * largest;                 // PowerPoint 行高基数 = 6/5
  let baseline = natural * ascent / (ascent + descent);
  if (lineSpacingPx != null) {
    const spacing = Math.round(Math.round(lineSpacingPx * 0.75));  // 先整 pt
    const minB = 0.75 * spacing;
    baseline = spacing <= natural ? Math.max(minB, spacing - (natural - baseline)) : minB;
  }
  return Math.round(baseline) * 4 / 3;           // 整 pt → px
}
```

**要点**：全程用整数/Fraction 等价物（TS 可用 `bigint` 分子分母或"先乘 1000 取整"），**不要**直接用 `number` 做多次除法——0.5pt 边界会抖。度量表可直接从 pm 的 `DM/font_metrics.json` 转 JSON 复用（注意许可证，见 `S/pptx_shapes/data/NOTICE.md`）。

---

### ② 单位与量化层（V4 / C1 = 4.0）

**机制**：所有换算集中在 4 个常量 + 3 个函数，任何地方不再手写 `* 9525`。字号量化到 0.1pt 网格，角度量化到 1/60000°，透明度到 0..100000。

**最小实现**（`src/svg2pptx/units.ts`）：

```ts
export const EMU_PER_PX = 9525, HPT_PER_PX = 75, ANGLE_UNIT = 60000;
export const pxToEmu = (px: number) => Math.round(px * EMU_PER_PX);
export const pxToHpt = (px: number) => Math.round((px * HPT_PER_PX) / 10) * 10;  // 0.1pt 网格
export const pxToSpcPts = (px: number) => Math.round(px * HPT_PER_PX);           // 行距/段前
export const degToOoxml = (deg: number) => Math.round(deg * ANGLE_UNIT);
export const alphaToOoxml = (a: number) => Math.round(Math.min(1, Math.max(0, a)) * 100000);
```

**收益**：一处改、全链一致；测试只需覆盖这 3 个函数；也自然解决了"`spcPts` 用 75 而字号用 75/10"的混淆。

---

### ③ 稳定命名与 id 预算（V3 / C1 = 3.0）

**机制**：SVG `id` → PowerPoint `cNvPr name`，并保证每页 id 唯一、导入对象的 id 被"预留 + 认领"。这是"导出后还能被脚本二次编辑"的前提。

**最小实现**（`src/svg2pptx/naming.ts`）：

```ts
export function displayName(el: Element, fallback: string): string {
  for (const attr of ['data-pptx-shape-name', 'id', 'data-name']) {
    const v = (el.getAttribute(attr) ?? '').trim();
    if (v) return v;
  }
  return fallback;                       // `Rectangle ${id}` …
}

export class IdAllocator {
  private next = 2;                      // 1 保留给 spTree
  private reserved = new Set<number>();
  private claimed = new Set<number>();
  claim(sourceId?: number) {             // 导入对象必须认领
    if (sourceId == null) return this.next++;
    if (!this.reserved.has(sourceId)) throw new Error(`unreserved id ${sourceId}`);
    if (this.claimed.has(sourceId)) throw new Error(`duplicate id ${sourceId}`);
    this.claimed.add(sourceId); return sourceId;
  }
}
```

**收益**：动画目标、Morph 配对、选择窗格、后续脚本定位全部依赖它。没有稳定命名，生成的 deck 就是"一次性图片的矢量版"。

---

### ④ 文本框框模型（V4 / C1.5 = 2.7）

**机制**：由 `anchor + baseline + 估计宽度` 反推四个框参数，padding 按字号自适应，`box_h` 只加一次 padding；导入帧则改用 `data-pptx-frame` + 反解 insets。

**最小实现**（`src/svg2pptx/measure/frame.ts`）：

```ts
export function textFrame(opts: {
  x: number; y: number; anchor: 'start'|'middle'|'end';
  width: number; height: number; baseline: number; fontSize: number;
}): { x: number; y: number; w: number; h: number } {
  const pad = Math.max(0.5, Math.min(2.0, opts.fontSize * 0.04));
  const x = opts.anchor === 'middle' ? opts.x - opts.width / 2 - pad
          : opts.anchor === 'end'    ? opts.x - opts.width - pad
          :                            opts.x - pad;
  return { x, y: opts.y - opts.baseline, w: opts.width + pad * 2, h: opts.height + pad };
}
```

**收益**：文本位置从"看起来差不多"变成"可复现"。配合 ① 后，同一 SVG 在 PowerPoint 里的文本偏移可控制在 1px 内。

---

### ⑤ 后处理补丁层（V5 / C2 = 2.5）

**机制**：pptxgenjs 生成合法空壳 → fflate 解包 → 用**唯一 objectName 定位**替换/插入 OOXML → 改 `[Content_Types].xml` 与 rels → 重新压缩。这是唯一能突破库能力上限的手段，且与 pm 的 python-pptx 骨架完全同构。

**最小实现**（`src/svg2pptx/patch/slide.ts` + `pack.ts`）：

```ts
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';

export async function buildPptx(base: Uint8Array, patches: RawPatch[]): Promise<Uint8Array> {
  const files = unzipSync(base);
  for (const p of patches) {
    const path = `ppt/slides/slide${p.page}.xml`;
    const xml = strFromU8(files[path]);
    files[path] = strToU8(applyPatch(xml, p));      // 唯一名定位，见 §7.3
  }
  applyContentTypes(files, patches);                 // <Override>
  applyRels(files, patches);                         // slideN.xml.rels
  return zipSync(files, { level: 6 });
}
```

**收益**：一次性解锁 custGeom/grpSp/custDash/ChartEx/OMML/timing 六类能力。成本集中在"patch 函数正确性"，而它可以用 fixtures 单测。

---

### ⑥ 宽度测量（V4 / C2 = 2.0）

**机制**：优先用捆绑的每字形 advance 表；缺失时按字符类回退（CJK 1em、全角 0.5em、数字 0.55em…）；再按字号插值 headroom（sans 1.06–1.12，serif 1.12–1.36）。

**最小实现**（`src/svg2pptx/measure/width.ts`）：

```ts
export function runWidth(run: Run, table: AdvanceTable | null): number {
  const clusters = splitClusters(run.text);
  let w = 0;
  for (const c of clusters) {
    const adv = table?.lookup(c);
    w += adv != null ? adv * run.fontSize
       : isCjk(c) ? 1.0 * run.fontSize
       : 0.55 * run.fontSize;                        // 通用回退
  }
  return w * (run.bold && !isCjk(run.text) ? 1.05 : 1);
}
export function withHeadroom(w: number, size: number, serif: boolean, caps: boolean): number {
  const base = serif ? 1.12 : 1.06, cap = serif ? 1.36 : 1.12;
  return w * (caps ? cap : base);
}
```

**收益**：`wrap="none"` 时框宽直接等于估计值；估窄了 PowerPoint 会换行（跨平台最常见的事故）。CJK 与 emoji 的簇处理是必要的，否则"👨‍👩‍👧"会被算成 5 个字符宽。

---

### ⑦ custGeom 生成器（V4 / C2 = 2.0）

**机制**：把 SVG path 规范化为只含 `M/L/C/Z` 的绝对命令流，再映射为 `<a:path w h>` 内的 `moveTo/lnTo/cubicBezTo/close`；`a:path` 的 `w/h` 用 EMU 表示局部坐标系。

**最小实现**（`src/svg2pptx/emit/custGeom.ts`）：

```ts
export function toCustGeom(cmds: AbsCommand[], wEmu: number, hEmu: number): string {
  const body = cmds.map(c =>
    c.type === 'M' ? `<a:moveTo><a:pt x="${pxToEmu(c.x)}" y="${pxToEmu(c.y)}"/></a:moveTo>` :
    c.type === 'L' ? `<a:lnTo><a:pt x="${pxToEmu(c.x)}" y="${pxToEmu(c.y)}"/></a:lnTo>` :
    c.type === 'C' ? `<a:cubicBezTo>${[[c.x1,c.y1],[c.x2,c.y2],[c.x,c.y]]
                        .map(([x,y]) => `<a:pt x="${pxToEmu(x)}" y="${pxToEmu(y)}"/>`).join('')}</a:cubicBezTo>` :
                     '<a:close/>').join('');
  return `<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/>` +
         `<a:rect l="0" t="0" r="r" b="b"/><a:pathLst><a:path w="${wEmu}" h="${hEmu}">` +
         `${body}</a:path></a:pathLst></a:custGeom>`;
}
```

上游需要 `Q→C`（`P0 + 2/3(Q-P0)`, `P2 + 2/3(Q-P2)`）与 `A→C`（按 90° 分段，`k=0.5522847498`，pm 的 `_BEZIER_QUARTER_K`，`DM/elements.py:797`）。

**收益**：所有"不是一个预设形状"的图形（自定义箭头、图标、装饰线）都靠它；也是布尔运算（`S2P/shape_boolean.py`）的前置。

---

### ⑧ 严格前置校验（V3 / C1.5 = 2.0）

**机制**：在生成任何 XML 之前，把"不可表达"的输入一次性全部找出并报错，错误带元素标签与属性名。pm 有 30+ 个 `project_*_errors`。

**最小实现**（`src/svg2pptx/validate.ts`）：

```ts
export type Finding = { path: string; message: string };
export function validate(ir: ShapeIR[]): Finding[] {
  const out: Finding[] = [];
  walk(ir, (n) => {
    if (n.kind === 'mask') out.push({ path: n.path, message: 'mask is unsupported; use clip-path' });
    if (n.kind === 'text' && n.unsupportedProps.length)
      out.push({ path: n.path, message: `unsupported text properties: ${n.unsupportedProps.join(', ')}` });
    if (n.kind === 'path' && !isCanonicalNumbers(n.d))
      out.push({ path: n.path, message: 'path uses non-canonical numeric spelling' });
  });
  return out;
}
// 调用方：if (findings.length) throw new ConversionError(findings.join('\n'));
```

**收益**：把"导出后 PowerPoint 提示修复"的调试成本，前移到一次可读的错误列表。dsh-ppt 尤其需要——AI 生成的 SVG 里 `mask`/`dominant-baseline`/`em` 单位的出现率远高于人工稿。

---

### ⑨ 分组与枢轴补偿（V2.5 / C1.5 = 1.7）

**机制**：需要动画/需要保结构时才建 `grpSp`，且 `chOff=off`（子元素坐标不重写）；`rotate(a cx cy)` 的枢轴差折算进 `off`。

**最小实现**（`src/svg2pptx/emit/group.ts`）：

```ts
export function groupXfrm(children: Bounds[], angleDeg: number, pivot?: [number,number]) {
  const minX = Math.min(...children.map(b => b.x0)), minY = Math.min(...children.map(b => b.y0));
  const maxX = Math.max(...children.map(b => b.x1)), maxY = Math.max(...children.map(b => b.y1));
  const w = Math.max(maxX - minX, 1), h = Math.max(maxY - minY, 1);
  let offX = minX, offY = minY;
  if (pivot && angleDeg) {
    const t = angleDeg * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
    const bx = minX + w / 2, by = minY + h / 2;
    const dx = (bx - pivot[0]) * c - (by - pivot[1]) * s + pivot[0] - bx;
    const dy = (bx - pivot[0]) * s + (by - pivot[1]) * c + pivot[1] - by;
    offX = Math.round(minX + dx); offY = Math.round(minY + dy);
  }
  return `<p:grpSp><p:nvGrpSpPr>…</p:nvGrpSpPr><p:grpSpPr><a:xfrm${angleDeg ? ` rot="${degToOoxml(angleDeg)}"` : ''}>` +
         `<a:off x="${offX}" y="${offY}"/><a:ext cx="${w}" cy="${h}"/>` +
         `<a:chOff x="${minX}" y="${minY}"/><a:chExt cx="${w}" cy="${h}"/></a:xfrm></p:grpSpPr>`;
}
```

**收益**：没有它，"整组淡入"只能退化成逐个形状动画；有了它，动画/选择/移动都符合直觉。价值略低于前几项，因为多数 deck 用不到组动画。

---

### ⑩ 语义标记协议（V2.5 / C2.5 = 1.0）

**机制**：`<g data-pptx-replace-with="chart|table|formula">` + 内嵌 JSON + bounds + fallback 新鲜度哈希。把"可编辑原生对象"变成 SVG 里的一等公民，而不是导出时的猜测。

**最小实现**（`src/svg2pptx/marker.ts`）：

```ts
export interface Marker { kind: 'chart'|'table'|'formula'; payload: any; bounds: Box }
export function readMarker(el: Element): Marker | null {
  const kind = el.getAttribute('data-pptx-replace-with') ?? el.getAttribute('data-pptx-native');
  if (!kind) return null;
  if (el.tagName !== 'g') throw new Error('marker must be <g>');
  const raw = el.getAttribute('data-pptx-json')
           ?? [...el.children].find(c => c.tagName === 'metadata'
                && (c.getAttribute('type') ?? '').toLowerCase() === 'application/json')?.textContent;
  if (!raw) throw new Error(`marker ${el.id} requires JSON metadata`);
  const payload = JSON.parse(raw);
  return { kind: kind as Marker['kind'], payload, bounds: boundsOf(el, payload) };
}
```

配套：fallback 子树哈希（`hash(subtree)` → 与 JSON 里记录的 `fallbackSha256` 比对），JSON 改了但 SVG 没重绘就拒绝导出。

**为什么排最后**：它是**产品能力**（原生图表/表格/公式），不是**基础能力**。dsh-ppt 应先有 ①–⑨ 把"矢量图 → 可编辑形状"做对，再考虑让 AI 直接产出原生图表。否则会陷入"图表能编辑但整页布局是歪的"的困境。

---

## 附录 A：关键文件索引

| 文件 | 行数 | 角色 |
|---|---|---|
| `S/svg_to_pptx.py` | 31 | 防篡改薄包装 |
| `S2P/__init__.py` | 37 | 懒加载公开 API |
| `S2P/drawingml/converter.py` | 2601 | 调度器 + 主循环 + slide 汇编 |
| `S2P/drawingml/elements.py` | 5686 | 全部叶子转换器（含 text/image/clip） |
| `S2P/drawingml/styles.py` | 782 | fill/stroke/effect/opacity |
| `S2P/drawingml/paths.py` | 847 | path 解析 → custGeom |
| `S2P/drawingml/utils.py` | 3810 | 单位/颜色/字体/变换/校验器/度量 |
| `S2P/drawingml/text_properties.py` | 796 | 文本属性封闭语法 |
| `S2P/drawingml/text_baseline.py` | 127 | 首行基线反算 |
| `S2P/drawingml/theme_fonts.py` / `theme_colors.py` | 502 / 283 | 主题槽位提升 |
| `S2P/drawingml/hyperlinks.py` | 162 | 形状级超链接 |
| `S2P/drawingml/context.py` | 302 | `ConvertContext` / `ShapeResult` |
| `S2P/drawingml/__init__.py` | 1 | 空命名空间 |
| `S2P/canvas_contract.py` | 226 | viewBox → EMU 契约 |
| `S2P/use_expander.py` | 585 | `<use>` 内存展开 |
| `S2P/tspan_flattener.py` | 84 | 位置型 tspan 提升 |
| `S2P/geometry_properties.py` | 140 | 内联几何物化 |
| `S2P/shape_boolean.py` | 1355 | 布尔运算 → custGeom |
| `S2P/text_outline.py` | 1121 | 文本转轮廓 |
| `S2P/animation_config.py` | 1910 | 动画侧车 + `p:timing` |
| `S2P/native_objects/__init__.py` | 786 | 原生对象校验/分派/源包恢复 |
| `S2P/native_objects/table.py` | 2058 | 语义表 → `a:tbl` |
| `S2P/native_objects/chart_data.py` | 1711 | 图表载荷归一化 |
| `S2P/native_objects/chart_xml.py` | 1741 | classic chart XML |
| `S2P/native_objects/chart_style.py` | 1696 | chrome/配色/一致性 |
| `S2P/native_objects/chartex.py` | 304 | ChartEx part |
| `S2P/native_objects/formula_parser.py` | 2181 | LaTeX 子集解析 |
| `S2P/native_objects/formula_omml.py` | 1049 | AST → OMML |
| `S2P/native_objects/marker_common.py` | 1110 | marker/载荷/bounds/常量 |
| `S2P/native_objects/marker_attributes.py` | 189 | 新旧属性别名 |
| `S2P/native_objects/fallback_hash.py` | 177 | fallback 新鲜度 |
| `S2P/native_objects/workbook.py` | 216 | 最小 xlsx |
| `S2P/pptx_package/builder.py` | 8740 | 造壳/循环/注入/校验/打包 |
| `S2P/pptx_package/cli.py` | 3949 | CLI + postflight |
| `S2P/pptx_package/template_structure.py` | 3759 | master/layout 家族 |
| `S2P/pptx_package/template_validation.py` | 1536 | 模板包校验 |
| `S2P/pptx_package/slide_xml.py` | 138 | slide 骨架 |
| `S2P/pptx_package/notes.py` | 341 | 备注 |
| `S2P/pptx_package/narration.py` | 820 | 旁白音频 |
| `S/pptx_ooxml/package.py` | 320 | `PackagePartRegistry` |
| `S/native_payloads.py` | 655 | 外部 payload 存储（gzip） |
| `S/preset_shape_svg.py` | 517 | 预设形状 → SVG 片段（作者工具） |
| `S/config.py` | 706 | 画布格式表 |
| `DOC/svg-pipeline.md` | 1412 | 管线契约（长文） |
| `DOC/native-data.md` | 47 | 原生载荷字段全集（密度极高） |
| `REF/svg-effects.md` | 610 | 支持的滤镜/效果子集 |
| `REF/native-shape-authoring.md` | 182 | 原生形状作者指引 |
| `REF/pptx-structure-interface.md` | 85 | master/layout 契约 |

## 附录 B：复现与验证命令

```bash
# 标准导出（读 svg_output/）
python3 skills/ppt-master/scripts/svg_to_pptx.py <project> -o out.pptx

# 原生图表/表格（需要 marker）
python3 skills/ppt-master/scripts/svg_to_pptx.py <project> --native-charts-and-tables -o out.pptx

# 往返导出（读 authoring-svg-flat/）
python3 skills/ppt-master/scripts/svg_to_pptx.py <project> --roundtrip -o out.pptx

# 预检（质量门禁）
python3 skills/ppt-master/scripts/svg_quality_checker.py <project> --json
```

`DOC/svg-pipeline.md:303-410` 还提供了一个**自包含 smoke**：用 `preset_shape_svg.py render` 造 preset、拼一个含 clip/gradient/dash/text 的 SVG、走完整转换，断言产出。这个 smoke 的思路（"一个小 SVG 覆盖所有分支"）也值得 dsh-ppt 照搬。

## 附录 C：本次分析的边界（诚实声明）

- **完整读过**：`converter.py` 全部关键函数、`elements.py` 的 rect/circle/line/image/text/clip 段、`styles.py` 的 fill/stroke/effect、`utils.py` 的常量/单位/变换/度量、`text_baseline.py` 全文、`paths.py` 的函数表、`context.py` 全文、`canvas_contract.py` 的 viewBox 部分、`marker_attributes.py` 全文、`native_payloads.py` 头部、`pptx_ooxml/package.py` 头部、`builder.py` 的入口/逐页转换/打包/校验段、`docs/native-data.md` 全文。
- **只读了结构与签名、未逐行读**：`cli.py`（3949 行）、`template_structure.py`（3759）、`template_validation.py`（1536）、`animation_config.py`（1910）、`text_outline.py`（1121）、`shape_boolean.py`（1355）、`chart_style.py`（1696）、`formula_parser.py`（2181）、`formula_omml.py`（1049）、`table.py` 的中段（700–1780）。
  → 涉及这些模块的结论，均只基于其**公开函数名/签名/被调用点**，未对其内部算法下断言。
- **推断（已标注的地方）**：`r` 的百分比基准用 `min(w,h)` 属于工程近似（§1.5 末）；pptxgenjs 4.x 的个别选项名（`sizing`、`objectName`、逐 run `charSpacing`）以公开文档为准，本报告只断言"有没有对应能力"，不断言属性名一定如文中所示。
- **未验证**：没有实际运行转换（只读仓库）。所有行为结论来自源码阅读；如需实证，应按附录 B 的命令跑一次并用 `office-pptx`/LibreOffice 渲染比对。

