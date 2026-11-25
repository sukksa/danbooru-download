#!/usr/bin/env node
/**
 * danbooru_dl.js — 按标签批量下载 Danbooru 图片
 *
 *   node danbooru_dl.js kerorira
 *   node danbooru_dl.js "https://danbooru.donmai.us/posts?tags=kerorira" -w 8
 *
 */

'use strict'

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const http = require('node:http')
const https = require('node:https')
const tls = require('node:tls')
const net = require('node:net')
const { URL } = require('node:url')

const API_BASE = 'https://danbooru.donmai.us'
const USER_AGENT = 'danbooru-tag-downloader/1.0 (node; personal archive script)'
const PAGE_SIZE = 200 // API 单页上限

const CONFIG = {
  user: '', // 用户名
  apiKey: '', // profile 页面 API key
  proxy: '', // 留空自动探测，如 http://127.0.0.1:7897
}

// 本机常见代理端口，按命中概率排序
const PROXY_CANDIDATES = [
  'http://127.0.0.1:7897',
  'http://127.0.0.1:7890',
  'http://127.0.0.1:7891',
  'http://127.0.0.1:7892',
  'http://127.0.0.1:10809',
  'http://127.0.0.1:1080',
  'http://127.0.0.1:20171',
]

const VARIANT_FIELD = {
  original: 'file_url',
  sample: 'large_file_url',
  preview: 'preview_file_url',
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

function log(msg = '') {
  process.stdout.write(msg + '\n')
}

class HttpError extends Error {
  constructor(status, body = '') {
    super(`HTTP ${status}${body ? ' — ' + body.slice(0, 200) : ''}`)
    this.status = status
    this.body = body
    this.retryAfter = 0
  }
}

function isRetryable(err) {
  if (typeof err.status === 'number') return [429, 500, 502, 503, 504].includes(err.status)
  return true
}

async function withRetry(fn, { retries, label }) {
  let lastErr
  for (let attempt = 1; attempt <= Math.max(1, retries); attempt += 1) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (!isRetryable(err) || attempt >= retries) break
      const wait = err.retryAfter || Math.min(2 ** attempt, 15)
      log(`    [!] ${label} 失败：${err.message}，${wait}s 后重试（${attempt}/${retries - 1}）`)
      await sleep(wait * 1000)
    }
  }
  throw lastErr
}

class ProxyTunnelAgent extends https.Agent {
  constructor(proxyUrl, options = {}) {
    super({ keepAlive: true, maxSockets: options.maxSockets || 8 })
    const p = new URL(proxyUrl)
    this.proxy = {
      host: p.hostname,
      port: Number(p.port || 80),
      auth: p.username ? `${decodeURIComponent(p.username)}:${decodeURIComponent(p.password || '')}` : '',
    }
  }

  // 先 CONNECT 到代理，再在隧道上套 TLS
  createConnection(options, callback) {
    const targetHost = options.host
    const targetPort = options.port || 443
    let done = false
    const finish = (err, socket) => {
      if (done) return
      done = true
      callback(err, socket)
    }

    const headers = {}
    if (this.proxy.auth) {
      headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(this.proxy.auth).toString('base64')
    }

    const connectReq = http.request({
      host: this.proxy.host,
      port: this.proxy.port,
      method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
      headers,
      timeout: options.timeout || 20000,
    })

    connectReq.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy()
        finish(new Error(`代理 CONNECT 失败：${res.statusCode} ${res.statusMessage || ''}`))
        return
      }
      const tlsSocket = tls.connect(
        {
          socket,
          servername: options.servername || targetHost,
          ALPNProtocols: ['http/1.1'],
        },
        () => finish(null, tlsSocket),
      )
      tlsSocket.once('error', err => finish(err))
    })
    connectReq.once('timeout', () => connectReq.destroy(new Error('连接代理超时')))
    connectReq.once('error', err => finish(err))
    connectReq.end()
  }
}

function tcpReachable(proxyUrl, timeout = 600) {
  return new Promise(resolve => {
    let u
    try {
      u = new URL(proxyUrl)
    } catch {
      return resolve(false)
    }
    const socket = net.connect({ host: u.hostname, port: Number(u.port || 80) })
    const done = ok => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeout, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

class Client {
  constructor({ agent, extraHeaders, timeout }) {
    this.agent = agent
    this.extraHeaders = extraHeaders || {}
    this.timeout = timeout
  }

  headers(extra = {}) {
    return {
      'User-Agent': USER_AGENT,
      Accept: '*/*',
      'Accept-Encoding': 'identity',
      ...this.extraHeaders,
      ...extra,
    }
  }

  getBuffer(url, redirects = 0) {
    return new Promise((resolve, reject) => {
      const u = new URL(url)
      const mod = u.protocol === 'https:' ? https : http
      const req = mod.request(
        {
          hostname: u.hostname,
          port: u.port || undefined,
          path: u.pathname + u.search,
          method: 'GET',
          headers: this.headers({ Referer: API_BASE + '/' }),
          agent: this.agent,
        },
        res => {
          const status = res.statusCode || 0
          if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
            res.resume()
            if (redirects >= 5) return reject(new Error('重定向次数过多'))
            const next = new URL(res.headers.location, url).toString()
            return resolve(this.getBuffer(next, redirects + 1))
          }
          const chunks = []
          res.on('data', c => chunks.push(c))
          res.on('end', () => {
            const body = Buffer.concat(chunks)
            if (status === 200) return resolve(body)
            const text = body.toString('utf8')
            const err = new HttpError(status, text)
            const ra = Number(res.headers['retry-after'] || 0)
            if (ra) err.retryAfter = ra
            reject(err)
          })
          res.on('error', reject)
        },
      )
      req.setTimeout(this.timeout, () => req.destroy(new Error('请求超时')))
      req.once('error', reject)
      req.end()
    })
  }

  async getJson(url, { retries = 3, label = '请求' } = {}) {
    const body = await withRetry(() => this.getBuffer(url).catch(err => this.explain(err)), { retries, label })
    return JSON.parse(body.toString('utf8'))
  }

  // 保留 status，避免 401 被当成可重试错误
  explain(err) {
    if (err instanceof HttpError && err.status === 401) {
      const e = new Error(
        'HTTP 401：认证失败。已配置账号时请检查用户名 / API Key 是否正确；' +
          '未配置时说明这次查询超出了匿名上限（最多 2 个标签）',
      )
      e.status = 401
      throw e
    }
    if (err instanceof HttpError && err.status === 403 && /Just a moment/i.test(err.body)) {
      const e = new Error('HTTP 403：被 Cloudflare 的 JS 挑战拦截，通常是 UA 被识别成浏览器导致，请不要改 User-Agent')
      e.status = 403
      throw e
    }
    throw err
  }

  downloadTo(url, filePath, redirects = 0) {
    return new Promise((resolve, reject) => {
      const u = new URL(url)
      const mod = u.protocol === 'https:' ? https : http
      const req = mod.request(
        {
          hostname: u.hostname,
          port: u.port || undefined,
          path: u.pathname + u.search,
          method: 'GET',
          headers: this.headers({ Referer: API_BASE + '/' }),
          agent: this.agent,
        },
        res => {
          const status = res.statusCode || 0
          if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
            res.resume()
            if (redirects >= 5) return reject(new Error('重定向次数过多'))
            const next = new URL(res.headers.location, url).toString()
            return resolve(this.downloadTo(next, filePath, redirects + 1))
          }
          if (status !== 200) {
            const chunks = []
            res.on('data', c => chunks.push(c))
            res.on('end', () => {
              const err = new HttpError(status, Buffer.concat(chunks).toString('utf8'))
              const ra = Number(res.headers['retry-after'] || 0)
              if (ra) err.retryAfter = ra
              reject(err)
            })
            return
          }

          const total = Number(res.headers['content-length'] || 0)
          let got = 0
          res.on('data', c => {
            got += c.length
          })
          const ws = fs.createWriteStream(filePath)
          ws.on('error', reject)
          ws.on('finish', () => {
            if (total && got !== total) {
              reject(new Error(`数据不完整 ${got}/${total}`))
              return
            }
            resolve(got)
          })
          res.on('error', reject)
          res.pipe(ws)
        },
      )
      req.setTimeout(Math.max(this.timeout, 60000), () => req.destroy(new Error('下载超时')))
      req.once('error', reject)
      req.end()
    })
  }
}

async function probeProxy(clientOptions) {
  const client = new Client({ ...clientOptions, timeout: 8000 })
  try {
    const data = await client.getBuffer(`${API_BASE}/posts.json?limit=1`)
    return Array.isArray(JSON.parse(data.toString('utf8')))
  } catch {
    return false
  }
}

async function resolveProxy(cliProxy, { timeout }) {
  if (cliProxy) {
    const lower = cliProxy.toLowerCase()
    if (['none', 'direct', 'off'].includes(lower)) {
      log('[i] 按参数要求直连（不使用代理）')
      return null
    }
    log(`[i] 使用指定代理 ${cliProxy}`)
    return cliProxy
  }

  const envProxy =
    process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy

  const candidates = []
  for (const cand of PROXY_CANDIDATES) {
    if (await tcpReachable(cand)) candidates.push(cand)
  }
  if (envProxy) {
    const isLocal = /^(https?:\/\/)?(127\.0\.0\.1|localhost|\[::1\])/i.test(envProxy)
    if (!isLocal || !candidates.includes(envProxy)) {
      if (!isLocal) candidates.push(envProxy)
      else if (await tcpReachable(envProxy)) candidates.push(envProxy)
    }
  }

  for (const cand of candidates) {
    log(`[i] 测试代理 ${cand} …`)
    if (await probeProxy({ agent: new ProxyTunnelAgent(cand), timeout })) {
      log(`[i] 代理可用：${cand}`)
      return cand
    }
  }

  log('[!] 未找到可用代理，尝试直连')
  if (await probeProxy({ agent: new https.Agent({ keepAlive: true }), timeout })) return null

  throw new Error(
    '无法连接 danbooru.donmai.us。请确认代理软件已开启，或用 --proxy 手动指定，例如：' +
      '--proxy http://127.0.0.1:7897',
  )
}

const USAGE = `用法：node danbooru_dl.js <标签或URL> [选项]

账号 / 代理可以直接写在脚本顶部的 CONFIG 里（留空则改用命令行或环境变量）。

选项：
  -o, --out <dir>        保存目录（默认 ./downloads/<标签>）
  -w, --workers <n>      并发下载数（默认 4）
      --limit <n>        最多下载多少个帖子（调试用）
      --variant <v>      original（默认）| sample | preview
      --rating <r>       按分级过滤，如 g 或 g,s（额外占用一个标签位）
      --min-score <n>    只下分数 >= n 的帖子
      --proxy <url>      代理地址，如 http://127.0.0.1:7897；填 none 表示直连
      --user <name>      Danbooru 用户名
      --api-key <key>    Danbooru API Key
      --timeout <ms>     单请求超时毫秒（默认 30000）
      --retries <n>      失败重试次数（默认 3）
      --max-pages <n>    最多翻多少页（默认 1000）
      --overwrite        覆盖已存在的同名文件
      --dry-run          只统计数量，不下载
  -h, --help             显示帮助

示例：
  node danbooru_dl.js "https://danbooru.donmai.us/posts?tags=kerorira"`

const firstNonEmpty = (...values) => values.find(v => v !== undefined && v !== null && String(v).trim() !== '')

function parseArgs(argv) {
  const opts = {
    workers: 4,
    variant: 'original',
    timeout: 30000,
    retries: 3,
    maxPages: 1000,
    overwrite: false,
    dryRun: false,
    help: false,
  }
  const positional = []
  const valueOpts = {
    '-o': 'out',
    '--out': 'out',
    '-w': 'workers',
    '--workers': 'workers',
    '--limit': 'limit',
    '--variant': 'variant',
    '--rating': 'rating',
    '--min-score': 'minScore',
    '--proxy': 'proxy',
    '--user': 'user',
    '--api-key': 'apiKey',
    '--timeout': 'timeout',
    '--retries': 'retries',
    '--max-pages': 'maxPages',
  }

  for (let i = 0; i < argv.length; i += 1) {
    let arg = argv[i]
    if (arg === '-h' || arg === '--help') {
      opts.help = true
      continue
    }
    if (arg === '--overwrite') {
      opts.overwrite = true
      continue
    }
    if (arg === '--dry-run') {
      opts.dryRun = true
      continue
    }

    let inlineValue = null
    if (arg.startsWith('--') && arg.includes('=')) {
      const idx = arg.indexOf('=')
      inlineValue = arg.slice(idx + 1)
      arg = arg.slice(0, idx)
    }

    const key = valueOpts[arg]
    if (!key) {
      if (arg.startsWith('-')) throw new Error(`未知参数：${arg}`)
      positional.push(arg)
      continue
    }
    const value = inlineValue !== null ? inlineValue : argv[++i]
    if (value === undefined) throw new Error(`参数 ${arg} 缺少值`)
    opts[key] = value
  }

  if (!positional.length && !opts.help) throw new Error('缺少标签参数')
  opts.target = positional[0]

  // 命令行 > CONFIG > 环境变量
  opts.user = firstNonEmpty(opts.user, CONFIG.user, process.env.DANBOORU_USER)
  opts.apiKey = firstNonEmpty(opts.apiKey, CONFIG.apiKey, process.env.DANBOORU_API_KEY)
  opts.proxy = firstNonEmpty(opts.proxy, CONFIG.proxy, process.env.DANBOORU_PROXY)

  opts.workers = Math.max(1, Number(opts.workers) || 4)
  opts.retries = Math.max(1, Number(opts.retries) || 3)
  opts.maxPages = Math.max(1, Number(opts.maxPages) || 1000)
  opts.timeout = Math.max(1000, Number(opts.timeout) || 30000)
  opts.limit = opts.limit === undefined ? undefined : Math.max(0, Number(opts.limit) || 0)
  opts.minScore = opts.minScore === undefined ? undefined : Number(opts.minScore) || 0
  if (!Object.keys(VARIANT_FIELD).includes(opts.variant)) {
    throw new Error(`--variant 只能是 ${Object.keys(VARIANT_FIELD).join(' / ')}`)
  }
  return opts
}

function normalizeTarget(raw) {
  const value = String(raw).trim()
  if (/^https?:\/\//i.test(value)) {
    const u = new URL(value)
    const tags = u.searchParams.get('tags')
    if (!tags) throw new Error(`URL 里没有 tags 参数：${raw}`)
    return tags.trim()
  }
  return value
}

function withRating(tags, rating) {
  if (!rating) return tags
  const parts = rating
    .split(',')
    .map(r => r.trim())
    .filter(Boolean)
  return [tags, ...parts.map(r => `rating:${r}`)].join(' ')
}

function sanitizeDirName(tags) {
  const name = tags.replace(/[^\w\-.]+/g, '_').replace(/^_+|_+$/g, '')
  return (name || 'danbooru').slice(0, 80)
}

function pickUrl(post, variant) {
  return post[VARIANT_FIELD[variant]] || post.file_url || post.large_file_url || post.preview_file_url || null
}

async function* fetchPages(client, tags, { retries, maxPages }) {
  const useCursor = !tags.includes('order:')
  let lastId = null
  let page = 1
  let total = 0

  while (page <= maxPages) {
    const query = useCursor && lastId !== null ? `${tags} id:<${lastId}` : tags
    const params = new URLSearchParams({ tags: query, limit: String(PAGE_SIZE) })
    // 用游标时不要再传 page，否则会跳过整页
    if (!useCursor) params.set('page', String(page))

    const url = `${API_BASE}/posts.json?${params.toString()}`
    const posts = await client.getJson(url, { retries, label: `第 ${page} 页` })
    if (!Array.isArray(posts) || posts.length === 0) return undefined
    total += posts.length
    log(`[i] 第 ${page} 页：${posts.length} 条（累计 ${total}）`)
    yield posts

    if (posts.length < PAGE_SIZE) return undefined
    if (useCursor) {
      const ids = posts.map(p => p.id).filter(id => Number.isInteger(id))
      if (!ids.length) return undefined
      lastId = Math.min(...ids)
    }
    page += 1
  }
  return undefined
}

async function countPosts(client, tags, retries) {
  try {
    const data = await client.getJson(`${API_BASE}/counts/posts.json?${new URLSearchParams({ tags }).toString()}`, {
      retries,
      label: '统计数量',
    })
    return data && data.counts ? data.counts.posts : null
  } catch (err) {
    log(`[!] 统计总数失败：${err.message}`)
    return null
  }
}

function makeDownloader(client, { outDir, variant, retries, overwrite }) {
  return async function downloadOne(post) {
    const id = post.id
    const ext = String(post.file_ext || 'jpg').toLowerCase()
    const url = pickUrl(post, variant)
    if (!url) return 'unauth'
    if (ext === 'zip') return 'unauth'

    const dest = path.join(outDir, `${id}.${ext}`)
    const expected = Number(post.file_size) || 0

    if (!overwrite) {
      try {
        const st = await fsp.stat(dest)
        if (!expected || st.size === expected) return 'skip'
        log(`  [~] ${id}: 本地大小不符（${st.size} != ${expected}），重新下载`)
      } catch {}
    }

    const part = `${dest}.part`
    try {
      await withRetry(
        async () => {
          await fsp.rm(part, { force: true })
          return client.downloadTo(url, part)
        },
        { retries, label: `下载 ${id}` },
      )
      await fsp.rename(part, dest)
      return 'ok'
    } catch (err) {
      await fsp.rm(part, { force: true }).catch(() => {})
      log(`  [!] ${id}: 下载失败 ${err.message}`)
      return 'fail'
    }
  }
}

async function runPool(items, limit, worker) {
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      await worker(items[index], index)
    }
  })
  await Promise.all(runners)
}

async function main() {
  const argv = process.argv.slice(2)

  let opts
  try {
    opts = parseArgs(argv)
  } catch (err) {
    log(`错误：${err.message}\n`)
    log(USAGE)
    process.exitCode = 2
    return
  }
  if (opts.help) {
    log(USAGE)
    return
  }

  const tags = withRating(normalizeTarget(opts.target), opts.rating).split(/\s+/).filter(Boolean).join(' ')
  const outDir = path.resolve(opts.out || path.join('downloads', sanitizeDirName(tags)))

  log('='.repeat(66))
  log(`标签     : ${tags}`)
  log(`保存到   : ${outDir}`)
  log(`图片变体 : ${opts.variant}   并发: ${opts.workers}`)
  log('='.repeat(66))

  const proxy = await resolveProxy(opts.proxy, { timeout: opts.timeout })
  const agent = proxy
    ? new ProxyTunnelAgent(proxy, { maxSockets: opts.workers + 2 })
    : new https.Agent({ keepAlive: true, maxSockets: opts.workers + 2 })

  const extraHeaders = {}
  if (opts.user && opts.apiKey) {
    extraHeaders.Authorization = 'Basic ' + Buffer.from(`${opts.user}:${opts.apiKey}`).toString('base64')
    log(`[i] 已启用登录：${opts.user}（可搜索 >2 个标签）`)
  } else if (opts.user || opts.apiKey) {
    log('[!] --user 和 --api-key 需要同时提供，已按匿名模式运行')
  }

  const client = new Client({ agent, extraHeaders, timeout: opts.timeout })

  try {
    const totalExpected = await countPosts(client, tags, opts.retries)
    if (totalExpected != null) log(`[i] 该标签下共 ${totalExpected} 个帖子`)
    else if (tags.split(' ').length > 2 && !extraHeaders.Authorization) {
      log('[!] 标签数超过 2 个且未登录，API 可能返回 401')
    }

    if (opts.dryRun) {
      log('[i] dry-run 模式，仅统计不下载')
      return
    }

    await fsp.mkdir(outDir, { recursive: true })
    const metaPath = path.join(outDir, '_metadata.jsonl')

    const stats = { ok: 0, skip: 0, fail: 0, unauth: 0 }
    let processed = 0
    const started = Date.now()

    // 串行写，避免并发追加互相覆盖
    let metaQueue = Promise.resolve()
    const writeMeta = post => {
      const record = {
        id: post.id,
        md5: post.md5,
        file_ext: post.file_ext,
        file_size: post.file_size,
        width: post.image_width,
        height: post.image_height,
        rating: post.rating,
        score: post.score,
        source: post.source,
        created_at: post.created_at,
        tags: post.tag_string,
        url: pickUrl(post, opts.variant),
      }
      metaQueue = metaQueue.then(() => fsp.appendFile(metaPath, JSON.stringify(record) + '\n', 'utf8')).catch(() => {})
      return metaQueue
    }

    const downloadOne = makeDownloader(client, {
      outDir,
      variant: opts.variant,
      retries: opts.retries,
      overwrite: opts.overwrite,
    })

    for await (const pagePosts of fetchPages(client, tags, {
      retries: opts.retries,
      maxPages: opts.maxPages,
    })) {
      let posts = pagePosts
      if (opts.minScore !== undefined) {
        posts = posts.filter(p => (Number(p.score) || 0) >= opts.minScore)
      }
      if (opts.limit !== undefined) {
        const remain = opts.limit - processed
        if (remain <= 0) break
        posts = posts.slice(0, remain)
      }
      if (!posts.length) continue

      await runPool(posts, opts.workers, async post => {
        const result = await downloadOne(post)
        stats[result] = (stats[result] || 0) + 1
        processed += 1
        if (result === 'ok') await writeMeta(post)

        const elapsed = (Date.now() - started) / 1000
        const rate = processed / Math.max(elapsed, 0.001)
        if (processed % 20 === 0 || result !== 'ok') {
          const total = totalExpected ? ` / 预计 ${totalExpected}` : ''
          log(
            `  进度 ${processed}${total}  成功 ${stats.ok}  跳过 ${stats.skip}  ` +
              `失败 ${stats.fail}  ${rate.toFixed(1)} 个/s`,
          )
        }
      })

      if (opts.limit !== undefined && processed >= opts.limit) break
    }

    await metaQueue
    const elapsed = (Date.now() - started) / 1000
    log('='.repeat(66))
    log(
      `完成：成功 ${stats.ok}，跳过 ${stats.skip}，无权限/无文件 ${stats.unauth}，` +
        `失败 ${stats.fail}，耗时 ${elapsed.toFixed(0)}s`,
    )
    log(`输出目录：${outDir}`)
    log(`元数据：${metaPath}`)
    log('='.repeat(66))
    if (stats.fail > 0) process.exitCode = 1
  } finally {
    agent.destroy()
  }
}

process.on('SIGINT', () => {
  log('\n[!] 已中断。重新执行同一命令即可断点续传。')
  process.exit(130)
})

main().catch(err => {
  log(`\n[×] ${err.message}`)
  process.exitCode = 1
})
