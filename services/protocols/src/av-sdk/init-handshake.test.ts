import { describe, expect, it } from "vitest";
import { InitHandshake } from "./init-handshake.js";

describe("InitHandshake", () => {
  it("sends the first token immediately on start()", () => {
    const sent: string[] = [];
    const h = new InitHandshake();
    h.start(["A", "B", "C"], (t) => sent.push(t), () => {});
    expect(sent).toEqual(["A"]);
    expect(h.isReady()).toBe(false);
  });

  it("sends the next token only when onLineReceived() is called, one at a time", () => {
    const sent: string[] = [];
    const h = new InitHandshake();
    h.start(["A", "B", "C"], (t) => sent.push(t), () => {});
    h.onLineReceived();
    expect(sent).toEqual(["A", "B"]);
    h.onLineReceived();
    expect(sent).toEqual(["A", "B", "C"]);
    expect(h.isReady()).toBe(false); // C was just sent, its reply hasn't arrived yet
  });

  it("becomes ready and fires onReady only once every token's reply has arrived", () => {
    const sent: string[] = [];
    let readyCount = 0;
    const h = new InitHandshake();
    h.start(["A", "B"], (t) => sent.push(t), () => readyCount++);
    expect(h.isReady()).toBe(false);
    h.onLineReceived(); // reply to A -> sends B
    expect(h.isReady()).toBe(false);
    expect(readyCount).toBe(0);
    h.onLineReceived(); // reply to B -> queue empty -> ready
    expect(h.isReady()).toBe(true);
    expect(readyCount).toBe(1);
  });

  it("fires onReady synchronously within start() for an empty token list", () => {
    let ready = false;
    const h = new InitHandshake();
    h.start([], () => { throw new Error("should never write for an empty list"); }, () => { ready = true; });
    expect(ready).toBe(true);
    expect(h.isReady()).toBe(true);
  });

  it("further onLineReceived() calls after ready are a no-op", () => {
    const sent: string[] = [];
    let readyCount = 0;
    const h = new InitHandshake();
    h.start(["A"], (t) => sent.push(t), () => readyCount++);
    h.onLineReceived(); // ready
    h.onLineReceived();
    h.onLineReceived();
    expect(sent).toEqual(["A"]);
    expect(readyCount).toBe(1);
  });

  it("reset() abandons an in-progress handshake without firing onReady", () => {
    let readyCount = 0;
    const h = new InitHandshake();
    h.start(["A", "B"], () => {}, () => readyCount++);
    h.reset();
    expect(h.isReady()).toBe(true);
    h.onLineReceived(); // no-op, no write callback armed
    expect(readyCount).toBe(0);
  });

  it("a fresh start() replaces an in-progress handshake entirely", () => {
    const sent: string[] = [];
    const h = new InitHandshake();
    h.start(["A", "B"], (t) => sent.push(t), () => {});
    h.start(["X", "Y"], (t) => sent.push(t), () => {});
    expect(sent).toEqual(["A", "X"]);
    h.onLineReceived();
    expect(sent).toEqual(["A", "X", "Y"]);
  });
});
