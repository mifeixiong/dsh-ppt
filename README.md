# DSH PPT · 一句话生成专业可编辑 PPT

**中文** | [English](README.en.md)

<p align="center">
  <img src="https://img.shields.io/github/v/release/yejiming/dsh-ppt?style=flat-square" alt="Version">
  &nbsp;
  <img src="https://img.shields.io/github/stars/yejiming/dsh-ppt?style=flat-square" alt="Stars">
  &nbsp;
  <img src="https://img.shields.io/npm/v/@yejiming%2Fdsh-ppt?style=flat-square&label=npm" alt="npm">
  &nbsp;
  <img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License">
</p>
<p align="center">
  <strong>专为职场人打造的 DeepSeek 智能 PPT 创作助手</strong><br>
  <em>一句话生成 · 原生可编辑 PPTX · 智能排版与配色 · 免版权配图 · 自动数据图表 · AI 视觉审稿质检</em>
</p>

<p align="center">

[产品亮点](#产品亮点) · [快速上手](#快速上手) · [使用场景](#使用场景) · [产物说明](#产物说明) · [常见问题](#常见问题) · [开源协议](#开源协议)

</p>

## 产品亮点

做 PPT 总是耗费大量时间找模板、调对齐、排版面？市面上的 AI PPT 要么生成无法修改的“整页死图”，要么模板僵硬千篇一律。

**DSH PPT 让 PPT 制作回归内容本身：**

- 📝 **真正原生可编辑**：生成的不是整页死图，而是标准的 `.pptx` 文件。文字、图形、图表均可在 PowerPoint、Keynote 或 WPS 中随意二次修改与微调。
- 🎨 **专业级版式与审美**：告别套路化模板，AI 根据主题内容智能定制色彩搭配、字体层级与页面构图，呈现高级商务质感。
- 📈 **智能图表与精选配图**：自动搜索合规免版权商业配图，并根据数据自动绘制高品质图表，告别枯燥的大段纯文本。
- 👁️ **AI 视觉闭环审稿**：AI 会把做好的 PPT 真正“渲染并审阅一遍”，自动发现并纠正文字溢出、重叠与排版瑕疵，确保出片品质。
- 🔒 **本地安全与隐私保护**：所有制作与渲染过程在本地安全运行，素材来源与授权清晰记录，商业汇报更放心。

## 快速上手

### 1. 运行环境准备

- **DeepSeek Harness**（DSH 运行时环境）
- 电脑已安装以下任意办公软件（用于高保真渲染与视觉质检）：
  - **macOS**：Keynote 或 Microsoft PowerPoint
  - **Windows**：Microsoft PowerPoint
  - **通用 / Linux**：LibreOffice

### 2. 快速安装

在终端执行以下命令直接从 npm 安装插件：

```bash
# 通过 DSH 插件管理器直接安装
dsh plugin --profile web add @yejiming/dsh-ppt
dsh plugin --profile headless add @yejiming/dsh-ppt
```

> 也可以通过 npm / pnpm 安装到本地项目：
> ```bash
> npm install @yejiming/dsh-ppt
> # 或
> pnpm add @yejiming/dsh-ppt
> ```

### 3. 开始创作

#### 方式一：Web 界面（推荐）
启动 Web 控制台后，新建会话并选择 **「PPT 模式」**，像和设计师沟通一样直接向 AI 提出需求：
```bash
dsh --profile web
```

#### 方式二：命令行极速生成
也可以直接在命令行输入一句话指令，快速生成整套演示文稿：
```bash
dsh --profile headless "为管理层制作一份6页的AI项目季度复盘与规划汇报"
```

## 使用场景

| 场景分类 | 提示词示例 |
| :--- | :--- |
| 📊 **业务复盘 / 述职报告** | *"制作一份 6 页的 Q3 电商运营复盘 PPT，重点突出 GMV 增长、转化漏斗分析及下季度策略"* |
| 💼 **商业计划 / 方案提案** | *"为客户撰写一份关于企业私有化 AI 知识库的解决方案 PPT，8 页，商务科技风"* |
| 📢 **产品发布 / 功能推介** | *"围绕新上线的移动端应用设计一份产品发布宣讲 PPT，突出核心卖点与用户体验升级"* |
| 🎓 **培训分享 / 团队规范** | *"制作一份 5 页的敏捷开发入门与团队协作规范分享 PPT，风格轻松明快、条理清晰"* |

## 产物说明

每次任务完成后，系统会在 `ppt-output/` 目录下生成独立的项目文件夹：

- 📄 **`deck.pptx`**：最终生成的原生 PPT 文件，直接双击用 PowerPoint / Keynote / WPS 打开即可放映或自由编辑。
- 🖼️ **`preview/`**：各页面的高清截图预览，方便在手机、群聊或文档中快速预览与确认效果。
- 📁 **`assets/`**：PPT 中使用的图片素材与高清图表文件，并附带合规版权来源清单。

## 常见问题

<details>
<summary><b>Q: 生成的 PPT 在我的 Office / WPS 里打开会排版错乱吗？</b></summary>
不会。系统内置了多平台字体兼容适配方案（优先采用微软雅黑、苹方、思源黑体等主流系统字体），确保在不同设备与办公软件中打开时文字排版依然稳定美观。
</details>

<details>
<summary><b>Q: 可以把生成的 PPT 导出为 PDF 或直接全屏演示吗？</b></summary>
当然可以！生成的 <code>.pptx</code> 为标准演示文稿格式，支持在 PowerPoint、Keynote 或 WPS 中直接进入演讲者模式放映，或一键导出为 PDF / 演讲备注。
</details>

<details>
<summary><b>Q: 如果对生成的部分页面不满意，该如何调整？</b></summary>
有两种便捷方式：
1. **直接对话修改**：在会话中告诉 AI 调整意见（如“第 3 页换成柱状图对比”、“整体色系调整为商务蓝”）；
2. **本地自由编辑**：直接打开 <code>deck.pptx</code>，像普通 PPT 一样随意修改文字、替换图片或移动排版位置。
</details>

## 开源协议

本项目基于 [MIT License](LICENSE) 开源。
