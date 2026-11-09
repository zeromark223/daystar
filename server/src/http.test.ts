import assert from "node:assert/strict";
import { test } from "node:test";
import { isForeignOrigin } from "./http.ts";

const upgrade = (host: string, origin?: string) =>
  new Request(`http://${host}/ws?room=x`, { headers: { host, ...(origin ? { origin } : {}) } });

test("WebSocket origins: same host or the site pass, other sites do not", () => {
  const site = "https://daystar.example";
  // The page served by this very server.
  assert.equal(isForeignOrigin(upgrade("daystar.example", "https://daystar.example"), site), false);
  assert.equal(isForeignOrigin(upgrade("192.168.1.20:3000", "https://192.168.1.20:3000")), false);
  // A cluster game server on its own host, opened from the site.
  assert.equal(isForeignOrigin(upgrade("s1.daystar.example", site), site), false);
  // Bots and tools send no Origin.
  assert.equal(isForeignOrigin(upgrade("s1.daystar.example"), site), false);
  // Someone else's page.
  assert.equal(isForeignOrigin(upgrade("s1.daystar.example", "https://evil.example"), site), true);
  assert.equal(isForeignOrigin(upgrade("s1.daystar.example", "https://evil.example")), true);
  assert.equal(isForeignOrigin(upgrade("daystar.example", "null"), site), true);
});
