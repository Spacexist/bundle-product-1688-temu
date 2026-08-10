const expect = require("@playwright/test").expect;
const test = require("@playwright/test").test;

test("renders the separated workbench and backend connection", async function renderWorkbenchTest({ page }) {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "智能组货" })).toBeVisible();
  await expect(page.getByRole("button", { name: "实时渲染" })).toBeVisible();
  await expect(page.getByText("恢复模式", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "保存基本信息" }).first()).toBeVisible();
  await page.getByRole("button", { name: "智能组货" }).click();
  await expect(page.locator("iframe")).toBeVisible();
  await expect(page.locator("iframe").contentFrame().getByRole("heading", { name: "选择分析主图" })).toBeVisible();
});
