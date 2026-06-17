# Contributing

欢迎提交 issue、建议和 pull request。

## 本地开发

```bash
npm test
npm run check
```

Chrome/Edge 扩展无需构建，可直接在扩展管理页加载仓库根目录。

Safari 版本位于 `safari/网页双语翻译/`，需要使用 Xcode 构建和签名。开发阶段可使用脚本：

```bash
./script/build_and_run.sh
```

## 提交建议

- 不要提交 API Key、`.env`、浏览器配置文件或本地模型服务日志。
- 不要提交 `outputs/`、Xcode DerivedData、截图缓存等生成物。
- 修改 `src/content.js` 后，请同步 Safari 扩展资源中的同名文件，并运行测试确认一致性。

