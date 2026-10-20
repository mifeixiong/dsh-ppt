# 设计法则层（Refactoring UI）

把《Refactoring UI》里能机器判定的设计纪律，落到 1280×720 的幻灯片上：逐页实算、命名告警、可回归测试。

九条规则里七条直接对应书中条款（§2.2.a、§2.2.b、§2.3、§4.3、§4.5、§4.8.2、§5.6），两条（一页字号上限、字族上限）是插件按幻灯片场景加的约定，表格里标为 `plugin convention`。**所有数值阈值**——1.3× 行高、0.02em 字距、90/50 字符告警线——都是按幻灯片尺寸校准的实现值，不是书里的原文数字。

## 这层是什么

**出处。** 规则来自 Adam Wathan 与 Steve Schoger 的《Refactoring UI》，经本机安装的 [refactoring-ui skill](https://github.com/edisonmbli/refactoring-ui-skill) 整理成可执行条款后，按幻灯片场景重述。本仓库与书的作者、出版社以及该 skill 都没有隶属、赞助或背书关系；规则是以可执行约束的形式重写的，不是原文摘录。

**适配。** 原书面向 Web UI，这一层把其中可判定的部分映射到插件的固定画布：1280×720、每页独立判定、不跨页累计。`browser.ts` 在逐页回渲时采集每个文字叶的计算样式（字号、字重、颜色、不透明度、行数、行高、字距、`text-transform`、是否旋转、能否拿到实色底），采集时把元素的 opacity 与颜色 alpha 合成为实际渲染色再交给规则，所以「用透明度把文字调淡」也会按真实观感判定，而不只按声明的颜色。`design-rules.ts` 的纯函数 `designRuleFindings` 只吃这些数字，不碰 DOM、不读时钟、不做 I/O——阈值因此可以脱离浏览器审计和测试。

采集边界也要说清：只认浏览器算出的 `rgb()` / `rgba()` 颜色，其它色彩空间不审；祖先元素的 opacity 不在采集范围，**幽灵叠字要把透明度写在文字叶本身**；行数按行框聚类，同一视觉行里不同字号的内联片段算一行。

**落点。** `html_create` 回渲后运行这一层，`RUI_*` 告警是 **warning 级**，出现在三个地方：

1. `html_create` 返回值的 `design_findings` 与 `warnings` 文本里；
2. 工件目录的 `design-validation.json`（`findings` 字段）；
3. 质检报告 `report.json` 的 `design_fidelity.findings`（回渲成功时同时并入自动视觉层的 findings）。

`html_create` 传 `strict_design=true` 时，warning 升级为校验失败——和 Art Direction 的 strict 行为一致，先改设计再重跑，不要绕过。

## 九条机器规则

下表逐字对应 `src/design-rules.ts` 的 `DESIGN_RULES`。`ID`、`law`（skill 的条款号；标注 `plugin convention` 的是插件约定）、`invariant` 与源码完全一致；阈值是实现里真正在跑的判定，不是建议值。

| ID | 出处（law） | 不变量（invariant） | 阈值 / 判定 | 告警出现在哪里 |
| :--- | :--- | :--- | :--- | :--- |
| `RUI_TEXT_COLOR_EXCESS` | §2.2.a | At most three text colours carry the hierarchy of a page. | 一页去重后的文字颜色 > 3 种。按浏览器计算并合成 opacity / alpha 后的有效颜色（hex）去重；只统计非装饰文字（`opacity ≥ 0.2`，且不是 ≥48px、与底色对比 <1.5:1 的装饰大字）。 | `design_findings` / `design-validation.json` / `report.json` |
| `RUI_GREY_ON_COLOR` | §2.3 | De-emphasised text on a coloured field is hand-picked at the field hue, never grey or white at reduced opacity. | 文字 HSL 饱和度 ≤ 20% 且明度落在 25%–88%（近白与近黑不算灰：白字或深色字在彩色底上是合法的强对比强调）且**底**饱和度 ≥ 25%、明度落在 15%–85%（近白纸色与近黑墨色不算「彩色底」，HSL 饱和度在接近白/黑时会虚高）即判。底未知（渐变 / 图片）时不判。「白色 + 降透明度」不是本条的判定路径：半透明文字会先合成到实色底上，合成后的颜色通常仍带底色色相、饱和度不低，主要风险落在对比度上；要弱化文字仍应按底色色相重新取色。 | `design_findings` / `design-validation.json` / `report.json` |
| `RUI_CONTRAST_LOW` | §5.6 | Normal text clears 4.5:1 against its field; large text (≥24px, or ≥18.66px bold) clears 3:1. | 对合成后的文字色与实色底做 WCAG 2.1 相对亮度实算：正文 < 4.5:1 判，大字 < 3:1 判。大字 = 字号 ≥ 24px，或字号 ≥ 18.66px 且字重 ≥ 700。只审实色底；比例按显示精度（两位小数）比较，避免出现「4.50:1 低于 4.5:1」的自相矛盾消息。 | `design_findings` / `design-validation.json` / `report.json` |
| `RUI_MEASURE_TOO_WIDE` | §4.3 | Body copy reads at 45–75 Latin characters (20–35em) per line; the audit alerts above 90 Latin / 50 CJK characters, the widened machine threshold. | 多行正文（行数 ≥ 2）用「总字符数 / 行数」算平均每行：拉丁文字 > 90 字符、或 CJK 字符占比 ≥ 30% 时 > 50 字符，判。45–75（20–35em）是理想读长，告警线放宽到 90 / 50，只抓明显过宽。 | `design_findings` / `design-validation.json` / `report.json` |
| `RUI_LINE_HEIGHT_TIGHT` | §4.5 | Multi-line body copy sets line-height at 1.3× the font size or more. | 多行正文的行高比 `< 1.3×`（`lineHeightPx / fontSize`）判。1.3 是插件按幻灯片密度校准的下限（书中只给 1.5 的起点与「大标题可以到 1」）。浏览器把行高报成 `normal`、拿不到像素值时该条不判，不猜。 | `design_findings` / `design-validation.json` / `report.json` |
| `RUI_WEIGHT_TOO_LIGHT` | §2.2.b | UI text at 26px or below never goes below weight 400. | 字号 ≤ 26px 且字重 < 400 的 UI 文字即判。大字号展示字不受这条限制。 | `design_findings` / `design-validation.json` / `report.json` |
| `RUI_TYPE_SIZE_SCATTER` | §4.1 (cap: plugin convention) | A page draws from one type scale; the plugin caps a page at six distinct sizes. | 一页去重字号（四舍五入到 0.1px）> 6 种即判；消息里列出实际用到的全部字号。§4.1 只要求「用一套字号尺度」，六种上限是插件约定。 | `design_findings` / `design-validation.json` / `report.json` |
| `RUI_FONT_FAMILY_EXCESS` | §4.2 (cap: plugin convention) | A page uses at most two font families; a third only adds noise. | 一页去重字族 > 2 个即判（空字族剔除）。书中没有字族数量条款，这是插件约定（预设提示词早已要求「同一页最多两种字族」）。 | `design_findings` / `design-validation.json` / `report.json` |
| `RUI_LABEL_TRACKING_MISSING` | §4.8.2 | Uppercase text at 20px or below carries at least 0.02em of letter-spacing. | 字号 ≤ 20px、且字距 < 0.02em（即 `0.02 × 字号` px）的全大写标签即判；`text-transform: uppercase` 与直接敲大写（字母全大写、无小写字母）两种写法都算。1em 的字距按当前字号换算。0.02em 是插件校准值。 | `design_findings` / `design-validation.json` / `report.json` |

计数口径统一为「每页去重」；同一页同一条规则最多报一条 finding，消息里列出该页全部违规元素（带 `data-ppt-id`），所以不存在「修一个漏一个」。

## 机器不做什么（判定边界）

- **渐变 / 图片 / 未知底不猜。** 对比度与灰字两条都需要「文字下面只有一个实色」；采集不到单一底色时直接跳过，不算通过也不算失败（其余规则照常判定）。主题级渐变页的文字对比度在 `src/themes.ts` 里单独实算：该页选定的渐变文字色对每个 stop 都按 4.5:1 校验，强调色不在这一项里，不归这一层重复管。
- **幽灵层不算。** 两种装饰性文字整组规则跳过：`opacity < 0.2` 的重影；以及主题海报配方里 ≥48px、与底色对比 <1.5:1 的近底色大字（例如 200px 的 6% 墨色页码数字）——它被允许本来就看不清，也不该算进文字色/字号统计。
- **measure 与 line-height 只判正文。** 判定口径：声明了 `data-art-role="body"` / `"supporting"` 的是正文；声明了其它角色的一律不算；没有声明角色时，字号 ≤ 26px 才算正文（32px 起是文档化的小节标题等展示层级）。旋转文字永远不算正文，单行展示字也不算——它们不需要逐行阅读。
- **只报 warning。** 机器这一层从不自行把页面判死；把 warning 变成失败只有一条路：`html_create` 的 `strict_design=true`。
- **不审排版审美。** 字体层级好不好、留白够不够、海报页是否成立，这些不在 `DESIGN_RULES` 里；它们是主题配方和模型审稿的职责，见下一节。

## 留给审稿人的判断

有些条款依赖「看到渲染结果后的判断」，机器无法替人签字。其中三条已经写入 `DESIGN_REVIEW_PROBES`，由 `src/quality.ts` 追加到 `visual-review.json` 的 `checklist` 里，审稿时必须逐条回答：

> Rank each page: one element should be visibly primary; secondary and tertiary content must be de-emphasised by size, weight or colour rather than competing for attention.
>
> Check group spacing: the space around a content group must exceed the space inside it, and the space between a heading and its body must be smaller than the space that separates it from the next group.
>
> Check colour-only signalling: status, increase/decrease, sequence and category must also be carried by text, icon, position or shape, never by colour alone.

除这三条外，以下法则也要靠审稿判断（§ 引用来自 skill 的审计条款，不是 `RUI_*` 机器规则）：

- **一页一个主角。** 每页应有一个明确的视觉主角；次要内容靠字号、字重、颜色降级，而不是全都做大、加框、加装饰来抢注意力（§2.1 / §2.2）。
- **组间距大于组内间距。** 间距本身在传达分组：组与组之间的空隙必须大于组内元素之间，标题到正文的距离要小于它到下一组的距离（§3.6）。
- **立体感只能靠边框与色阶。** `box-shadow` 被 HTML 白名单禁止，机器只能保证「没有写投影」，不能保证「没有投影时层级仍然读得出来」。审稿要看色阶、边框和间距是否真的建立了层次（§6）。
- **层级排序成立。** 所有内容按重要性排过序：标题 > 关键结论 > 支撑细节；如果三种文字色和六个字号全都在用却没有主次，那就是机器查不出来的失序（§2.1）。

## 怎么写才算照做（作者配方）

1. **先做灰度。** 只用文字、留白和层级把页面排出来，保证去掉颜色后仍然读得懂。颜色是最容易掩盖结构问题的杠杆。
2. **给内容排序。** 每页定一个主角，其余内容主动降级；弱化竞争者，而不是把主角喊得更大声。
3. **再上颜色。** 从主题色板取色，一页最多三级文字色；彩色底上的弱化文字按底色色相重新挑，不用灰字，也不用白色降透明度。
4. **最后做深度与收尾。** 投影不可用，立体感只从 1px / 2px 边框、色阶差、对齐与间距里来。
5. **所有值来自主题的尺度。** 字号从主题 type scale 里取（一页 ≤ 6 级），字族 ≤ 2 个，间距与圆角也用主题给的值，不随手写一次性数值。
6. **交稿前按上面的九条自查一遍**，再让 `html_create` 跑机器审：`warnings` / `design_findings` 里的 `RUI_*` 在 `ppt_create` 之前清掉。

## 维护

- 新增或修改规则**一律从 `src/design-rules.ts` 的 `DESIGN_RULES` 开始**：ID、law、title、invariant 在那里定义，判定在 `designRuleFindings` 里实现，阈值是模块顶部的常量（`MAX_TEXT_COLORS`、`MAX_LATIN_MEASURE` 等），单测在 `tests/unit/design-rules.spec.ts`。
- 本文不定义规则，只解释规则。改完模块必须回来同步第二节的表格与 README 的规则清单，保证文档里的 ID / law / invariant 与源码逐字一致。
- 机器判不了的事情不要塞进 `designRuleFindings`：放进 `DESIGN_REVIEW_PROBES` 或审稿清单，写清判断标准。
