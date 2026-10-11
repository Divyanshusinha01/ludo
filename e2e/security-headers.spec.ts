import { expect, test } from "@playwright/test";

test("pages are served with security headers and no CSP violations", async ({ page }) => {
  const violations: string[] = [];
  page.on("console", (msg) => {
    if (msg.text().includes("Content Security Policy")) violations.push(msg.text());
  });
  await page.addInitScript(() =>
    document.addEventListener("securitypolicyviolation", (e) =>
      console.log(`Content Security Policy violation: ${e.violatedDirective} ${e.blockedURI}`),
    ),
  );

  const response = await page.goto("/");
  expect(response?.ok()).toBe(true);
  const headers = response!.headers();
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  expect(headers["permissions-policy"]).toContain("microphone=(self)");
  const csp = headers["content-security-policy-report-only"];
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("frame-ancestors 'none'");

  await expect(page.getByRole("button", { name: /^Private Room/ })).toBeVisible();
  await page.goto("/offline");
  await page.getByRole("button", { name: "Start local game" }).click();
  await expect(page.getByRole("button", { name: "Roll dice" })).toBeVisible();
  expect(violations).toEqual([]);
});
