# DSH 插件

每个插件一个子目录，内含 `plugin.json`：

```json
{
  "id": "my-plugin",
  "name": "我的插件",
  "description": "一句话说明",
  "version": "1.0.0",
  "install": "my-plugin-1.0.0.tgz"
}
```

`install` 也可写成 npm 包名（如 `@scope/pkg`）或 `github:user/repo`。相对路径的 `.tgz` 会随目录一起上传，客户端按 catalog 基址拼接下载。
