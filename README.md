# 网页双语翻译

一个支持 Chrome、Edge 和 Safari 的 Manifest V3 双语网页翻译扩展。它提取当前网页的可见正文，调用本地 OpenAI 兼容 API 或 DeepSeek API，并在原网页中显示双语译文。

## 功能

- 全页正文翻译
- 双语对照与仅译文模式
- 一键恢复原文
- 本地 OpenAI 兼容 API
- DeepSeek API
- 翻译进度与错误提示
- 页面正文分批发送，API Key 不进入网页上下文
- 本地 API 使用紧凑输入、动态 token 上限、首批预热和后续 2 路 worker，减少本地模型等待时间
- DeepSeek 长页面批次并发翻译，本地 API 默认单路避免模型争抢
- 快捷键翻译当前页面：Windows/Linux `Ctrl+Shift+Y`，macOS `Command+Shift+Y`
- 模型返回格式异常时自动拆分批次重试
- 仅在用户打开扩展时向当前页面注入翻译脚本
- X.com 等动态页面会自动补扫可见内容

## Chrome / Edge 安装

1. 打开 `chrome://extensions/` 或 `edge://extensions/`。
2. 开启“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择本项目根目录。
5. 安装后刷新需要翻译的网页。

## Safari 安装

Safari 版本位于 `safari/网页双语翻译/`，需要使用 Xcode 构建。开发测试可运行：

```bash
./script/build_and_run.sh
```

长期正式使用需要 Apple Developer 证书签名。未签名扩展只适合本机开发调试。

## 本地 API

默认配置适配 LM Studio 提供的 OpenAI 兼容接口：

```text
API 地址：http://127.0.0.1:1234/v1
模型：qwen/qwen3.5-35b-a3b
```

“高质量推理”默认关闭。本地 LM Studio 会收到 `reasoning_effort: "none"`，DeepSeek 会收到
`thinking: { "type": "disabled" }`。开启后两种服务都使用推理模式；
长句和术语通常更稳，但整页翻译会明显变慢。其他本地服务若不支持
`reasoning_effort`，可以开启“高质量推理”。

如果 LM Studio 开启了“Require Authentication”，请在扩展中填写对应
API Token。

Ollama 通常可使用：

```text
API 地址：http://127.0.0.1:11434/v1
模型：填写 Ollama 中已安装的模型名称
```

其他服务只要实现 `POST /chat/completions`，并返回 OpenAI Chat
Completions 结构，也可以直接使用。

## DeepSeek

选择“DeepSeek API”，填写 API Key。默认模型为
`deepseek-v4-flash`，也可切换到 `deepseek-v4-pro`。

## 本地验收服务

这个模拟服务只验证扩展的请求、批处理和页面渲染链路，不评估翻译质量：

```bash
node scripts/mock-openai-server.mjs
```

然后把扩展 API 地址临时改为 `http://127.0.0.1:11434/v1`，模型名可任意
填写，翻译结果会以“测试译文：”开头。

## 开发检查

```bash
npm test
npm run check
```

## Releases

稳定版本会发布到 GitHub Releases。每个 release 会包含对应 tag、更新说明，以及 GitHub 自动生成的源码压缩包。

## MVP 限制

- 默认最多翻译当前页面前 220 个唯一正文片段。
- 继续滚动后出现的新内容可再次点击翻译。
- 复杂站点可能因自身 CSS 导致少量排版变化。
- API Key 保存在 `chrome.storage.local`，适合个人使用；团队产品应改用后端代理。

## 开源协议

MIT License。详见 [LICENSE](LICENSE)。
