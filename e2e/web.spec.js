import { test, expect } from "@playwright/test";
import { randomBytes } from "node:crypto";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const file = { name: "婚礼.png", mimeType: "image/png", buffer: png };

test("宾客上传、刷新恢复、重新打开同一浏览器并隔离其他访客", async ({
  page,
  context,
  browser,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.locator("#files")).toBeEnabled();
  await page.locator("#name").fill("现场亲友");
  await page.getByRole("button", { name: "保存称呼" }).click();
  await page.locator("#files").setInputFiles(file);
  await expect(page.locator(".queue-status")).toContainText("已完成");
  await expect(page.locator(".media-card")).toHaveCount(1);
  await page.reload();
  await expect(page.locator(".media-card")).toHaveCount(1);
  await expect(page.locator("#name")).toHaveValue("现场亲友");
  const again = await context.newPage();
  await again.goto("/");
  await expect(again.locator(".media-card")).toHaveCount(1);
  const other = await browser.newContext();
  const otherPage = await other.newPage();
  await otherPage.goto("http://127.0.0.1:3107/");
  await expect(otherPage.locator("#files")).toBeEnabled();
  await expect(otherPage.locator(".media-card")).toHaveCount(0);
  await other.close();
  await page.locator(".media-thumb").click();
  await expect(page.locator("dialog")).toBeVisible();
  await expect(page.locator("dialog .download")).toHaveAttribute(
    "href",
    /\/f\//,
  );
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  expect(errors).toEqual([]);
});

test("存储不可用时仍可上传并明确提示", async ({ page }) => {
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException("disabled");
    };
  });
  await page.goto("/");
  await expect(page.locator("#files")).toBeEnabled();
  await expect(page.locator("#session-note")).toContainText("无法保存会话");
  await page.locator("#files").setInputFiles(file);
  await expect(page.locator(".queue-status")).toContainText("已完成");
});

test("网络故障不会清掉旧身份；无效凭证需用户主动建立新会话", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("#files")).toBeEnabled();
  const original = await page.evaluate(() => JSON.stringify(localStorage));
  await page.route("**/api/auth/me", (route) => route.abort());
  await page.reload();
  await expect(page.locator("#reconnect")).toBeVisible();
  expect(await page.evaluate(() => JSON.stringify(localStorage))).toEqual(
    original,
  );
  await page.unroute("**/api/auth/me");
  await page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.endsWith(":session"));
    localStorage.setItem(key, "invalid");
  });
  await page.reload();
  await expect(page.locator("#recovery")).toBeVisible();
  await expect(page.locator("#files")).toBeDisabled();
});

test("关闭页面后重新选择原文件可续传，不同内容不能混合", async ({ page }) => {
  const big = {
    name: "大图.png",
    mimeType: "image/png",
    buffer: Buffer.concat([png, randomBytes(5 * 1024 * 1024)]),
  };
  await page.goto("/");
  await expect(page.locator("#files")).toBeEnabled();
  await page.route("**/parts/2", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: '{"ok":false,"error":{"message":"模拟网络中断"}}',
    }),
  );
  await page.locator("#files").setInputFiles(big);
  await expect(page.locator(".queue-status")).toContainText("模拟网络中断", {
    timeout: 20000,
  });
  await page.unroute("**/parts/2");
  await page.reload();
  await expect(
    page.getByRole("button", { name: "选择原文件续传" }),
  ).toBeVisible();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "选择原文件续传" }).click();
  await (await chooser).setFiles(big);
  await expect(page.locator(".queue-status")).toContainText("已完成");
  await expect(page.locator(".media-card")).toHaveCount(1);
});

test("管理员登录改密、设置、二维码、筛选与封禁", async ({ page }) => {
  await page.goto("/admin");
  await page.locator("#username").fill("admin");
  await page.locator("#password").fill("test-admin-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.locator("#password-panel")).toBeVisible();
  await page.locator("#current-password").fill("test-admin-password");
  await page.locator("#new-password").fill("browser-test-new-password");
  await page.getByRole("button", { name: "保存新密码" }).click();
  await expect(page.locator("#admin-content")).toBeVisible();
  await page.locator("#title").fill("今天，一起留念");
  await page.locator("#couple").fill("新人 & 爱人");
  await page.getByRole("button", { name: "保存设置" }).click();
  await expect(page.locator("#message")).toContainText("已保存");
  await expect(page.locator("#qr")).toHaveAttribute(
    "src",
    /^data:image\/png;base64,/,
  );
  await page.locator("#kind-filter").selectOption("video");
  await expect(page.locator(".media-card")).toHaveCount(0);
  await page.locator("#kind-filter").selectOption("image");
  await expect(page.locator(".media-card").first()).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: "test-results/admin-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "test-results/admin-mobile.png",
    fullPage: true,
  });
});

for (const width of [320, 390, 768, 1440])
  for (const colorScheme of ["light", "dark"]) {
    test(`布局 ${width}px ${colorScheme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme });
      await page.goto("/");
      await expect(page.locator("#files")).toBeEnabled();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: `test-results/guest-${width}-${colorScheme}.png`,
        fullPage: true,
      });
    });
  }
