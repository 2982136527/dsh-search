# dsh-search

一个无需 API key 的 dsh 网页搜索插件：注册模型可调用的 `web_search_free` 工具，
内置 Bing RSS（主后端）与 DuckDuckGo（自动降级）双后端，任意模型都能直接搜索。

## 为什么需要它

Harness 内置的 `web_search` 走 `ctx.web` 提供商（DeepSeek / Perplexity / Exa），
需要付费 API key；没有配置 key 的部署里它必然报错（如
`Authentication Fails, Your api key: 1 is invalid`）。本插件完全自包含：
不需要任何 key，模型只多了一个可用的 `web_search_free` 工具。

## 工具

| 工具名 | 参数 | 说明 |
| --- | --- | --- |
| `web_search_free` | `query`: string (必填) | 返回 `{ sources: [{url,title,snippet,publishedAt?}], truncated }`；渲染为 markdown 来源列表 |

系统提示词中也会注入引导：告知模型优先使用 `web_search_free`（内置 `web_search`
可能失败）。

## 后端

1. **Bing RSS**（`https://www.bing.com/search?q=...&format=rss`）—— 主后端，
   www.bing.com 与 cn.bing.com 均可用。
2. **DuckDuckGo HTML** —— 主后端失败时自动降级，过滤赞助商链接。

## 安装

```sh
dsh plugin --profile web add /path/to/dsh-search
```

然后重启 `dsh web`。

## 配置（可选，通过 profile patch 传入）

- `maxResults`: 1–20，默认 8
- `timeoutMs`: 默认 30000
- `bingEndpoint`: 默认 `https://www.bing.com/search`（可换 cn.bing.com）
- `useDuckDuckGoFallback`: 默认 true

## 开发

```sh
node --check lib/index.js        # 语法检查
node --input-type=module -e "..." # 直接调用 searchBing / searchDuckDuckGo 实测
```

纯宿主端插件：无构建步骤，无浏览器端，lib/ 即源码。
