# 服务器部署

运行环境：Node 24、pnpm 10.33.0、PostgreSQL 16、Docker。应用采用 systemd 托管，原型编译和交互检查在限制网络、内存及权限的 Docker runner 中执行。

## 目录和配置

- `/opt/requirements-workbench/releases/<版本>/`：只包含源代码、依赖、前端构建。
- `/opt/requirements-workbench/current`：指向当前版本。
- `/opt/requirements-workbench/runtime`：指向 Node 24 安装目录。
- `/opt/requirements-workbench/shared/.env`：服务端密钥，权限 `0600`。
- `/opt/requirements-workbench/shared/data/`：上传材料与生成原型，独立于版本目录。
- 版本目录的 `.env`、`data` 分别链接到 shared 下对应路径。

在 `.env.example` 基础上配置独立的数据库口令、`SESSION_SECRET`、模型网关和模型密钥。默认会话模型为 `glm-5.3`，图片识别模型单独配置。服务器使用新数据库，不自动迁移本地项目材料。

公网部署需设置 `PUBLIC_ORIGIN=https://prototype.ai-native-lab.com`、内网监听地址 `HOST` 和随机的 `PROXY_ACCESS_TOKEN`（至少 32 字符）。反向代理在验证访问者后，覆盖 `X-Workbench-Token` 请求头；应用仍检查精确 Host 和浏览器 Origin。切勿关闭来源检查或公开数据库端口。

## 启动与更新

1. 创建 `requirements` 系统用户并加入 docker 组。按上述结构准备代码和目录；只给 shared 数据目录写权限。
2. 在版本目录执行 `pnpm install --frozen-lockfile`、`pnpm build`、`docker compose up -d db`。
3. 执行 `pnpm demo:setup` 构建本机架构的 runner。执行 `pnpm demo:verify-modules` 验证编译、交互及未修改模块复用，该命令不调用模型。
4. 安装 `requirements-workbench.service`，切换 current 链接并执行 `systemctl enable --now requirements-workbench`。
5. 渲染 `nginx.conf.template` 中的证书路径、内网地址、入口令牌和密码文件。模板不能直接启用。入口使用 HTTPS 和访问密码；验证 `nginx -t` 后仅 reload。
6. 从域名核对页面、角色切换、材料上传、实时消息及原型预览。未登录应返回 401；直连应用且无入口令牌也应返回 401。

现有身份选择仍用于协作角色切换，不等同于真实的账号权限体系。公网访问密码是本版入口保护，后续可用统一登录替换。

## 运维

查看服务：`systemctl status requirements-workbench`；日志：`journalctl -u requirements-workbench`。数据库由独立的 requirements-workbench Compose 项目管理，不要操作其他服务的数据卷。

升级前备份 PostgreSQL（`pg_dump`）和 shared/data，保留上一个 release。更新失败可恢复 current 链接并重启；如包含数据库结构变更，先核对兼容性再回退。密钥、密码文件、数据及备份禁止提交 Git。

入口机只负责 HTTPS 转发，应用与数据保存在指定部署服务器。Nginx 关闭缓冲并保留长连接，保证消息流和“先显示原型、后台继续检查”正常工作。
