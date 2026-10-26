import assert from "node:assert/strict";
import test from "node:test";
import { GoogleApiError, SdmClient, parseRetryAfter } from "../src/google/sdm.ts";
import type { SdmCommand } from "../src/domain/thermostat.ts";

const resource = "enterprises/test-project/devices/test-device";
const fixedUrl = "https://smartdevicemanagement.googleapis.com/v1/" + resource;
const payload = { name: resource, type: "sdm.devices.types.THERMOSTAT", traits: { "sdm.devices.traits.Connectivity": { status: "ONLINE" } } };
const command: SdmCommand = { command: "sdm.devices.commands.ThermostatMode.SetMode", params: { mode: "HEAT" } };
const errorCode = (code: string) => (error: unknown) => error instanceof GoogleApiError && error.code === code;
const mockFetch = (handler: (url: string, init: RequestInit) => Promise<Response> | Response): typeof fetch =>
  ((url, init) => Promise.resolve(handler(String(url), init ?? {}))) as typeof fetch;

test("reads only the fixed configured resource, strips private identifiers", async () => {
  const client = new SdmClient({ deviceResource: resource, accessToken: async () => "test-token", fetch: mockFetch((url, init) => {
    assert.equal(url, fixedUrl);
    assert.equal(init.method, "GET");
    assert.equal((init.headers as Record<string, string>).Authorization, "Bearer test-token");
    assert.equal(init.redirect, "error");
    assert.equal(init.cache, "no-store");
    assert.equal(init.credentials, "omit");
    assert.ok(init.signal instanceof AbortSignal);
    return Response.json(payload);
  }) });
  const state = await client.getDevice();
  assert.equal(state.connection, "ONLINE");
  assert.ok(!JSON.stringify(state).includes(resource));
});

test("successful command is accepted, never claimed confirmed", async () => {
  let calls = 0;
  const client = new SdmClient({ deviceResource: resource, accessToken: async () => "test-token", fetch: mockFetch((url, init) => {
    calls++;
    assert.equal(url, fixedUrl + ":executeCommand");
    assert.equal(init.method, "POST");
    assert.deepEqual(JSON.parse(String(init.body)), command);
    return Response.json({});
  }) });
  assert.deepEqual(await client.execute(command), { accepted: true, confirmed: false });
  assert.equal(calls, 1);
});

test("validated command cannot change while awaiting token refresh", async () => {
  const mutable: SdmCommand = { command: "sdm.devices.commands.ThermostatMode.SetMode", params: { mode: "HEAT" } };
  const client = new SdmClient({ deviceResource: resource, accessToken: async () => {
    mutable.params.mode = "OFF";
    return "test-token";
  }, fetch: mockFetch((_url, init) => {
    assert.deepEqual(JSON.parse(String(init.body)), command);
    return Response.json({});
  }) });
  await client.execute(mutable);
});

test("constructor rejects resource injection and unsafe timeout", () => {
  for (const deviceResource of ["https://evil.example", resource + "?key=x", resource + "/../other", "enterprises/p/devices/a%2Fb", "enterprises/p/devices/a:executeCommand"]) {
    assert.throws(() => new SdmClient({ deviceResource, accessToken: async () => "test" }), TypeError);
  }
  assert.throws(() => new SdmClient({ deviceResource: resource, accessToken: async () => "test", timeoutMs: 0 }), TypeError);
});

test("runtime rejects an arbitrary command or extra proxy fields before requesting a token", async () => {
  let tokens = 0;
  const client = new SdmClient({ deviceResource: resource, accessToken: async () => { tokens++; return "test"; } });
  for (const value of [null, {}, { command: "anything", params: {} }, { ...command, device: "other" }, { ...command, params: { mode: "HEAT", device: "other" } }, { command: "sdm.devices.commands.Fan.SetTimer", params: { timerMode: "ON", duration: "43201s" } }]) {
    await assert.rejects(() => client.execute(value as SdmCommand), TypeError);
  }
  assert.equal(tokens, 0);
});

test("Google auth failures do not leak bodies or log app users out", async () => {
  for (const status of [401, 403]) {
    let calls = 0;
    const client = new SdmClient({ deviceResource: resource, accessToken: async () => "test", fetch: mockFetch(() => { calls++; return Response.json({ secret: "private-account-value" }, { status }); }) });
    await assert.rejects(() => client.getDevice(), (error: unknown) => {
      assert.ok(error instanceof GoogleApiError);
      assert.equal(error.code, "REAUTH_REQUIRED");
      assert.equal(error.status, 502);
      assert.equal(error.upstreamStatus, status);
      assert.ok(!JSON.stringify(error).includes("private-account-value"));
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("quota rejection passes bounded Retry-After without automatic retries", async () => {
  let calls = 0;
  const client = new SdmClient({ deviceResource: resource, accessToken: async () => "test", fetch: mockFetch(() => { calls++; return new Response("private", { status: 429, headers: { "Retry-After": "120" } }); }) });
  await assert.rejects(() => client.execute(command), (error: unknown) => {
    assert.ok(error instanceof GoogleApiError);
    assert.equal(error.code, "RATE_LIMITED");
    assert.equal(error.retryAfterSeconds, 120);
    assert.equal(error.status, 429);
    assert.equal(error.outcomeUnknown, false);
    return true;
  });
  assert.equal(calls, 1);
});

test("network and server failures after command dispatch carry uncertain outcome", async () => {
  for (const handler of [() => { throw new Error("secret-hostname"); }, () => new Response("private-body", { status: 503 }), () => new Response("bad-json", { status: 200 })]) {
    let calls = 0;
    const client = new SdmClient({ deviceResource: resource, accessToken: async () => "test", fetch: mockFetch(() => { calls++; return handler(); }) });
    await assert.rejects(() => client.execute(command), (error: unknown) => {
      assert.ok(error instanceof GoogleApiError);
      assert.equal(error.outcomeUnknown, true);
      assert.equal(error.code, "OUTCOME_UNKNOWN");
      assert.ok(!error.message.includes("private"));
      assert.ok(!error.message.includes("secret"));
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("read failures and malformed responses are sanitized", async () => {
  const make = (response: Response) => new SdmClient({ deviceResource: resource, accessToken: async () => "test", fetch: mockFetch(() => response) });
  await assert.rejects(() => make(new Response("bad")).getDevice(), errorCode("INVALID_RESPONSE"));
  await assert.rejects(() => make(new Response("private", { status: 404 })).getDevice(), errorCode("DEVICE_NOT_FOUND"));
  await assert.rejects(() => make(new Response("private", { status: 500 })).getDevice(), errorCode("GOOGLE_UNAVAILABLE"));
  await assert.rejects(() => make(new Response("private", { status: 400 })).execute(command), errorCode("DEVICE_REJECTED"));
});

test("missing, malicious, or failed tokens never reach Google", async () => {
  let calls = 0;
  for (const accessToken of [async () => "", async () => "token\r\nvalue", async () => { throw new Error("private secret"); }]) {
    const client = new SdmClient({ deviceResource: resource, accessToken, fetch: mockFetch(() => { calls++; return Response.json(payload); }) });
    await assert.rejects(() => client.getDevice(), errorCode("REAUTH_REQUIRED"));
  }
  assert.equal(calls, 0);
});

test("Retry-After accepts seconds and dates, rejects invalid values and bounds delays", () => {
  const now = Date.parse("2026-01-01T12:00:00Z");
  assert.equal(parseRetryAfter("60", now), 60);
  assert.equal(parseRetryAfter("Thu, 01 Jan 2026 12:02:00 GMT", now), 120);
  assert.equal(parseRetryAfter("0", now), 1);
  assert.equal(parseRetryAfter("999999999", now), 86_400);
  assert.equal(parseRetryAfter("bad", now), null);
  assert.equal(parseRetryAfter(null, now), null);
  assert.equal(parseRetryAfter("Thu, 01 Jan 2026 11:00:00 GMT", now), null);
});
test('revocation during token refresh blocks the eventual command dispatch', async () => {
  let allowed=true;let calls=0;let release:(value:string)=>void=()=>{};
  const client=new SdmClient({deviceResource:'enterprises/fake/devices/fake',accessToken:()=>new Promise<string>(r=>{release=r;}),fetch:async()=>{calls++;return Response.json({});}});
  const pending=client.execute({command:'sdm.devices.commands.ThermostatMode.SetMode',params:{mode:'OFF'}},()=>allowed);
  allowed=false;release('fake-token');await assert.rejects(()=>pending,/revoked/);assert.equal(calls,0);
});
