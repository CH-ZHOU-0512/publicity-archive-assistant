const path = require("node:path");
const { spawnSync } = require("node:child_process");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "win32") return;

  const projectDir = context.packager.projectDir;
  const executable = path.join(context.appOutDir, "宣传记录助手.exe");
  const editor = path.join(projectDir, "build", "rcedit-x64.exe");
  const icon = path.join(projectDir, "build", "icon.ico");
  const version = context.packager.appInfo.version;
  const result = spawnSync(editor, [
    executable,
    "--set-icon", icon,
    "--set-file-version", version,
    "--set-product-version", version,
    "--set-version-string", "CompanyName", "湖北经济学院",
    "--set-version-string", "FileDescription", "宣传记录助手",
    "--set-version-string", "ProductName", "宣传记录助手",
    "--set-version-string", "OriginalFilename", "宣传记录助手.exe",
    "--set-version-string", "LegalCopyright", "Copyright © 2026 湖北经济学院",
    "--set-requested-execution-level", "asInvoker"
  ], { encoding: "utf8", windowsHide: true });

  if (result.status !== 0) {
    throw new Error(`写入 Windows 图标和版本信息失败：${result.stderr || result.stdout || `退出码 ${result.status}`}`);
  }
};
