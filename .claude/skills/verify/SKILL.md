---
name: verify
description: Drive the built content script in real headless Chrome against a local stub backend, to observe translation rendering, batch concurrency, and collection cost at runtime.
---

# Verify (网页双语翻译)

内容脚本的真实表面是**浏览器页面**，不是单测。jsdom 不模拟真实布局，
`getComputedStyle` / `getBoundingClientRect` 的开销和结果都与 Chrome 不同，
采集路径的性能和落地范围必须在真实 Chrome 里看。

## 前提

- 无 playwright / puppeteer。直接用 `/Applications/Google Chrome.app` 的
  `--headless=new`，配 `mktemp -d` 的临时 profile（**别碰用户的 Chrome profile**）。
- 改了 `src/content/*.js` 必须先 `npm run build-content` 生成 `src/content.js`——
  页面加载的是拼接产物，不是模块源文件。

## 手法

搭一个本地 HTTP 服务同时扮演两个角色：

1. **发页面**：构造体量接近真实长文的 DOM（嵌套 div、带内联链接的 li、引用块）。
2. **扮演 background service worker**：页面里注入 `window.chrome`，把
   `chrome.runtime.sendMessage({type:"TRANSLATE_BATCH"})` 转成真实 HTTP 请求。
   服务端因此能直接观测**同时在飞的批次数**——这是并发改动唯一可信的测量点。
   `chrome.storage.local` 用内存对象顶掉。

内容脚本的真实入口是 background 发来的消息，照原样触发：

```js
window.__listener({ type: "TRANSLATE_PAGE", jobId: "x",
  settings: { backend: "local", targetLanguage: "zh-CN",
              viewMode: "bilingual", maxSegments: 220 } }, {}, () => {});
```

轮询 `GET_PAGE_STATE` 等到 `status === "done"`，再 POST 结果给服务端；
服务端打印后自行 `process.exit`，脚本据此判断跑完。

## 坑

- **别用 `--virtual-time-budget`**：它会冻结页面时钟，真实 fetch 一挂就永远等不到
  预算耗尽，命令直接超时；而且页面侧测出的耗时全部失真。让页面自己跑完再 POST。
- **`--screenshot` 会阻塞到页面 settle**，配真实网络容易吃满超时。图其实在超时前
  就已经写盘了，`ls` 一下确认即可。
- **`maxSegments` 是整轮预算（默认 220）**：想观测 MutationObserver 触发的第二轮
  扫描，页面必须小到第一轮用不完预算，否则第二轮一个批次都不会发。
- **端口要错开**：并排跑新旧两版时用不同端口，否则前一个服务没退干净会串。

## 值得驱动的几条流

| 目的 | 页面形状 |
|---|---|
| flow 路径（带内联链接的段落/li） | 默认，正文含 `<a>` |
| element / heading 路径 | 整页去掉 `<a>`——同时压 `collectFlowCandidates` 里"无链接直接跳过容器"那条捷径 |
| 混合候选（压 `removeAncestorConflicts`） | 小页面（~8 节），四种 targetType 会同时出现 |
| 预热批是否只跑一次 | 小页面 + 翻完后 append 新 section，看第二轮首批与次批的间隔 |

比对新旧版本时，除了耗时，务必逐条比对**译文集合**和
`[data-ai-page-translator]` 的 `targetType` 分布——性能改动不该改变落地范围。
