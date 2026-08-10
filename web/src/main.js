/** Load one classic browser script in deterministic order. */
function loadClassicScript(source) {
  return new Promise(function createScriptPromise(resolve, reject) {
    const script = document.createElement("script");
    script.src = source;
    /** Resolve after the requested script is executable. */
    function handleScriptLoad() {
      resolve();
    }
    /** Reject when a required UI script cannot be loaded. */
    function handleScriptError() {
      reject(new Error("无法加载前端脚本：" + source));
    }
    script.onload = handleScriptLoad;
    script.onerror = handleScriptError;
    document.body.appendChild(script);
  });
}

/** Load public frontend configuration before mounting the existing Vue UI. */
async function bootstrapWorkbench() {
  const response = await fetch("/config.json", { cache: "no-store" });
  if (!response.ok) {
    throw new Error("前端 config.json 读取失败。");
  }
  window.APP_CONFIG = await response.json();
  await loadClassicScript("/vendor/vue.global.prod.js");
  await loadClassicScript("/app.js");
}

bootstrapWorkbench().catch(function handleBootstrapError(error) {
  document.getElementById("app").textContent = error.message || "前端启动失败。";
});
