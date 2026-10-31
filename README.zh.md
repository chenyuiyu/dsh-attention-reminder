# dsh-attention-reminder

声音 + 弹窗提醒：当 agent 需要你**授权**（approval）或**确认**（ask_user_question）时，
自动响铃、把 DSH 提到最前、并在页面最上层浮出提醒卡片。

**提示音**与**弹窗提示**是两个独立开关，刷新页面、重启宿主都不会丢。

## 安装

```sh
dsh plugin --profile <profile> add github:chenyuiyu/dsh-attention-reminder
```

DSH Desktop 上也可以在**设置 → 插件**里安装。插件是纯 JavaScript，无需构建、没有依赖。

## 两个开关

都在会话头部右侧的 🔔 按钮里。

- **声音** —— 单音铃声（WebAudio 合成，约 0.5 秒）。每条新的待处理项只响一声，不会重复；卡片会一直留在屏幕上直到你回应。
- **弹窗提示** —— `window.focus()` 把 DSH 拉到前台 + 页面最上层浮层卡片（说明在等什么，最多 3 张，其余折叠成「另有 N 项」）+ 浏览器允许时发系统通知。

面板里还有「发一条测试提醒」，走的是与真实提醒完全相同的链路。

开关持久化在 `$DSH_HOME/plugin-data/dsh-attention-reminder/state.json`（默认 `~/.dsh/plugin-data/...`）。

## 工作方式

- **Host 半**（[index.js](index.js)）监听 waterfall 事件 `approval/request` 与 `user-questions/request`，
  把尚未被回答的请求放进有界队列（最多 24 条）；`next()` 返回的 promise settle 或请求的 `AbortSignal` 中止时移除。
  它只观察不拦截：每个处理函数都以 `return next()` 委托，授权与提问本身的行为完全不变。
  队列与开关通过 `connection.fetch.register` 暴露成 `GET/POST /api/attention-reminder`。
- **Web 半**（[client.js](client.js)）每 1 秒轮询该路由，只对**没见过的 id** 触发提醒。
  卡片注册进 `shell.overlay`，🔔 面板注册进 `conversation.session.header.utilities`。

插件没有「宿主主动推送到页面」的通道，所以页面侧采用轮询（与 `@deepseek-ai/dsh-deja` 相同的 HTTP 路由范式）。

## 说明

- 浏览器要求页面先有过一次交互才允许出声。刚打开 DSH 就触发提醒时可能没声音，点一下页面即可，下一次提醒就正常。
- `window.focus()` 未必能突破 Windows 的前台窗口限制；此时仍有浮层卡片 + 系统通知兜底。
- 系统通知需要浏览器授权，在第一次打开「弹窗提示」开关或点测试按钮（都是用户手势）时请求一次。

## 许可

MIT
