/**
 * dsh-search — model-callable web search for dsh, no API keys required.
 *
 * Registers the `web_search_free` tool. The harness's built-in `web_search`
 * routes through `ctx.web` providers (DeepSeek / Perplexity / Exa) that need
 * paid API keys and fail in deployments without one; this plugin is the
 * self-contained alternative:
 *
 *  1. Bing RSS (`format=rss`) — primary backend, keyless, works on www.bing.com
 *     and cn.bing.com alike.
 *  2. DuckDuckGo HTML — automatic fallback when Bing is unreachable.
 *
 * The tool is registered into `ctx.tools` exactly like any harness tool, so
 * every model that speaks the tool protocol can use it — models without a
 * native search capability included.
 *
 * Host-only plugin: no browser half, no RPC gateway. Config is read directly
 * (no schemastery dependency): `maxResults` (1–20, default 8),
 * `timeoutMs` (default 30000), `bingEndpoint` (default
 * https://www.bing.com/search), `useDuckDuckGoFallback` (default true).
 */

export const name = 'dsh-search'

/** Services this plugin mounts into. */
export const inject = ['tools', 'systemPrompt']

/** The model-facing tool name (the built-in `web_search` name is taken). */
export const TOOL_NAME = 'web_search_free'

const DEFAULT_MAX_RESULTS = 8
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_BING_ENDPOINT = 'https://www.bing.com/search'
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/** Validate and normalize plugin config; throws on bad values. */
export function resolveConfig(config = {}) {
  const maxResults = config.maxResults ?? DEFAULT_MAX_RESULTS
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const bingEndpoint =
    typeof config.bingEndpoint === 'string' && config.bingEndpoint.length > 0
      ? config.bingEndpoint
      : DEFAULT_BING_ENDPOINT
  const useFallback = config.useDuckDuckGoFallback !== false
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 20) {
    throw new Error(`dsh-search: maxResults must be an integer in [1, 20], got ${JSON.stringify(config.maxResults)}`)
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000) {
    throw new Error(`dsh-search: timeoutMs must be an integer >= 1000, got ${JSON.stringify(config.timeoutMs)}`)
  }
  return { maxResults, timeoutMs, bingEndpoint, useFallback }
}

/** Decode the handful of XML/HTML entities search results actually contain. */
export function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = parseInt(entity.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    if (entity.startsWith('#')) {
      const code = parseInt(entity.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    const named = {
      amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
      nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘',
    }
    return named[entity] ?? match
  })
}

/** Remove HTML tags and collapse whitespace. */
export function stripTags(text) {
  return text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}

/** Extract one tag's text content from an RSS item body. */
function tagText(xml, tag) {
  const pattern = '<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + tag + '>'
  const match = xml.match(new RegExp(pattern))
  return match ? decodeEntities(match[1]).trim() : ''
}

/** Best-effort RFC-3339 date from a locale-dependent RSS pubDate; undefined when unparseable. */
export function normalizeDate(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return undefined
  const parsed = Date.parse(raw)
  if (!Number.isNaN(parsed)) return new Date(parsed).toISOString()
  return undefined
}

/** Run one Bing RSS query and shape the sources. Throws on HTTP/parse failure. */
export async function searchBing(query, maxResults, endpoint, signal) {
  const url = `${endpoint}?q=${encodeURIComponent(query)}&format=rss&count=${maxResults}`
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, accept: 'application/rss+xml, application/xml, text/xml, */*' },
    signal,
    redirect: 'follow',
  })
  if (!res.ok) throw new Error(`Bing search failed with HTTP ${res.status}`)
  const xml = await res.text()
  const itemBodies = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1])
  const sources = []
  for (const body of itemBodies) {
    const urlText = tagText(body, 'link')
    if (urlText.length === 0 || !/^https?:\/\//i.test(urlText)) continue
    const title = tagText(body, 'title')
    const snippet = stripTags(tagText(body, 'description'))
    const publishedAt = normalizeDate(tagText(body, 'pubDate'))
    const source = { url: urlText }
    if (title.length > 0) source.title = title
    if (snippet.length > 0) source.snippet = snippet
    if (publishedAt !== undefined) source.publishedAt = publishedAt
    sources.push(source)
    if (sources.length >= maxResults) break
  }
  return { sources, truncated: itemBodies.length > maxResults }
}

/** Resolve a DuckDuckGo result href (redirect link) to the real URL. */
export function resolveDdgHref(href) {
  try {
    const u = new URL(href, 'https://html.duckduckgo.com')
    // Sponsored results link through duckduckgo.com/y.js — drop them.
    if (u.hostname === 'duckduckgo.com' && u.pathname === '/y.js') return undefined
    const target = u.searchParams.get('uddg')
    if (target !== null) {
      const decoded = decodeURIComponent(target)
      if (/^https?:\/\//i.test(decoded)) return decoded
    }
    return u.href
  } catch {
    return undefined
  }
}

/** Run one DuckDuckGo HTML query and shape the sources. Throws on HTTP/parse failure. */
export async function searchDuckDuckGo(query, maxResults, signal) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal, redirect: 'follow' })
  if (!res.ok) throw new Error(`DuckDuckGo search failed with HTTP ${res.status}`)
  const html = await res.text()
  const linkMatches = [...html.matchAll(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)]
  const snippetMatches = [...html.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)]
  const sources = []
  for (let i = 0; i < linkMatches.length && sources.length < maxResults; i++) {
    const [, rawHref, rawTitle] = linkMatches[i]
    const urlText = resolveDdgHref(rawHref)
    if (urlText === undefined) continue
    const title = stripTags(decodeEntities(rawTitle))
    const snippet = snippetMatches[i] !== undefined ? stripTags(decodeEntities(snippetMatches[i][1])) : ''
    const source = { url: urlText }
    if (title.length > 0) source.title = title
    if (snippet.length > 0) source.snippet = snippet
    sources.push(source)
  }
  return { sources, truncated: linkMatches.length > maxResults }
}

/** Render one tool result into the model-facing text block. */
export function formatSources(value) {
  const parts = []
  if (value.sources.length > 0) {
    const lines = value.sources.map((source) => {
      const label = source.title !== undefined && source.title.length > 0 ? source.title : source.url
      const meta = []
      if (source.snippet !== undefined && source.snippet.length > 0) meta.push(source.snippet)
      if (source.publishedAt !== undefined && source.publishedAt.length > 0) meta.push(`(${source.publishedAt})`)
      return `- [${label}](${source.url})${meta.length > 0 ? ` — ${meta.join(' ')}` : ''}`
    })
    parts.push(`Sources:\n${lines.join('\n')}`)
  } else {
    parts.push('No results found.')
  }
  if (value.truncated) {
    parts.push(`(Showing the first ${value.sources.length} sources. Refine the query for more.)`)
  }
  parts.push('Cite the relevant URLs above as markdown links in your answer.')
  return parts.join('\n\n')
}

/**
 * Compile one value-schema node, mirroring the harness's schema DSL
 * (packages/core/tools/src/schema.ts): a property's `required: true` marker
 * is consumed by its enclosing property map and becomes the object-level
 * `required: [names]` array; annotations pass through. Without this
 * normalization the tools registry rejects the shorthand.
 */
function compileValue(node) {
  const out = {}
  for (const [key, value] of Object.entries(node)) {
    if (key === 'required') continue // consumed by the enclosing property map
    if (key === 'properties') {
      const compiled = compilePropertyMap(value)
      out.properties = compiled.properties
      if (compiled.required !== undefined) out.required = compiled.required
      continue
    }
    if (key === 'items') {
      out.items = compileValue(value)
      continue
    }
    out[key] = value
  }
  return out
}

/** Compile one property map, collecting per-property requiredness. */
function compilePropertyMap(props) {
  const properties = {}
  const required = []
  for (const [key, value] of Object.entries(props)) {
    properties[key] = compileValue(value)
    if (value !== null && typeof value === 'object' && value.required === true) required.push(key)
  }
  return { properties, required: required.length > 0 ? required : undefined }
}

/**
 * Cordis plugin entry: register the tool and its system-prompt guidance.
 * Registration is effect-scoped — the loader's dispose tears it down.
 */
export function apply(ctx, config = {}) {
  const { maxResults, timeoutMs, bingEndpoint, useFallback } = resolveConfig(config)

  ctx.systemPrompt.section({
    name: 'tool:web_search_free',
    order: 111,
    text: 'Use the web_search_free tool to discover current information on the web. It needs no API key and returns a list of source URLs with snippets. The built-in web_search requires a paid search provider and may fail in this deployment, so prefer web_search_free. Cite the relevant URLs as markdown links in your answer.',
  })

  ctx.tools.register({
    name: TOOL_NAME,
    description:
      'Search the web for current information. No API key required; returns a list of source URLs with snippets. Use this tool when web_search is unavailable or fails.',
    parameters: compilePropertyMap({
      query: { type: 'string', required: true, description: 'The search query.' },
    }),
    output: {
      schema: compileValue({
        type: 'object',
        additionalProperties: false,
        properties: {
          sources: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                url: { type: 'string', required: true },
                title: { type: 'string' },
                snippet: { type: 'string' },
                publishedAt: { type: 'string' },
              },
            },
          },
          truncated: { type: 'boolean', required: true },
        },
      }),
      render: (_args, value) => [{ type: 'text', text: formatSources(value) }],
    },
    timeoutMs,
    // Read-only network call: safe to run in parallel with sibling tools.
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      const query = typeof args.query === 'string' ? args.query.trim() : ''
      if (query.length === 0) throw new Error('web_search_free: query must be a non-empty string')
      const signal = exec?.signal
      const timeout = AbortSignal.timeout(timeoutMs)
      const combined = signal !== undefined ? AbortSignal.any([signal, timeout]) : timeout
      const backends = [() => searchBing(query, maxResults, bingEndpoint, combined)]
      if (useFallback) backends.push(() => searchDuckDuckGo(query, maxResults, combined))
      let lastError
      for (const run of backends) {
        try {
          return await run()
        } catch (error) {
          if (signal !== undefined && signal.aborted) throw error
          lastError = error
        }
      }
      const detail = lastError instanceof Error ? lastError.message : String(lastError)
      throw new Error(
        `web_search_free: search failed across ${backends.length} backend${backends.length > 1 ? 's' : ''} — ${detail}`,
      )
    },
  })
}
