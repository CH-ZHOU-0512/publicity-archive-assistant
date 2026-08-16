import path from "node:path";
import fs from "node:fs";
import { app, dialog, shell } from "electron";

const LOCAL_APP_URL = "http://127.0.0.1:43117";

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    void shell.openExternal(LOCAL_APP_URL);
  });

  void app.whenReady().then(async () => {
    app.setAppUserModelId("cn.edu.hbue.publicity-archive-assistant");

    process.env.PA_DESKTOP_RUNTIME = "1";
    process.env.PA_DATA_DIRECTORY = path.join(app.getPath("userData"), "data");
    process.env.PA_DEFAULT_OUTPUT_DIRECTORY = path.join(app.getPath("documents"), "宣传记录PDF");
    process.env.PA_EXTENSION_DIRECTORY = path.join(process.resourcesPath, "browser-extension");

    try {
      await import("../server/index.js");
    } catch (error) {
      const details = error instanceof Error ? error.stack || error.message : String(error);
      const logPath = path.join(app.getPath("userData"), "startup-error.log");
      fs.writeFileSync(logPath, `${new Date().toISOString()}\n${details}\n`, "utf8");
      dialog.showErrorBox("宣传记录助手启动失败", `错误信息已保存到：\n${logPath}`);
      app.quit();
    }
  });
}
