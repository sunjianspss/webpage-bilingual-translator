# Security

本项目是浏览器扩展，会把当前网页中选中的正文片段发送到用户配置的翻译服务。请在使用前确认目标服务可信。

## API Key

- DeepSeek API Key 和本地 API Token 仅保存于浏览器扩展本地存储。
- 不要把真实密钥提交到 issue、pull request 或日志中。
- 如果密钥已经泄露，请立即在对应服务控制台撤销并重新生成。

## 本地服务

本地 API 默认指向 `http://127.0.0.1:1234/v1`。Safari 版本通过原生代理访问本地服务，并限制代理目标为 localhost、127.0.0.1 和 DeepSeek API。

## 报告问题

请通过 GitHub issue 报告安全相关问题。报告中不要包含真实 API Key、Cookie、浏览器 profile 或隐私网页内容。

