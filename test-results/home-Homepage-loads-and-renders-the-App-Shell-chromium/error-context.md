# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: home.spec.ts >> Homepage loads and renders the App Shell
- Location: tests/e2e/home.spec.ts:3:1

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByTestId('chat-list-rail').or(getByText(/No active chats found/))
Expected: visible
Timeout: 5000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 5000ms
  - waiting for getByTestId('chat-list-rail').or(getByText(/No active chats found/))

```

```yaml
- navigation "Main Navigation":
  - link "Chat":
    - /url: /
  - link "Corpus":
    - /url: /corpus?mode=discover&q=&rerank=false
- main:
  - heading "neo-tavern" [level=1]
  - status: server ok — v0.1.0
  - textbox "Chat title"
  - textbox "Character name"
  - textbox "Character description"
  - button "New chat"
  - link "Explore the Corpus →":
    - /url: /corpus?mode=discover&q=&rerank=false
- region "Notifications alt+T"
```

# Test source

```ts
  1  | import { test, expect } from "@playwright/test";
  2  | 
  3  | test("Homepage loads and renders the App Shell", async ({ page }) => {
  4  |   // Go to the main chat route
  5  |   await page.goto("/");
  6  | 
  7  |   // Wait for the NavRail to be visible (data-testid="app-nav-rail" in __root.tsx)
  8  |   await expect(page.getByTestId("app-nav-rail")).toBeVisible();
  9  | 
  10 |   // Take a screenshot and save it to the artifacts directory so I can see it
  11 |   await page.screenshot({ path: "/home/inktomi/.gemini/antigravity-cli/brain/a11214cc-469e-46c6-974c-4c5426a7b582/current_ui_screenshot.png", fullPage: true });
  12 | 
  13 |   // Basic assertion that we're on the Chat page and it says "No active chats found" (assuming empty DB)
  14 |   // or just ensuring the chat list rail is there
> 15 |   await expect(page.getByTestId("chat-list-rail").or(page.getByText(/No active chats found/))).toBeVisible();
     |                                                                                                ^ Error: expect(locator).toBeVisible() failed
  16 | });
  17 | 
```