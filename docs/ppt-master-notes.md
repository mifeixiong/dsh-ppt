# ppt-master 实现调查与本插件的取舍

调查对象：[hugohe3/ppt-master](https://github.com/hugohe3/ppt-master)（本地快照 `78fcef9`，只读）。目标是回答一个问题：**它凭什么把 AI 生成的稿子做成"真正能改"的 PPTX**，以及哪些做法值得搬进 dsh-ppt。

三份逐行报告（含 `path:line` 引用）已随仓库保存：

- [pm-svg2pptx.md](research/ppt-master/pm-svg2pptx.md)：SVG → 原生 PPTX 转换引擎（流水线、映射表、文本基线、分组、打包）
- [pm-quality.md](research/ppt-master/pm-quality.md)：SVG 授权契约与质量检查器（32 条规则、阈值、压缩步骤、视觉评审）
- [pm-roundtrip.md](research/ppt-master/pm-roundtrip.md)：PPTX → SVG 往返、模板工作区、图片/图标资产管线

本文只留结论与取舍。

## 1. 它到底怎么实现

### 1.1 一条"字符串拼装 + 严格前置校验"的转换流水线

- 入口 `scripts/svg_to_pptx.py`（31 行）→ `svg_to_pptx/pptx_package/cli.py:2073` → `builder.py:6730`。
- 打包骨架：`python-pptx` 造空壳 → 解包 → 逐页写 `ppt/slides/slideN.xml` → 补 rels/Content_Types → 四道包校验 → 原子替换。**与"unzip → patch → rezip"同构**，这是 dsh-ppt 后处理层已经在用的范式。
- 转换器没有 DOM 中间层：`convert_*` 直接返回 `ShapeResult(xml, bounds_emu)`（`drawingml/context.py:49`），11 个叶子转换器按标签分派；**不认识的可见标签直接抛错**（`converter.py:1961`），没有栅格化兜底。
- 正确性靠 30+ 个 `project_*_errors()` 前置校验器（`drawingml/utils.py`）：长度、变换、描边、透明度、涂色、defs、渐变、滤镜、蒙版、marker、图片比例、裁剪，任一非空即失败。

**对 dsh-ppt 的意义**：这条"先拒绝再转换"的纪律比转换本身更重要。dsh-ppt 的 HTML 车道也是先校验后测量（`validateDeckHtmlSource`），SVG 车道沿用同一纪律，把不支持的东西变成可读的错误，而不是静默丢图层。

### 1.2 单位、坐标与几何

- `1 px = 9525 EMU`；字号 `px*75` 后量化到 0.1 pt；角度 1/60000 度；`viewBox` 用 Decimal 四舍五入换算（`canvas_contract.py:46-61`）。
- `path` 先绝对化，再把 `Q/T` 转 `C`、`A` 按 ≤90° 分段转 `C`，最后只输出 `M/L/C/Z`（`drawingml/paths.py:466-847`）。
- 包围盒取**控制点**包围盒（不是曲线极值）：偏大但绝不会裁掉笔画；`width = max(max_x-min_x, 1)`。
- 线端（箭头）只画在 `prstGeom prst="line"` 上：PowerPoint 会忽略 `custGeom` 的 `headEnd/tailEnd`（`elements.py:1700-1770`），端点方向用 `flipH/flipV` 还原。

**已搬进本插件**（`src/svg-geometry.ts`、`src/svg-ooxml.ts`）：上述四条。差异是包围盒退化轴上多留 1 px，保证水平细线不被 PowerPoint 丢掉。

### 1.3 文本：基线反算才是关键

- SVG 的 `y` 是基线，DrawingML 的 `a:off.y` 是框顶。它用捆绑的 `font_metrics.json` 取 `ascent/(ascent+descent)`，按 **1.2 em 自然行高**算首行基线，再 `box_y = y - baseline`（`drawingml/text_baseline.py:67-127`）。
- 宽度：`font_advances.json`（10 家族 × 4 风格 × 227 字形）+ CJK/emoji 回退表 + **headroom 1.06（sans）/1.12（全大写）/1.12–1.36（serif）**，避免 PowerPoint 用自己字体渲染时比估算宽而换行。
- 框高只加一次 padding；`wrap="none"` + `spAutoFit` 让 PowerPoint 兜底。

**已搬进本插件**（`src/text-metrics.ts`、`src/svg-lane.ts`）：
- 宽度不用捆绑表，直接用 **fontkit 读本机真实字体的 advance**，按字符覆盖率拆 run（CJK 落回有该字形的族），字体缺失时退回保守估算并给 `measured:false`；
- 基线用真实字体的 `ascent/(ascent+descent)` × 1.2 em；
- 头部余量 1.06 + 2 px，文本框 `wrap="none"`。

### 1.4 质量门

- 契约是封闭面：`viewBox` 是画布唯一权威；非法 `viewBox` 只警告、与锁定规格不符才报错。
- 三个硬阈值：模块重叠双轴 > 1 px 报错；文字溢出模块 ≤5% 警告、>5% 报错；越出 `viewBox` 一律报错。
- 文本度量同样不靠浏览器：`font_advances.json` + 逐字符回退（CJK 1.0 em、`mMwWOQ%` 0.75、数字 0.55）。
- **它没有对比度、最小字号、字体可用性检查**；这三项只在视觉评审的人工规则里（H4：正文 < 4.5、大字 < 3.0）。
- 视觉评审用 Playwright 渲 PNG（cairo 因 CJK 豆腐被否）。

**取舍**：dsh-ppt 的 SVG 车道把对比度、最小字号、越界、字体可用性都做成了静态 warning（`src/svg-deck.ts`），因为它们不需要渲染；重叠检查留给已有的 `ppt_image` + 视觉评审闭环，避免在没有字体度量的情况下误报。

### 1.5 往返与模板（本次未实现）

- `pptx_to_svg` 是"声明子集转换"，不是无损往返：主题经 `clrScheme` + `clrMap` 解析，母版/版式形状按两级可见性回填，`custGeom` 先做公式局部求值再投影。
- 往返用四个桶：`passthrough / cloned_passthrough / patched / rebuilt`，未改页靠"重算基线 + 子树归一化哈希"判定，交付轮要求 `rebuilt=0`。
- 模板是四个并列 kind：`brand`（身份）、`style`（方法）、`layout`（结构）、`deck`（应用），结构载荷是 10 个 `data-pptx-*` 属性 + slot/bounds/carrier 契约，安装时写 `template_install.json` 收据。
- 资产：12,027 个图标（目录即索引）、生图 manifest（严格枚举 14 后端）、图搜许可优先 + 缩略图短名单 + 5 道审核门。

## 2. 本次落地了什么

| 能力 | 实现 | 与 ppt-master 的关系 |
| :--- | :--- | :--- |
| SVG 车道（`ppt_create` 的 `svg_path`） | `src/svg-deck.ts`、`src/svg-geometry.ts`、`src/svg-ooxml.ts`、`src/svg-lane.ts` | 移植其"受限 SVG → DrawingML"路线，改为单文档 + `<g data-page>` 分页 |
| 原生 custGeom / 渐变 / 虚线 / 箭头 | `src/svg-ooxml.ts` + 包后处理 `rewritePptxSlideShapes` | 同 §1.2；补丁方式改为"按 `objectName` 定位占位形状再替换整段 `<p:sp>`" |
| 文本度量与基线 | `src/text-metrics.ts`（fontkit）、`src/svg-lane.ts` | 替代其捆绑度量表；算法同 §1.3 |
| 静态契约与设计告警 | `src/svg-deck.ts` 的 findings | 取其阈值（5% 溢出、>1 px 越界、12 px 下限、4.5:1 对比度）中不需要渲染的部分 |
| 车道文档 | `docs/svg-lane.md` | — |

## 3. 值得做、本次没做

按"价值 / 成本"排序，都已在报告里留了实现草图：

1. **`ppt_theme_from_pptx`**：读 `ppt/theme/theme1.xml` + `slideMaster` 的 `clrMap`，产出可直接当 `PptTheme` 用的品牌配方（含 `accent_inverted` 对比度校验）。这是"严格复刻客户模板"的第一块砖，成本低。
2. **`ppt_template_import`**：把模板工作区 JSON 落成主题 + 版式约束（`layout` 的 slot/bounds 契约可直接映射到快车道的页面家族）。
3. **`ppt_icons`**：内置图标包（目录即索引 + 关键词索引），SVG 车道已能原生承接，只差素材与检索工具。
4. **`ppt_import_pages`**：PPTX → 可编辑页（只做文本 + rect + 图片三件），用于"在客户既有稿上改"的场景；成本最高。
5. **原生图表**：快车道现在用形状画条形对比，改为 `pptx.addChart` 或注入 chart part，才能让"改数据"真的改图。
6. **动效往返**：`ppt_read/write_motion`，把已有稿的转场与动画读出来再写回。
