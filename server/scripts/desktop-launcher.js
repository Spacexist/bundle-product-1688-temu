const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

/** Return the first existing Windows desktop directory for the current user. */
function resolveDesktopDirectory() {
  const candidates = [
    path.join(os.homedir(), "Desktop"),
    process.env.OneDrive ? path.join(process.env.OneDrive, "Desktop") : ""
  ];
  for (let index = 0; index < candidates.length; index += 1) {
    if (candidates[index] && fs.existsSync(candidates[index])) {
      return candidates[index];
    }
  }
  throw new Error("无法定位当前用户的桌面目录。");
}

/** Return the stable cmd.exe path used to launch the batch entrypoint. */
function resolveCmdPath() {
  if (process.env.ComSpec && fs.existsSync(process.env.ComSpec)) {
    return process.env.ComSpec;
  }
  return path.join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe");
}

/** Return every value that should be written to the desktop shortcut. */
function buildShortcutSettings(projectRoot, desktopDirectory) {
  const batchPath = path.join(projectRoot, "启动.bat");
  return {
    shortcutPath: path.join(desktopDirectory, "自动组货工作台.lnk"),
    targetPath: resolveCmdPath(),
    arguments: "/c \"\"" + batchPath + "\"\"",
    workingDirectory: projectRoot,
    iconPath: path.join(projectRoot, "web", "icon.ico")
  };
}

/** Return whether an existing shortcut already points at the expected launcher. */
function isShortcutCurrent(settings) {
  if (!fs.existsSync(settings.shortcutPath)) {
    return false;
  }
  const powershellScript = [
    "$shell = New-Object -ComObject WScript.Shell",
    "$shortcut = $shell.CreateShortcut($env:AUTO_BUNDLE_SHORTCUT_PATH)",
    "$expectedTarget = [IO.Path]::GetFullPath($env:AUTO_BUNDLE_TARGET_PATH)",
    "$actualTarget = [IO.Path]::GetFullPath($shortcut.TargetPath)",
    "$actualTarget -ieq $expectedTarget",
    "$shortcut.Arguments -eq $env:AUTO_BUNDLE_SHORTCUT_ARGS",
    "$shortcut.WorkingDirectory -eq $env:AUTO_BUNDLE_WORKING_DIRECTORY",
    "$shortcut.IconLocation -eq ($env:AUTO_BUNDLE_ICON_PATH + ',0')"
  ].join("; ");
  const result = childProcess.spawnSync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    powershellScript
  ], {
    encoding: "utf8",
    windowsHide: true,
    env: Object.assign({}, process.env, {
      AUTO_BUNDLE_SHORTCUT_PATH: settings.shortcutPath,
      AUTO_BUNDLE_TARGET_PATH: settings.targetPath,
      AUTO_BUNDLE_SHORTCUT_ARGS: settings.arguments,
      AUTO_BUNDLE_WORKING_DIRECTORY: settings.workingDirectory,
      AUTO_BUNDLE_ICON_PATH: settings.iconPath
    })
  });
  if (result.error || result.status !== 0) {
    return false;
  }
  const checks = String(result.stdout || "").trim().split(/\s+/);
  return checks.length >= 3 && checks.every(function checkShortcutField(value) {
    return String(value).toLocaleLowerCase() === "true";
  });
}

/** Create or repair the minimized Windows shortcut used as the desktop entry. */
function createStartupShortcut(projectRoot, desktopDirectory) {
  const settings = buildShortcutSettings(projectRoot, desktopDirectory);
  const existedBefore = fs.existsSync(settings.shortcutPath);
  if (isShortcutCurrent(settings)) {
    return { shortcutPath: settings.shortcutPath, created: false, repaired: false };
  }
  const powershellScript = [
    "$shell = New-Object -ComObject WScript.Shell",
    "$shortcut = $shell.CreateShortcut($env:AUTO_BUNDLE_SHORTCUT_PATH)",
    "$shortcut.TargetPath = $env:AUTO_BUNDLE_TARGET_PATH",
    "$shortcut.Arguments = $env:AUTO_BUNDLE_SHORTCUT_ARGS",
    "$shortcut.WorkingDirectory = $env:AUTO_BUNDLE_WORKING_DIRECTORY",
    "$shortcut.WindowStyle = 7",
    "$shortcut.IconLocation = $env:AUTO_BUNDLE_ICON_PATH + ',0'",
    "$shortcut.Description = '启动自动组货本地服务和工作台'",
    "$shortcut.Save()"
  ].join("; ");
  const result = childProcess.spawnSync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    powershellScript
  ], {
    encoding: "utf8",
    windowsHide: true,
    env: Object.assign({}, process.env, {
      AUTO_BUNDLE_SHORTCUT_PATH: settings.shortcutPath,
      AUTO_BUNDLE_TARGET_PATH: settings.targetPath,
      AUTO_BUNDLE_SHORTCUT_ARGS: settings.arguments,
      AUTO_BUNDLE_WORKING_DIRECTORY: settings.workingDirectory,
      AUTO_BUNDLE_ICON_PATH: settings.iconPath
    })
  });
  if (result.error || result.status !== 0 || !fs.existsSync(settings.shortcutPath)) {
    throw new Error(String(result.error && result.error.message || result.stderr || "快捷方式创建失败。").trim());
  }
  return { shortcutPath: settings.shortcutPath, created: !existedBefore, repaired: existedBefore };
}

/** Remove desktop entries superseded by the single workbench startup shortcut. */
function removeLegacyDesktopLaunchers(desktopDirectory) {
  const legacyPaths = [
    path.join(desktopDirectory, "自动组货工作台.html"),
    path.join(desktopDirectory, "启动自动组货.lnk")
  ];
  for (let index = 0; index < legacyPaths.length; index += 1) {
    if (fs.existsSync(legacyPaths[index])) {
      fs.unlinkSync(legacyPaths[index]);
    }
  }
}

/** Create the single minimized shortcut that starts services and then opens the workbench. */
function createDesktopLaunchers(projectRoot) {
  const desktopDirectory = resolveDesktopDirectory();
  const shortcut = createStartupShortcut(projectRoot, desktopDirectory);
  removeLegacyDesktopLaunchers(desktopDirectory);
  return shortcut;
}

module.exports = { createDesktopLaunchers: createDesktopLaunchers };

if (require.main === module) {
  try {
    const projectRoot = path.resolve(__dirname, "..", "..");
    const launchers = createDesktopLaunchers(projectRoot);
    const action = launchers.created ? "created: " : launchers.repaired ? "repaired: " : "already exists, skipped: ";
    console.log("[Auto Bundle] Desktop workbench shortcut " + action + launchers.shortcutPath);
  } catch (error) {
    console.error("[Auto Bundle] Desktop launcher creation failed: " + error.message);
    process.exitCode = 1;
  }
}
