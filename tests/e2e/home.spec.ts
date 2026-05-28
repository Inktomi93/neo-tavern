import { expect, test } from "@playwright/test";

test("Homepage loads and renders the App Shell", async ({ page }) => {
  // Go to the main chat route
  await page.goto("/");

  // Wait for the NavRail to be visible (data-testid="app-nav-rail" in __root.tsx)
  await expect(page.getByTestId("app-nav-rail")).toBeVisible();

  // Take a screenshot and save it to the artifacts directory so I can see it
  await page.screenshot({
    path: "/home/inktomi/.gemini/antigravity-cli/brain/a11214cc-469e-46c6-974c-4c5426a7b582/current_ui_screenshot.png",
    fullPage: true,
  });

  // Basic assertion that we're on the Chat page and it says "No active chats found" (assuming empty DB)
  // or just ensuring the chat list rail is there
  await expect(
    page.getByTestId("chat-list-rail").or(page.getByText(/No active chats found/)),
  ).toBeVisible();
});
