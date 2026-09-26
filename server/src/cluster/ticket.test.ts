import assert from "node:assert/strict";
import { test } from "node:test";
import { serverToken, sign, verify, verifyPlayer, verifyServer, type PlayerTicket } from "./ticket.ts";

const secret = "s3cret";
const ticket: PlayerTicket = { kind: "player", room: "cozy-den-1", server: 2, player: 17, exp: Date.now() + 30_000 };

test("a signed ticket verifies and round-trips", () => {
  assert.deepEqual(verifyPlayer(sign(ticket, secret), secret), ticket);
});

test("tampering, a wrong secret or garbage are rejected", () => {
  const token = sign(ticket, secret);
  const [body, mac] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ ...ticket, server: 1 })).toString("base64url");
  assert.equal(verify(`${forged}.${mac}`, secret), null);
  assert.equal(verify(`${body}.${mac.slice(0, -2)}xx`, secret), null);
  assert.equal(verify(token, "other"), null);
  assert.equal(verify("nonsense", secret), null);
  assert.equal(verify("", secret), null);
});

test("expired tickets fail unless explicitly allowed", () => {
  const old = sign({ ...ticket, exp: 1000 }, secret);
  assert.equal(verify(old, secret), null);
  assert.equal(verifyPlayer(old, secret, { allowExpired: true })?.player, 17);
});

test("player tickets and server tokens are not interchangeable", () => {
  assert.equal(verifyServer(sign(ticket, secret), secret), null);
  const token = serverToken(3, secret);
  assert.equal(verifyPlayer(token, secret), null);
  assert.equal(verifyServer(token, secret)?.server, 3);
});
