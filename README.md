# nms-config-ui

NMS 配置文件上传/下发的图形小工具——单 Go 二进制，内嵌单页 UI，`/api/*` 反代到 NMS（同源免 CORS）。

> 自用小工具：与 NMS 前端（08-前端设计那条线）无关，不进 nms 仓，也不写 nmsdocs。
> 上游契约见 nms 仓 `nmsdocs/04-API契约.md` §一/§八。

## 功能

- **连接设置（SSH 隧道）**：页面右上 ⚙ ——输入 NMS 宿主机 IP + SSH 账号密码，工具在服务端建立 SSH 隧道（direct-tcpip）并经其反代 NMS API，页面即刻可见全部节点；无需手动 `ssh -L`。密码只存工具进程内存（不落浏览器/不写日志），host/用户/目标存浏览器本地；断开后回落启动参数 `-upstream` 的静态上游。Host key 校验为 InsecureIgnoreHostKey（自用工具、已知宿主机——介意者勿暴露本工具端口）
- **节点台账**：查看 + 勾选；managed VPS 可下发，router（走 SNMP 任务通道）/idle 等置灰并注明原因
- **配置文件库**：列表 / 上传（同名再传＝追加版本）/ 版本史 / 读回内容
- **在线编辑升版**：读回后可直接改，保存即追加新版本
- **下发向导**：选文件+版本（默认最新、受理即钉死）→ 勾节点 → 目标路径 + 可选 apply → 小并发 2 逐节点下发，实时展示七态（applied / push_failed / verify_failed / apply_failed / unknown_outcome / rolled_back / rollback_failed）
  - **unknown_outcome 护栏**：重推按钮锁定，勾"已人工回读"后解锁（契约：禁止未人工回读的自动重试）
  - **P48 警示**：apply 命令疑似动承载网（wireguard/管理树底座）且多节点时弹确认
  - **下发预设**：常用「目标路径 + apply」组合存浏览器本地（localStorage）
- **下发留痕**：按节点查 `config_pushes` 历史（七态 badge + error_brief）

## 构建与运行

```bash
make build          # 产出 bin/nms-config-ui
./bin/nms-config-ui                        # 监听 127.0.0.1:8090，上游 http://127.0.0.1:8080
./bin/nms-config-ui -addr 127.0.0.1:8090 -upstream http://127.0.0.1:8080
```

## 安全注意（重要）

上游 NMS API **无鉴权**（单管理员口径），本工具因此**默认只监听回环地址**：

- 跑在 NMS 宿主机上：`./bin/nms-config-ui` 后浏览器访问该机（经 SSH 端口转发）
- 跑在自己电脑上：`ssh -L 8080:127.0.0.1:8080 nms宿主机` 转发上游，再 `-upstream http://127.0.0.1:8080`
- **不要**把 8090/8080 裸暴露到非受信网络

## 开发

```bash
make test    # go test
make lint    # gofmt 检查 + go vet
```

纯原生 HTML/JS/CSS（`web/`，无构建链），改完 `make build` 即生效（embed）。

## License

MIT
