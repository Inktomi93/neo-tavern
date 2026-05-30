import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { ipAllowlistMiddleware } from "./ip-allowlist";

function appWith(allowlist: string[]) {
  const app = new Hono();
  app.use(ipAllowlistMiddleware(allowlist));
  app.get("/", (c) => c.text("ok"));
  return app;
}

describe("ipAllowlistMiddleware", () => {
  test("allows a client IP inside the allowlist (via X-Forwarded-For)", async () => {
    const res = await appWith(["10.0.0.0/8"]).request("/", {
      headers: { "x-forwarded-for": "10.1.2.3" },
    });
    expect(res.status).toBe(200);
  });

  test("blocks a client IP outside the allowlist with 403", async () => {
    const res = await appWith(["10.0.0.0/8"]).request("/", {
      headers: { "x-forwarded-for": "8.8.8.8" },
    });
    expect(res.status).toBe(403);
  });

  test("loopback is ALWAYS allowed even when not in the list (no self-lockout)", async () => {
    const res = await appWith(["10.0.0.0/8"]).request("/", {
      headers: { "x-forwarded-for": "127.0.0.1" },
    });
    expect(res.status).toBe(200);
  });

  test("uses the leftmost X-Forwarded-For hop (the real client)", async () => {
    const res = await appWith(["192.168.0.0/16"]).request("/", {
      headers: { "x-forwarded-for": "192.168.1.9, 10.0.0.1" },
    });
    expect(res.status).toBe(200);
  });
});
