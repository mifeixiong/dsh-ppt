# SVG 车道：矢量稿直接变成原生 PPTX

`ppt_create` 现在接受第三种输入来源：`svg_path`。它读一份受限的 SVG 文档，把里面的矢量图元**逐个翻译成 DrawingML**，再由共用写入器落成 `.pptx`。这条路不开浏览器、不跑回渲，和快车道一样是秒级的；区别是它带得动快车道的矩形排版带不动的东西：自由路径（`<path>`）、形状内渐变、虚线、箭头、多边形。

## 1. 为什么加这条车道

调查 `hugohe3/ppt-master` 的实现后（详见 `docs/ppt-master-notes.md`），它的核心不是"用 AI 画图"，而是：

1. **以 SVG 作为唯一排版面**，模型写的是几何，不是像素；
2. **转换器是字符串拼装 + 严格前置校验**：每个受支持的 SVG 叶子映射成一段 DrawingML，没有栅格化兜底，不认识的可见元素直接报错；
3. **1 px = 9525 EMU**，坐标、线宽、字号全部走同一套量化；
4. **文本按字体度量反解框顶**：SVG 的 `y` 是基线，DrawingML 的 `a:off.y` 是框顶，中间差一个"首行基线偏移"。

dsh-ppt 原有的两条车道各有边界：快车道按大纲确定性排版，形状只有矩形/圆角矩形/椭圆，颜色只有纯色；精修车道能从 HTML 量出任意盒模型，但 pptxgenjs 的公开 API 同样表达不了自由形状、形状内渐变、虚线与箭头。这条车道补的正是这一层——**矢量表达力**，同时保留"原生可编辑"这条底线。

## 2. 调用序列

```
ppt_outline            → outline.json + design-plan.json（分配工件目录，页数定稿）
（可选）ppt_themes      → 取配色，写进 design-plan.json 与每页 style.accent
写 <artifact>/deck.svg  → 用 write / edit
ppt_create({ svg_path, outline_path, output_path })
```

`html_path` 与 `svg_path` 互斥，两者都不给就走快车道。页数以 `outline.json` 为准：SVG 里的页数与大纲不一致会直接失败（`SVG_DECK_INVALID`）。

## 3. 文件格式

一份文档，根是 `<svg>`，页是顶层 `<g data-page="N">`。仓库里有一份可直接使用的完整样例：[assets/svg-lane-example.svg](../assets/svg-lane-example.svg)。

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
  <defs>
    <linearGradient id="hero" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0B1B33"/>
      <stop offset="1" stop-color="#1E4B8F"/>
    </linearGradient>
  </defs>
  <g data-page="1" data-background="#081120">
    <rect x="72" y="64" width="520" height="300" rx="12" fill="url(#hero)"/>
    <path d="M 760 420 L 900 480 L 1040 420" fill="none" stroke="#FFFFFF"
          stroke-width="4" data-tail="triangle"/>
    <text x="72" y="470" font-family="Liter" font-size="44" font-weight="700"
          fill="#FFFFFF">矢量标题</text>
    <image href="assets/photo.png" x="980" y="480" width="160" height="90"/>
  </g>
</svg>
```

### 3.1 画布与页

- `viewBox` 必须是 `0 0 1280 720`；与 HTML 车道同一张画布、同一套页边距纪律（水平 72、垂直 64）。
- 每页一个顶层 `<g data-page="N">`，从 1 连续编号，最多 60 页。
- `data-background="#RRGGBB"` 声明页面底色（作原生幻灯片背景）。渐变底请画一个满画布 `<rect>`，这样它仍是可编辑的形状。
- 文档顺序就是 z 序：后画的在上层。

### 3.2 允许的元素

`svg`、`g`、`defs`、`linearGradient`、`radialGradient`、`stop`、`rect`、`circle`、`ellipse`、`line`、`polyline`、`polygon`、`path`、`text`、`tspan`、`image`、`title`、`desc`。

`filter`、`mask`、`clipPath`、`pattern`、`use`、`symbol`、`marker`、`foreignObject`、`style`、`script`、`animate*` 一律报错——不是"忽略"，而是明确告诉你导出会与预览不同。需要模糊/阴影的稿子请留在 HTML 车道。

### 3.3 图元 → DrawingML 映射

| SVG | DrawingML | 说明 |
| :--- | :--- | :--- |
| `<rect>`（无圆角） | `a:prstGeom prst="rect"` | 保持预设形状，缩放不改形 |
| `<rect rx>` | `a:prstGeom prst="roundRect"` | 半径折进 `avLst/adj`，上限为短边一半 |
| `<circle>` / `<ellipse>` | `a:prstGeom prst="ellipse"` | 同上 |
| `<line>` | `prstGeom prst="line"` + `flipH/flipV` | 只有这种几何 PowerPoint 才渲染箭头 |
| `<polyline>` / `<polygon>` / `<path>` | `a:custGeom` + `a:pathLst` | 全部曲线规范化为三次贝塞尔；`Q/T` 转 `C`，`A` 按 ≤90° 分段转 `C` |
| `fill="url(#g)"`（线性） | `a:gradFill` + `a:lin ang="…"` | 角度按 SVG 方向 `atan2(y2-y1, x2-x1)` 换算成 1/60000 度 |
| `fill="url(#g)"`（径向） | `a:gradFill` + `a:path path="circle"` | 焦点按 `fx/fy` 写进 `fillToRect` |
| `fill="none"` | `a:noFill` | |
| `stroke` + `stroke-width` | `a:ln w="EMU"` | 1 px = 9525 EMU |
| `stroke-dasharray` | `a:prstDash` / `a:custDash` | 常见节奏走预设；任意数组取首对 dash/gap 折成百分比 |
| `stroke-linecap` / `-linejoin` | `cap=` / `a:round/a:bevel/a:miter` | |
| `data-head` / `data-tail` | `a:headEnd` / `a:tailEnd` | 取值 `none/triangle/stealth/diamond/oval/arrow`；只能用在无填充描边线上 |
| `opacity` | 形状级 `a:alpha` | 乘进整形状的涂色与描边 |
| `fill-opacity` / `stroke-opacity` / `rgba()` / `stop-opacity` | 合成到页面底色 | v1 的 `Paint` 没有逐色 alpha 通道：半透明色按页面底色预乘成实色，看起来一致，但不是"可再调透明度"的图层 |
| `<text>` / `<tspan>` | 原生文本框 + 多 run | 一行一个文本框，`wrap="none"`，基线按字体度量反解 |
| `<image href>` | `p:pic` | 只收工件目录内的相对路径 |

**坐标与精度**：路径先按元素 `transform`（`translate/scale/rotate/matrix/skewX/skewY`）烘进点坐标，再取控制点包围盒作为形状框；包围盒平移后所有点落在 `0..w × 0..h`，与 `a:ext` 一致，PowerPoint 不会再缩放一次。

**旋转**：图形旋转建议直接写进 `transform`（会被烘进几何，最稳）；文本框上的旋转在 v1 会报错。

### 3.4 文本

```xml
<text x="72" y="470" font-family="Liter" font-size="44" font-weight="700"
      fill="#FFFFFF" letter-spacing="0">标题</text>

<text x="640" y="480" font-family="Liter" font-size="28" fill="#0B1B33" text-anchor="middle">
  第一段<tspan font-weight="700" fill="#2F6BFF">强调</tspan>
</text>
```

- `x/y` 是 SVG 语义：`x` 按 `text-anchor`（`start/middle/end`）定位，`y` 是**基线**。
- 换行只有一种写法：给 `<tspan>` 写 `y`，它开始新的一行；不写 `y` 的 `tspan` 只追加 run。
- `font-size` 必须是 px 数字（不收 `em`/`pt`），最小 `12`；`font-family` 必须在插件批准的字体注册表里，否则报错，装了同族字体时按度量实测宽度，没装则退回保守估算并给一条 warning。
- 框宽 = 实测行宽 × 1.06 + 2 px，框高 = 1.2 em；**框顶 = 基线 − 1.2 em × ascent/(ascent+descent)**，这就是 PowerPoint 自己算首行基线的算法。行内不一致时以首 run 的字号为准（这是 v1 的已知限制）。

### 3.5 渐变

```xml
<linearGradient id="g" x1="0" y1="0" x2="1" y2="1">…</linearGradient>
<radialGradient id="r" cx="0.5" cy="0.5" fx="0.5" fy="0.5">…</radialGradient>
```

- 只支持 `objectBoundingBox`（也就是 0..1 的坐标）；`userSpaceOnUse` 会报错，因为 DrawingML 的渐变是相对形状的。
- `stop` 要 2 到 8 个（DrawingML 的上限），`offset` 必填、单调不减且在 0..1；`stop-opacity` 会乘进 alpha。

### 3.6 图片

`href` 必须是工件目录内的相对路径（`assets/…`），扩展名限 `png/jpg/jpeg/webp/gif/svg`。SVG 里的图片按 `contain` 放进你给的框——请自己按原始比例写 `width/height`，不要指望车道替你裁切。

## 4. 校验与诊断

解析阶段一次收齐所有问题，按 `SVG_DECK_INVALID` 抛出，`details.issues` 里是逐条定位（页号 + 元素 id + 原因）。会**阻断**的典型情况：

| 情况 | 原因 |
| :--- | :--- |
| `viewBox` 不是 `0 0 1280 720` | 画布契约，换算与页边距都依赖它 |
| 页号缺失/重复/不连续 | 导出顺序必须等于大纲顺序 |
| 出现禁用元素或未知属性 | 导出结果会与预览不一致 |
| `style="…"` 内联样式 | 属性与样式表语义歧义，统一用表现属性 |
| `font-family` 不在注册表 / 字号 < 12 | 换机器会掉字或糊成一团 |
| `href` 绝对路径、`..`、远程 URL | 素材必须冻结在工件目录里 |
| 箭头写在有填充的形状上 | PowerPoint 只在无填充描边上渲染线端 |
| 渐变引用不存在的 id | 静默丢色比报错更糟 |

**warning** 不阻断：文本与底色对比度不足（正文 < 4.5:1、大字 < 3:1）、元素越出画布超过 1 px、字体没装只能估算宽度、空页。它们会出现在 `ppt_create` 返回的 `warnings` 与 `report.json` 的 `conversion.svg` 里。

## 5. 已知边界（v1）

- 没有 mask / clipPath / filter / pattern / `<use>` / marker：需要这些效果的稿子留在 HTML 车道，或在导出前"烘平"成路径。
- `transform` 只接在绘制元素上（`rect`/`path`/`text`/`image`）；写在 `<g>` 或 `<tspan>` 上会报错，因为整组变换无法可靠烘焙进每个子元素。
- 嵌套 `<svg>`、逐行 `x/dx`、逐 run 的 `text-anchor`/`letter-spacing`、文本描边都按错误处理，而不是悄悄丢掉这些意图。
- 文本旋转、`textPath`、`dominant-baseline` 不支持；竖排请用旋转后的图形或留在 HTML 车道。
- 一行文本只有一个字号用于框高计算；混排（一行里 12 px 与 64 px 并排）时框高偏小，极端情况会被裁。
- 文本宽度在字体未安装时是估算值（`measured:false`）；正式交付前用 `ppt_image` 回渲一页确认。
- 图片按 `contain` 放置；SVG 的 `preserveAspectRatio="none"` 拉伸语义没有对应实现。
- 逐色透明度（`fill-opacity`、`rgba()`、`stop-opacity`）会被预乘成页面底色上的实色；形状级的 `opacity` 是原生 alpha。需要"导回去还能调透明度"的图层，请在形状级用 `opacity`。

## 6. 与 ppt-master 的差异

| 维度 | ppt-master | dsh-ppt SVG 车道 |
| :--- | :--- | :--- |
| 载体 | Python 脚本 + 技能文档 | TypeScript 插件工具，`ppt_create` 的一个入参 |
| 页面来源 | `svg_output/*.svg` 每页一份 | 单文档、`<g data-page>` 分页 |
| 转换 | 直接生成整页 slide XML | 复用 pptxgenjs 造包，按 `objectName` 定位后替换 `<p:sp>` |
| 文本度量 | 捆绑 `font_advances.json` + `font_metrics.json` | fontkit 读本机真实字体，缺失时退回估算 |
| 图表/表格/公式 | 标记协议 + 原生部件注册表 | v1 不做（表格走快车道，图表仍是形状绘制） |
| 模板/母版 | 完整四类模板工作区与往返编辑 | v1 不做，见 `docs/ppt-master-notes.md` 的后续清单 |
