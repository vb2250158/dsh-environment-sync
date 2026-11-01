# 0.8.0 升级说明 / Upgrade guide

插件清单 `config/plugins.json` 的导出版本从 schema 2 升为 schema 3；环境配置文件的版本不变。0.8.0 兼容读取两代插件清单，旧同步器拒绝 schema 3。此检查发生在 profile 写入前，防止旧版在包更名时移除了依赖却仍保留旧 bundle，造成启动失败。

先保存本机 profile 和已验证恢复点，通过同步器或官方 `dsh plugin --profile <profile> add --save-exact <固定 Git 提交 specifier>` 安装 0.8.0，再按本机受管流程加载新版本，最后拉取和应用新清单。仅磁盘安装完成不足以替换内存中已加载的旧同步器；需要重启时先按本机规范保存任务进度并正常停止。不要同时加载新旧选择器包，不要手工覆盖 `node_modules`。

Web 同步只移除基线已接管、当前引用未被本机修改且新清单不再包含的插件，并在冻结安装后移除相应 bundle 引用。未接管插件、用户停用选择和其他 bundle 顺序保持不变。安装失败仍执行原有恢复事务；不要用修改 schema 数字让旧同步器接受新清单。

Plugin manifest exports in `config/plugins.json` advance from schema 2 to schema 3; environment configuration versions do not change. Version 0.8.0 reads both plugin generations. Older synchronizers reject schema 3 before profile writes, avoiding removal of a renamed dependency while its retired bundle remains selected.

Save the local profile and a verified recovery point, install 0.8.0 through the synchronizer or official `dsh plugin --profile <profile> add --save-exact <fixed Git commit specifier>`, load that version through the local managed procedure, then pull and apply the new manifest. An on-disk installation does not replace an already loaded synchronizer. Preserve task progress and stop normally before any required restart. Do not load both selector packages or copy over `node_modules`.

Web synchronization removes only baseline-owned plugins whose local references are unchanged and which are absent from the desired manifest; their bundle references are removed after the frozen installation. Unmanaged plugins, disabled choices and other bundle order remain intact. Existing recovery transactions still handle installation failures. Do not edit the schema number to bypass an old synchronizer's rejection.
