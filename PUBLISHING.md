# 发布清单

这份文件只给维护者看，**不进 npm 包**。所有检查都可以先跑一遍：

```powershell
node tools/check-release.mjs --online   # 32 项，全绿才发
```

当前身份（已写进 `package.json` 和 `packaging/`）：

| 项 | 值 |
|---|---|
| GitHub | `zrrrrrrr77/dsh-breather` |
| npm 包名 | `dsh-breather`（注册表上还没被占用） |
| 列表条目 | `data/plugins/zrrrrrrr7__dsh-breather.yml` |
| 分类 | `session` |

## 1. 仓库

```powershell
cd <插件目录>
git init -b main
git add -A
git commit -m "dsh-breather 0.3.0"
git remote add origin https://github.com/zrrrrrrr77/dsh-breather.git
git push -u origin main
```

- 仓库设为 public，加 **`dsh-plugin`** topic（列表 gate 会看）。
- 列表要求仓库**创建满 1 天**，当天提 PR 可能被拒或搁置，第二天再来。
- `.gitignore` 已经排掉 `node_modules/`、`smoke/out/`、`smoke/vendor/`、`tools/.backup/`。

## 2. npm

Windows 上 `npm` 会走 `npm.ps1` 被策略拦，全程用 `npm.cmd`。

```powershell
npm.cmd login --auth-type=legacy     # 网页登录；不行就用 token
npm.cmd whoami                       # 必须打印用户名
npm.cmd publish
```

- 403 提 2FA：去 npmjs.com 生成 **Granular Access Token**，权限 Read and write，
  **勾上 Bypass two-factor authentication**，然后
  `npm.cmd config set "//registry.npmjs.org/:_authToken=npm_xxx"`。
- 只出现 `0.0.0-stage`：暂存发布待批准，等 3 分钟；没放行就去 npmjs.com → Staged Packages → Approve。
- 验证：`npm.cmd view dsh-breather version` 必须回真实版本号。
- **改任何东西都要先 bump `version`**（同版本不能重发）；发错了基本删不掉，用
  `npm.cmd deprecate dsh-breather@<ver> "superseded by <new>"` 兜底。

## 3. 列表 PR

把 `packaging/awesome-dsh-plugin.yml` 的内容放进 awesome-dsh-plugin 仓库的
`data/plugins/zrrrrrrr7__dsh-breather.yml`，**一个 PR 只加这一个文件**。

- PR 里勾上 *Allow edits by maintainers*。
- fork 的 PR 首次要等维护者点批准才会跑 CI（页面显示 `1 workflow awaiting approval`），
  不是写错了。
- 不要在 PR 里手改 README——两个 README 都是生成物。

## 4. 市场索引

DSH 0.2.1+ 的「插件 → 发现」默认没有数据源，手动加一次：

```
https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json
```

索引由 `data/plugins/*.yml` + npm 映射夜间生成，**收录进列表 ≠ 市场立刻能搜到**：
要等夜间批处理（几小时到一天）。包与仓库的关联靠 `package.json` 的 `repository`，不要手写 `npm:`。

## 5. 验收

```powershell
npm.cmd view dsh-breather version
dsh plugin --profile desktop add dsh-breather    # 能装、能启动
```

- `https://www.npmjs.com/package/dsh-breather` 能打开，README 里有图有安装命令
- `https://awesome-dsh-plugin.com/p/zrrrrrrr77/dsh-breather/` 有页面，安装块显示 npm + 版本
- `.../en/p/zrrrrrrr77/dsh-breather/` 是英文（不是 "Chinese only"）
- 「插件 → 发现」能搜到

## 6. 发版之后

```powershell
# 改代码
npm.cmd version 0.3.1 --no-git-tag-version
npm test && node tools/check-release.mjs
npm.cmd publish
```

版本号同时要改 `client.js` 的 `STYLE_VERSION`（`check-release` 会比对，忘了会失败）。
`dsh plugin add` 装的是新版本，但用户得**完全重启 DSH** 才会加载新宿主半。

## 7. 本机不用换成"正式安装"

结论：**别动主 profile**。开发机现在是"Junction + 手写 patch row"，旧包名 `dsh-session-pause`
照样能被 Node 按目录名解析，重启不会坏事；包名对不上只影响 `dsh plugin list` 的观感。

换装反而有两个坑：

1. **顺序坑**：一旦 `remove` 了旧依赖却留着 profile 里手写的那行 row，DSH 下次启动直接报
   找不到模块。真要换，唯一正确的顺序是「先删 row → 再 remove → 再 add」，而且中间别重启。
2. **更隐蔽的坑**：`pnpm add/install/remove` 会把没写进 `dependencies` 的手装插件目录挪进
   `node_modules\.ignored\`（本机的 `dsh-session-folder`、`dsh-session-delete` 都是这类），
   换一个插件的手续会顺手弄坏另外两个。

验证"发布出去的包"用**一次性 profile**，主 profile 零风险：

```powershell
dsh --profile breathe-test --from-default-profile desktop
dsh plugin --profile breathe-test add dsh-breather     # 未发布时可 add <插件目录>
dsh --profile breathe-test                             # 起来点一遍
```

验完把这个 profile 目录整个删掉即可。

## 8. 顺序总览

| 何时 | 做什么 | 为什么 |
|---|---|---|
| 第 1 天 | 建仓库、push、打 `dsh-plugin` topic | 列表要求仓库**创建满 1 天** |
| 第 1 天 | `npm publish`、验 `npm view` | 与仓库年龄无关，可以同一天 |
| 第 2 天 | 提列表 PR（一个文件） | 满 24h 后 gate 才认 |
| 合并后 | 等夜间批处理刷新 `index.json` | 收录 ≠ 市场立刻搜到 |
| 任意时候 | 在「插件 → 发现」加一次索引源 | 0.2.1+ 默认没有数据源 |

## 9. 常见故障速查

| 现象 | 原因 |
|---|---|
| 安装报 `engines.dsh` 不满足 | 范围下界少了 `-0`，semver 不匹配 `0.2.1-rc.x` |
| `dsh plugin add` 后功能没出现 | 宿主半要重启；或 profile 里还留着旧的同名 row |
| 按钮点不动 / 出现两个按钮 | 插件被挂两次（手写 row + bundle 行） |
| 市场搜不到 | 没发 npm / 没轮到夜间批处理 / 没加索引源 |
| 卡片描述半句话 | 描述超过 160 字符被截断 |
| 英文详情页一直 Chinese only | 缺 `README.en.md`，或缓存未刷新（最长一天） |
