// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiError } from "../errors";
import { callAnthropic, callGemini, callOpenAi, normalizeTurns, GEMINI_BASE } from "../providers";
import { parseReply } from "../prompt";

const KEY = "sk-test-SECRET-1234567890";
const cfg = (model: string) => ({ apiKey: KEY, model });
const turns = [{ role: "user" as const, content: "こんにちは" }];
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const sig = () => new AbortController().signal;
async function kindOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof AiError ? e.kind : "other";
  }
}

describe("normalizeTurns", () => {
  it("merges same-role turns and drops a leading assistant turn", () => {
    expect(
      normalizeTurns([
        { role: "assistant", content: "x" },
        { role: "user", content: "a" },
        { role: "user", content: "b" },
        { role: "assistant", content: "c" },
      ]),
    ).toEqual([
      { role: "user", content: "a\n\nb" },
      { role: "assistant", content: "c" },
    ]);
  });
});

describe("Anthropic adapter", () => {
  it("sends the documented request and parses text", async () => {
    fetchMock.mockResolvedValue(json(200, { content: [{ type: "text", text: "{\"a\":1}" }], stop_reason: "end_turn" }));
    const r = await callAnthropic(cfg("claude-sonnet-5-5"), turns, "SYS", sig());
    expect(r.text).toBe('{"a":1}');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.method).toBe("POST");
    expect(init.headers["x-api-key"]).toBe(KEY);
    expect(init.headers["anthropic-version"]).toBe("2023-06-01");
    expect(init.headers["anthropic-dangerous-direct-browser-access"]).toBe("true");
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ model: "claude-sonnet-5-5", system: "SYS", messages: [{ role: "user", content: "こんにちは" }] });
    expect(body.max_tokens).toBeGreaterThan(1000);
    expect(JSON.stringify(init.headers)).not.toMatch(/authorization/i);
  });
  it("maps 401 / 429 / 500 / 400, refusal, truncation, bad shape", async () => {
    fetchMock.mockResolvedValueOnce(json(401, { error: { message: `bad key ${KEY}` } }));
    expect(await kindOf(callAnthropic(cfg("m"), turns, "s", sig()))).toBe("auth");
    fetchMock.mockResolvedValueOnce(json(429, {}));
    expect(await kindOf(callAnthropic(cfg("m"), turns, "s", sig()))).toBe("rate_limit");
    fetchMock.mockResolvedValueOnce(json(529, {}));
    expect(await kindOf(callAnthropic(cfg("m"), turns, "s", sig()))).toBe("server");
    fetchMock.mockResolvedValueOnce(json(404, { error: { message: "model: nope" } }));
    expect(await kindOf(callAnthropic(cfg("m"), turns, "s", sig()))).toBe("bad_request");
    fetchMock.mockResolvedValueOnce(json(200, { content: [], stop_reason: "refusal" }));
    expect(await kindOf(callAnthropic(cfg("m"), turns, "s", sig()))).toBe("blocked");
    fetchMock.mockResolvedValueOnce(json(200, { content: [{ type: "text", text: "{" }], stop_reason: "max_tokens" }));
    expect(await kindOf(callAnthropic(cfg("m"), turns, "s", sig()))).toBe("truncated");
    fetchMock.mockResolvedValueOnce(json(200, { nope: 1 }));
    expect(await kindOf(callAnthropic(cfg("m"), turns, "s", sig()))).toBe("bad_format");
    fetchMock.mockResolvedValueOnce(new Response("<html>", { status: 200 }));
    expect(await kindOf(callAnthropic(cfg("m"), turns, "s", sig()))).toBe("bad_format");
  });
  it("never leaks the key into error details", async () => {
    fetchMock.mockResolvedValueOnce(json(400, { error: { message: `invalid ${KEY} here` } }));
    try {
      await callAnthropic(cfg("m"), turns, "s", sig());
    } catch (e) {
      expect((e as AiError).detail).not.toContain(KEY);
      expect((e as AiError).detail).toContain("***");
    }
    fetchMock.mockRejectedValueOnce(new TypeError(`Failed to fetch ${KEY}`));
    try {
      await callAnthropic(cfg("m"), turns, "s", sig());
    } catch (e) {
      expect((e as AiError).kind).toBe("network");
      expect((e as AiError).detail ?? "").not.toContain(KEY);
    }
  });
  it("normalizes network failure and abort", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    expect(await kindOf(callAnthropic(cfg("m"), turns, "s", sig()))).toBe("network");
    const ctrl = new AbortController();
    fetchMock.mockImplementationOnce((_u: string, init: RequestInit) => new Promise((_res, rej) => init.signal!.addEventListener("abort", () => rej(new DOMException("x", "AbortError")))));
    const p = kindOf(callAnthropic(cfg("m"), turns, "s", ctrl.signal));
    ctrl.abort();
    expect(await p).toBe("aborted");
    const pre = new AbortController();
    pre.abort();
    expect(await kindOf(callAnthropic(cfg("m"), turns, "s", pre.signal))).toBe("aborted");
  });
});

describe("OpenAI adapter (Responses API)", () => {
  it("sends the documented request and joins output_text", async () => {
    fetchMock.mockResolvedValue(
      json(200, { status: "completed", output: [{ type: "reasoning", summary: [] }, { type: "message", content: [{ type: "output_text", text: "{\"x\":" }, { type: "output_text", text: "1}" }] }] }),
    );
    const r = await callOpenAi(cfg("gpt-6-astra"), [...turns, { role: "assistant", content: "a" }, { role: "user", content: "b" }], "SYS", sig());
    expect(r.text).toBe('{"x":1}');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(init.headers.authorization).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(init.body);
    expect(body.model).toBe("gpt-6-astra");
    expect(body.instructions).toBe("SYS");
    expect(body.input).toEqual([
      { role: "user", content: "こんにちは" },
      { role: "assistant", content: "a" },
      { role: "user", content: "b" },
    ]);
    expect(body.text).toEqual({ format: { type: "json_object" } });
    expect(body.store).toBe(false);
    expect(typeof body.max_output_tokens).toBe("number");
  });
  it("maps errors and incomplete/refusal", async () => {
    fetchMock.mockResolvedValueOnce(json(401, { error: { message: "Incorrect API key provided: sk-...abcd" } }));
    expect(await kindOf(callOpenAi(cfg("m"), turns, "s", sig()))).toBe("auth");
    fetchMock.mockResolvedValueOnce(json(429, { error: { message: "rate" } }));
    expect(await kindOf(callOpenAi(cfg("m"), turns, "s", sig()))).toBe("rate_limit");
    fetchMock.mockResolvedValueOnce(json(200, { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] }));
    expect(await kindOf(callOpenAi(cfg("m"), turns, "s", sig()))).toBe("truncated");
    fetchMock.mockResolvedValueOnce(json(200, { status: "incomplete", incomplete_details: { reason: "content_filter" }, output: [] }));
    expect(await kindOf(callOpenAi(cfg("m"), turns, "s", sig()))).toBe("blocked");
    fetchMock.mockResolvedValueOnce(json(200, { status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }] }));
    expect(await kindOf(callOpenAi(cfg("m"), turns, "s", sig()))).toBe("blocked");
    fetchMock.mockResolvedValueOnce(json(200, { status: "completed", output: [] }));
    expect(await kindOf(callOpenAi(cfg("m"), turns, "s", sig()))).toBe("bad_format");
  });
});

describe("Gemini adapter (generateContent)", () => {
  it("sends the key in a header, not the URL, and parses candidates", async () => {
    fetchMock.mockResolvedValue(json(200, { candidates: [{ content: { parts: [{ text: "{\"y\":2}" }] }, finishReason: "STOP" }] }));
    const r = await callGemini(cfg("gemini-3.6-flash"), [...turns, { role: "assistant", content: "a" }, { role: "user", content: "b" }], "SYS", sig());
    expect(r.text).toBe('{"y":2}');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${GEMINI_BASE}gemini-3.6-flash:generateContent`);
    expect(String(url)).not.toContain(KEY);
    expect(String(url)).not.toContain("key=");
    expect(init.headers["x-goog-api-key"]).toBe(KEY);
    const body = JSON.parse(init.body);
    expect(body.systemInstruction).toEqual({ parts: [{ text: "SYS" }] });
    expect(body.contents.map((c: { role: string }) => c.role)).toEqual(["user", "model", "user"]);
    expect(body.generationConfig.responseMimeType).toBe("application/json");
  });
  it("encodes custom model ids in the path", async () => {
    fetchMock.mockResolvedValue(json(200, { candidates: [{ content: { parts: [{ text: "{}" }] } }] }));
    await callGemini(cfg("a/b"), turns, "s", sig());
    expect(String(fetchMock.mock.calls[0]![0])).toContain("a%2Fb:generateContent");
  });
  it("maps errors, blocks, truncation, invalid-key 400", async () => {
    fetchMock.mockResolvedValueOnce(json(400, { error: { message: "API key not valid", details: [{ reason: "API_KEY_INVALID" }] } }));
    expect(await kindOf(callGemini(cfg("m"), turns, "s", sig()))).toBe("auth");
    fetchMock.mockResolvedValueOnce(json(403, { error: { message: "denied" } }));
    expect(await kindOf(callGemini(cfg("m"), turns, "s", sig()))).toBe("auth");
    fetchMock.mockResolvedValueOnce(json(429, { error: { message: "quota" } }));
    expect(await kindOf(callGemini(cfg("m"), turns, "s", sig()))).toBe("rate_limit");
    fetchMock.mockResolvedValueOnce(json(200, { promptFeedback: { blockReason: "SAFETY" } }));
    expect(await kindOf(callGemini(cfg("m"), turns, "s", sig()))).toBe("blocked");
    fetchMock.mockResolvedValueOnce(json(200, { candidates: [{ content: { parts: [{ text: "{" }] }, finishReason: "MAX_TOKENS" }] }));
    expect(await kindOf(callGemini(cfg("m"), turns, "s", sig()))).toBe("truncated");
    fetchMock.mockResolvedValueOnce(json(200, { candidates: [{ finishReason: "SAFETY" }] }));
    expect(await kindOf(callGemini(cfg("m"), turns, "s", sig()))).toBe("blocked");
    fetchMock.mockResolvedValueOnce(json(200, { candidates: [] }));
    expect(await kindOf(callGemini(cfg("m"), turns, "s", sig()))).toBe("bad_format");
  });
});

describe("parseReply", () => {
  it("accepts plain JSON, fenced JSON and JSON with surrounding text", () => {
    const body = '{"message":"hi","operations":[{"op":"deleteTask","id":"A"}]}';
    expect(parseReply(body).ops).toHaveLength(1);
    expect(parseReply("```json\n" + body + "\n```").message).toBe("hi");
    expect(parseReply("はい、こちらです。\n" + body + "\n以上").ops).toHaveLength(1);
    expect(parseReply('{"message":"q"}').ops).toEqual([]);
  });
  it("rejects malformed output as bad_format", () => {
    for (const bad of ["not json", "[]", '{"message":1}', '{"message":"x","operations":[{"op":"zzz"}]}']) {
      expect(() => parseReply(bad)).toThrowError(AiError);
    }
  });
});

import { redactKey } from "../errors";
describe("redactKey", () => {
  it("hides the key, its URL-encoded form and 8+ char fragments", () => {
    const key = "sk-ant-api03-ABCDEFGHIJKLMNOP+/xyz";
    expect(redactKey(`bad ${key} x`, key)).toBe("bad *** x");
    expect(redactKey(`bad ${encodeURIComponent(key)} x`, key)).toBe("bad *** x");
    expect(redactKey("Incorrect API key provided: sk-ant-api03-ABCD**** ok", key)).not.toContain("sk-ant-api03");
    expect(redactKey("only short ab12 stays", key)).toBe("only short ab12 stays");
  });
});

describe("request tuning", () => {
  it("anthropic sends effort medium and a large max_tokens for known models only", async () => {
    fetchMock.mockImplementation(async () => json(200, { content: [{ type: "text", text: "{}" }], stop_reason: "end_turn" }));
    await callAnthropic(cfg("claude-sonnet-5-5"), turns, "s", sig());
    await callAnthropic(cfg("some-custom-model"), turns, "s", sig());
    const known = JSON.parse(fetchMock.mock.calls[0]![1].body);
    const custom = JSON.parse(fetchMock.mock.calls[1]![1].body);
    expect(known.output_config).toEqual({ effort: "medium" });
    expect(custom.output_config).toBeUndefined();
    expect(known.max_tokens).toBeGreaterThanOrEqual(32000);
  });
  it("openai lowers reasoning effort for known models only", async () => {
    fetchMock.mockImplementation(async () => json(200, { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "{}" }] }] }));
    await callOpenAi(cfg("gpt-6-astra"), turns, "s", sig());
    await callOpenAi(cfg("custom"), turns, "s", sig());
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).reasoning).toEqual({ effort: "low" });
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body).reasoning).toBeUndefined();
  });
});
