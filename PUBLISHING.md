# 发布清单 / Publishing

目标：让 `dsh-space-optimizer` 进入社区精选目录
[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)。
`dsh-plugin.org` 上那 11029 条已验证条目就是从这个目录同步的，所以**进了这里就等于进了插件市场**，
不需要另外向 `api.dsh-plugin.org` 投稿（那个域名只提供目录 JSON，没有投稿接口）。

## 一、前置条件核对

| 收录要求（来自 contributing.md） | 本仓库状态 |
|---|---|
| `package.json` 声明 `dsh.bundle`（**只声明 `dsh.client` 会被 CI 直接拒**） | ✅ `dsh.bundle.patch` → `./cordis.patch.yml` |
| `cordis.patch.yml` 紧邻 `package.json`，插入行的 `name` 与包名一致 | ✅ `name: dsh-space-optimizer` |
| 包根就是仓库根（CI 只读根包 / `packages/`·`plugins/`·`apps/` 子包） | ✅ 本目录整体作为仓库根 |
| 构建产物已提交（git 安装不跑构建） | ✅ `client.js` 就是产物，无构建步骤 |
| 仓库创建满 **1 天** | ⏳ 建仓后需等 1 天才能提 PR |
| 仓库带 `dsh-plugin` topic | ⏳ 建仓后设置 |
| 描述含英文 `: ` 时必须加引号 | ✅ 见下方 YAML，已加引号 |

## 二、建仓并推送

### 快路径：一条命令（推荐）

`tools/publish.mjs` 把这一节所有步骤固化了。令牌只经 **stdin** 交给 `gh`，
不进命令行参数、不进 git remote URL：

```sh
node tools/publish.mjs --dry-run --email you@example.com   # 先看它要做什么，零副作用
node tools/publish.mjs --email you@example.com             # 建仓 + 推送 + 加 topic
node tools/publish.mjs --pr                                # 仓库满 1 天后再提收录 PR
```

令牌来源（按顺序）：`GH_TOKEN` / `GITHUB_TOKEN` 环境变量 → 工作区根的 `.gh-token` 文件。
**必须是经典 PAT，勾 `public_repo` + `read:user`**（细粒度令牌无法建仓库）。
脚本会自动：读登录名 → 写 `LICENSE`（MIT，版权行 = 登录名）→ 补 `package.json` 的
`repository` → `git init` + 首个提交（作者名 = 登录名）→ `gh repo create --public --push`
→ 加 `dsh-plugin` 等 topic → 把收录条目生成到 `dist/awesome-submission/`。

`--pr` 会先查仓库 `created_at`，**不满 1 天直接拒绝并告诉你还差多久**，
不会去提一个必红的 PR。

### 手动路径（想自己掌控每一步时）

先把本目录变成 git 仓库（在本目录内执行）：

```sh
git init -b main
git add -A
git commit -m "feat: DSH 侧栏空间账本插件 dsh-space-optimizer v1.0.0"
```

**路线 A：装了 `gh` 且已 `gh auth login`**

```sh
gh repo create OWNER/dsh-space-optimizer --public --source=. --remote=origin --push
gh repo edit OWNER/dsh-space-optimizer --add-topic dsh-plugin --add-topic deepseek-harness --add-topic dsh
```

**路线 B：没有 `gh`（手动建仓后推送）**

1. 在 GitHub 网页新建空仓库 `dsh-space-optimizer`（**不要**勾选初始化 README，避免首推冲突）
2. ```sh
   git remote add origin https://github.com/OWNER/dsh-space-optimizer.git
   git push -u origin main
   ```
3. 仓库页右上 **About → Topics** 添加 `dsh-plugin`（这一条是硬性要求）

> **本机环境的已知限制**：这里的出口代理没有路由
> `github.com/login/oauth/access_token`，所以 `gh auth login --web`（设备码）**走不通**——
> 只能走上面的 `--with-token`。`api.github.com` 与 git 智能 HTTP 均正常，因此令牌路径可用。

## 三、提 PR 收录（建仓满 1 天后）

`data/plugins/` 下一个插件一个文件，所以永远不会和别人冲突。新增
**`data/plugins/OWNER__dsh-space-optimizer.yml`**：

```yaml
url: https://github.com/OWNER/dsh-space-optimizer
name: OWNER/dsh-space-optimizer
category: session
description:
  en: 'Per-task disk-space ledger in the sidebar with opt-in reclamation of unowned junk; session logs are never trimmed.'
  zh: 侧栏里的每个任务磁盘占用账本，可勾选回收无主垃圾；会话日志绝不被裁剪。
```

分类依据：账本按会话组织，同类条目 `dsh-session-sweeper`、`dsh-session-delete`、
`dsh-archived-conversations`、`dsh-session-insights` 都在 `session`（「💬 会话与消息」）下。
分类选偏了维护者会直接改，不会打回。

```sh
gh repo fork awesome-dsh-plugin/awesome-dsh-plugin --clone
cd awesome-dsh-plugin
git checkout -b add-dsh-space-optimizer
# 把上面的 yml 写入 data/plugins/OWNER__dsh-space-optimizer.yml
git add data/plugins/OWNER__dsh-space-optimizer.yml
git commit -m "Add dsh-space-optimizer"
git push -u origin add-dsh-space-optimizer
gh pr create --repo awesome-dsh-plugin/awesome-dsh-plugin --title "Add dsh-space-optimizer" --body "..."
```

**不要手工编辑两个 README**——它们由 `data/plugins/*.yml` 生成，合并后会在 `main` 上重建。
一个 PR 最多 3 条，且只收插件不收纯聚合包（本插件自己做事，不受此限）。

## 四、可选：不发 npm，改用预构建 tarball

市场客户端的安装入口是 **npm 优先、GitHub 兜底**，所以不发 npm 也能被正常安装
（目录里的 `ic` 字段就是 `dsh plugin --profile web add github:OWNER/dsh-space-optimizer`）。

若想给用户省掉源码构建这一步，把预构建包挂到 GitHub Release，并在投稿 YAML 里加
**可选的 `tarball:` 字段**——商店会优先展示它：

```yaml
url: https://github.com/OWNER/dsh-space-optimizer
name: OWNER/dsh-space-optimizer
category: session
tarball: https://github.com/OWNER/dsh-space-optimizer/releases/download/v1.0.0/dsh-space-optimizer-1.0.0.zip
description:
  en: '…'
  zh: '…'
```

本仓库的 `tools/` 里已有可直接上传的 `dsh-space-optimizer-1.0.0.zip`（见发布产物）。
**不要**在 YAML 里手写 `npm:` 键——npm 映射由 registry 自动采集，手写会被校验拒绝。

## 五、商店截图（已声明）

`package.json` 旁已有 `screenshots.json`：

```json
{ "screenshots": ["assets/screenshot-1-ledger.png", "assets/screenshot-2-freed.png",
                  "assets/screenshot-3-button.png", "assets/screenshot-4-dark.png"] }
```

路径相对该文件、指向仓库内已有的图片，最多 8 张；不声明也行（市场会从 README 自动抽取），
声明只是为了控制展示顺序与内容。**推自己的仓库即可更新截图**，不用再提 PR、不用等维护者。

截图由 `node tools/render-panel.mjs` 生成：把真实组件渲染成 HTML（主题变量取自已安装的
`dsh-client-ui-theme`），再用无头 Chrome/Edge 出图。**图中的任务名与路径是虚构样本**，
不是任何人的真实数据。

## 六、回滚

- 收录未合并：关掉 PR 即可，本仓库不受影响。
- 已合并要下架：向该目录提一个删除 yml 的 PR（修正/移除失效项目的 PR 同样欢迎）。
- 用户侧卸载：`dsh plugin --profile web remove dsh-space-optimizer`。
