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

## 发布

```bash
npm run package
```

产出 `dist/webpage-bilingual-translator-<版本>.zip`，可直接上传到 Chrome 网上应用店
和 Edge Add-ons。打包前会检查三件事，任何一项不过就中止：

- `package.json` 和 `manifest.json` 的版本号一致，且符合 Chrome 的版本号格式。
- `src/content.js` 与 `src/content/` 下的模块同步（生成文件没有过期）。
- 打包清单里的文件都存在。

正式发布的步骤：

1. 把 `package.json` 和 `manifest.json` 的版本号改成同一个新版本。
2. 更新 `CHANGELOG.md`，并按惯例写 `docs/releases/v<版本>.md`（有这个文件就会被
   用作 GitHub Release 的正文，没有则由 GitHub 按提交记录自动生成）。
3. 提交后打 tag 并推送：

   ```bash
   git tag v<版本> && git push origin v<版本>
   ```

`v*` tag 会触发 `.github/workflows/release.yml`：跑测试、按 tag 校验版本号、打包，
然后创建带 zip 附件的 **草稿** Release。tag 和 `manifest.json` 的版本号对不上时流水线
会失败，不会发出版本号写错的包。

4. 到 Releases 页面检查草稿：下载 zip、在浏览器里加载一遍确认能用，再点 Publish。
   有问题就删掉草稿，`git push --delete origin v<版本>` 撤掉 tag，改完重推。

上传到商店仍然是手动一步：从 Release 下载 zip，传到 Chrome 网上应用店后台。

## 提交建议

- 不要提交 API Key、`.env`、浏览器配置文件或本地模型服务日志。
- 不要提交 `outputs/`、Xcode DerivedData、截图缓存等生成物。
- 修改 `src/content.js` 后，请同步 Safari 扩展资源中的同名文件，并运行测试确认一致性。

