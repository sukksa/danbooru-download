# danbooru-tag-downloader

按标签批量下载 [Danbooru](https://danbooru.donmai.us) 图片的命令行工具。

## 环境要求

| 项目 | 要求 |
| --- | --- |
| Node.js | ≥ 16 |
| 网络 | 能访问 `danbooru.donmai.us` 和 `cdn.donmai.us` |
| 代理 | 视网络环境而定，非必需 |

## 快速开始

```bash
git clone https://github.com/sukksa/danbooru-download.git
cd danbooru-download

node danbooru_dl.js tag
```

图片保存到 `downloads/`，文件名为帖子 ID。

## 配置

脚本顶部的 `CONFIG` 块用于存放账号和代理，改完直接运行即可，不必每次敲参数：

```js
const CONFIG = {
  user: '',    // 用户名
  apiKey: '',  // profile 页面 Generate API key
  proxy: '',   // 留空自动探测，如 http://127.0.0.1:7897
};
```

## 用法

```bash
node danbooru_dl.js <标签或URL> [选项]
```

第一个参数既可以是标签，也可以直接粘贴帖子列表页的 URL：

```bash
node danbooru_dl.js tag
node danbooru_dl.js "https://danbooru.donmai.us/posts?tags=tag"
```

多个标签用**空格**分隔：

```bash
node danbooru_dl.js "tag tag2"
```

支持 Danbooru 原生搜索语法，例如 `rating:g`、`score:>10`、`id:<1000000`。

### 参数

| 参数 | 说明 | 默认值 |
| --- | --- | --- |
| `-o, --out <dir>` | 保存目录 | `./downloads/<标签>` |
| `-w, --workers <n>` | 并发下载数 | `4` |
| `--limit <n>` | 最多下载多少个帖子 | 不限 |
| `--variant <v>` | `original` / `sample` / `preview` | `original` |
| `--rating <r>` | 按分级过滤，如 `g` 或 `g,s` | 不限 |
| `--min-score <n>` | 只下分数 ≥ n 的帖子 | 不限 |
| `--proxy <url>` | 代理地址，填 `none` 表示直连 | 自动探测 |
| `--user <name>` | Danbooru 用户名 | 空 |
| `--api-key <key>` | Danbooru API Key | 空 |
| `--timeout <ms>` | 单请求超时 | `30000` |
| `--retries <n>` | 失败重试次数 | `3` |
| `--max-pages <n>` | 最多翻多少页 | `1000` |
| `--overwrite` | 覆盖已存在的同名文件 | 关闭 |
| `--dry-run` | 只统计数量，不下载 | 关闭 |
| `-h, --help` | 显示帮助 | — |

### 示例

```bash
# 查看有多少条
node danbooru_dl.js "tag tag2" --dry-run

# 指定目录、8 并发、20 张
node danbooru_dl.js tag -o D:/pics/tag -w 8 --limit 20

# safe 分级、分数 ≥ 10 的
node danbooru_dl.js tag --rating g --min-score 10

# 手动指定代理
node danbooru_dl.js tag --proxy http://127.0.0.1:7897
```

## 输出结构

```
downloads/
└── tag/
    ├── 12028346.jpg
    ├── 10759970.png
    └── _metadata.jsonl
```

文件名为 `<帖子ID>.<扩展名>`。

`_metadata.jsonl` 每行一条记录：

```json
{"id":11025681,"md5":"e60fb...","file_ext":"jpg","file_size":442338,"width":2048,"height":1448,"rating":"g","score":12,"source":"https://x.com/...","created_at":"2026-03-25T10:21:17-04:00","tags":"...","url":"https://cdn.donmai.us/original/..."}
```

## 代理

Danbooru 在部分网络环境下无法直连。脚本内置了 HTTP CONNECT 隧道，可用任意本地代理：

```bash
node danbooru_dl.js tag --proxy http://127.0.0.1:7897
```

## 注意事项

- 请遵守 [Danbooru 的服务条款](https://danbooru.donmai.us/wiki_pages/help:terms_of_service)，控制请求频率,官方建议长时间任务维持在 1 请求/秒左右，全局硬上限是 10 请求/秒
- 本工具仅用于个人归档与研究，下载内容的版权归原作者所有，请勿二次分发

## License

[MIT](LICENSE)
