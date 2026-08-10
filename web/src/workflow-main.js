/** Load one classic workflow dependency in sequence. */
function loadWorkflowScript(source) {
  return new Promise(function createWorkflowScriptPromise(resolve, reject) {
    const script = document.createElement("script");
    script.src = source;
    /** Resolve after one workflow dependency loads. */
    function handleWorkflowScriptLoad() {
      resolve();
    }
    /** Reject after one workflow dependency fails. */
    function handleWorkflowScriptError() {
      reject(new Error("无法加载工作流脚本：" + source));
    }
    script.onload = handleWorkflowScriptLoad;
    script.onerror = handleWorkflowScriptError;
    document.body.appendChild(script);
  });
}

/** Load frontend config before mounting the intelligent-packing page. */
async function bootstrapWorkflow() {
  const response = await fetch("/config.json", { cache: "no-store" });
  window.APP_CONFIG = await response.json();
  await loadWorkflowScript("/vendor/vue.global.prod.js");
  await loadWorkflowScript("/workflow.js");
}

bootstrapWorkflow().catch(function handleWorkflowBootstrapError(error) {
  document.getElementById("workflow-app").textContent = error.message || "工作流启动失败。";
});
