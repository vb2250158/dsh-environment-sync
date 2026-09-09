# dsh-environment-sync

DSH 插件管理与多电脑环境同步插件。

## 数据分工

- 每个本人插件使用独立公开 GitHub 仓库，并在目录中显示作者。
- 第三方原版直接记录原作者仓库；第三方修改版使用私有 fork，并记录原作者、原始上游、fork 所有者和固定提交。
- 私有仓库只保存插件清单、固定提交、启停状态、完整配置、`AGENTS.md` 和加密凭据。
- `config/plugins.json` 是跨电脑恢复的期望插件集；当前 profile 的直接依赖是本机已安装插件的唯一真源。管理页使用前者补充固定来源，使用后者生成“本机已安装插件”列表，未登记包也会显示，不能静默遗漏。
- 会话、附件、日志、缓存、数据库和电脑专用覆盖不上传。
- 安装列表支持只导出 `package.json`、没有根模块入口的 bundle；隐藏清单的包通过模块入口定位，缺失安装仍报错。
- `$DSH_HOME/private-sync.local.yaml` 保存当前电脑的路径等覆盖。
- `$DSH_HOME/private-sync.key` 只在电脑之间手工安全传递，不进入 Git。

## 安装

当前发布为 **v0.5.9**；变更与未实现范围见 [CHANGELOG.md](CHANGELOG.md)。

锁定提交后，通过 DSH 官方入口安装管理插件：

```powershell
pnpm dsh plugin --profile web add github:vb2250158/dsh-environment-sync#<commit>
```

首次使用时，在“设置 → 我的插件”填写私有配置仓库和本地目录。

## 同步流程

### 上传当前电脑

“上传改动”会：

1. 记录 profile 中每个 DSH bundle 或 Web client 插件的精确安装来源、原作者、仓库所有者、原始上游与版本；
2. 导出 settings（剔除 `private-sync.local.yaml` 所拥有的字段）、profile/home patch 和 `AGENTS.md`；
3. 使用 AES-256-GCM 与 scrypt 加密凭据；
4. 提交并推送私有配置仓库。

### 新电脑恢复

1. 安装 `dsh-environment-sync`；
2. 配置并克隆私有仓库；
3. 点击“拉取并应用”；
4. 管理插件通过官方 `dsh plugin` 命令按固定提交安装每个插件，并在 pnpm 安装后重新写入固定提交；私有 fork 需要当前电脑具备仓库读取权限；
5. 重启 DSH。

## 同步失败与配置保护

“检查更新”仅获取远端引用，不安装插件或应用配置。“上传改动”包含插件清单导出，“拉取并应用”包含按清单安装，不需要额外执行记录或安装按钮。

安装入口拒绝缺失清单；状态页仍可展示尚未建立清单的仓库。相同精确来源和版本不重复安装。安装命令显式使用目标 profile 所属的 DSH Home。

配置恢复先读取和校验全部文件、解密凭据，再安装插件，最后应用配置。缺失同步密钥不会自动生成替代密钥。快照声明未包含凭据或可选文件时，不恢复残留文件，也不删除目标机器独有文件。配置写入失败会尝试恢复本次已写入的文件；这不构成跨进程崩溃恢复或插件安装的整体回滚。

本机覆盖中的字段从导出快照中剔除；尚未声明为本机字段的配置仍会导出。部署前必须完成各插件字段归属整理。

## Web 健康检查

`scripts/ensure-dsh-web.ps1` 可供 Windows 计划任务调用。它用端口级互斥锁避免并发启动；健康响应存在时立即退出，插件同步写入重启标记或发现同端口孤儿 DSH 进程后才会停止旧实例并以隐藏窗口启动一个 `dsh web --no-open` 进程。脚本要求 `DSH_SOURCE_ROOT` 指向官方 DSH 源码，不会写入官方代码或常驻运行。

## 私有仓库文件

```text
environment.json
settings.yaml
AGENTS.md
cordis.patch.yml
profiles/web/cordis.patch.yml
config/plugins.json
credentials.enc.json
```

## 验证

```powershell
pnpm test
pnpm run check
pnpm pack --dry-run
```

## 许可证

MIT

## Authenticated Web health checks

The Windows health task reads the current launch URL from its local stdout log and uses a cookie session to probe the authenticated root page. Tokens remain in local runtime logs and are not copied into configuration or health-check output.

## Plugin page loading

The client prefetches status after its Remote mounts and shares an in-flight read. Initial loading does not imply an empty plugin list. Reopening shows the last successful snapshot while refreshing; failures retain that snapshot and allow retry. Background reads preserve unsaved repository fields.
