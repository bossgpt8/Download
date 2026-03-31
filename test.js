"use strict";
/**
 * Boss-Bot Download Server — test suite
 *
 * Run:  npm test
 *
 * Uses a stub yt-dlp binary (written to tmp/ at startup) so no real network
 * calls are made.  The stub simply echoes back valid JSON that mirrors what
 * the real yt-dlp would return for a YouTube video.
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

// ── Stub yt-dlp binary ────────────────────────────────────────────────────────
const TMP = path.join(__dirname, "tmp");
fs.mkdirSync(TMP, { recursive: true });

const STUB_PATH = path.join(TMP, "yt-dlp-stub");
const STUB_JSON = JSON.stringify({
  title: "Test Video",
  duration: 120,
  thumbnail: "https://i.ytimg.com/vi/wO1282na3w4/maxresdefault.jpg",
  uploader: "TestUser",
  view_count: 999,
  formats: [
    { format_id: "22", ext: "mp4", quality: 5, filesize: 10485760, resolution: "1280x720" },
  ],
});

// Write a tiny Node.js script that ignores all args and outputs mock JSON
fs.writeFileSync(
  STUB_PATH,
  `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(STUB_JSON)} + "\\n");\n`,
  "utf8",
);
fs.chmodSync(STUB_PATH, 0o755);

// ── Configure server via env before require ───────────────────────────────────
const TEST_PORT = 19847;
const TEST_KEY = "@SHINDARA1i"; // mirrors the key used in the problem statement

process.env.PORT = String(TEST_PORT);
process.env.API_KEY = TEST_KEY;
process.env.YT_DLP_PATH = STUB_PATH;

const app = require("./server");

// ── HTTP helper ───────────────────────────────────────────────────────────────
function get(urlPath) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: "127.0.0.1",
      port: TEST_PORT,
      path: urlPath,
      method: "GET",
    };
    const req = http.request(opts, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(body) });
        } catch {
          resolve({ status: res.statusCode, body });
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────
describe("Boss-Bot Download Server", () => {
  let srv;

  before(() => new Promise((resolve) => {
    srv = app.listen(TEST_PORT, "127.0.0.1", resolve);
  }));

  after(() => new Promise((resolve) => srv.close(resolve)));

  // ── GET / ──────────────────────────────────────────────────────────────────
  describe("GET /", () => {
    it("returns health-check JSON with status ok", async () => {
      const { status, body } = await get("/");
      assert.strictEqual(status, 200);
      assert.strictEqual(body.status, "ok");
      assert.strictEqual(body.service, "Boss-Bot Download Server");
      assert.ok(Array.isArray(body.endpoints), "endpoints should be an array");
      assert.ok(body.endpoints.includes("/info"), "endpoints should include /info");
    });
  });

  // ── GET /info ──────────────────────────────────────────────────────────────
  describe("GET /info", () => {
    it("returns 401 when no API key is provided", async () => {
      const { status, body } = await get(
        `/info?url=${encodeURIComponent("https://youtu.be/wO1282na3w4")}`,
      );
      assert.strictEqual(status, 401);
      assert.ok(body.error, "should return an error message");
    });

    it("returns 401 for an invalid API key", async () => {
      const { status, body } = await get(
        `/info?url=${encodeURIComponent("https://youtu.be/wO1282na3w4")}&key=wrong-key`,
      );
      assert.strictEqual(status, 401);
      assert.ok(body.error);
    });

    it("returns 400 when url query param is missing", async () => {
      const { status, body } = await get(
        `/info?key=${encodeURIComponent(TEST_KEY)}`,
      );
      assert.strictEqual(status, 400);
      assert.ok(body.error);
    });

    it("returns video info for a valid request (mirrors the problem-statement URL)", async () => {
      // This replicates:
      //   GET /info?url=https://youtu.be/wO1282na3w4&key=@SHINDARA1i
      const { status, body } = await get(
        `/info?url=${encodeURIComponent("https://youtu.be/wO1282na3w4")}&key=${encodeURIComponent(TEST_KEY)}`,
      );
      assert.strictEqual(status, 200, `Expected 200 but got ${status}: ${JSON.stringify(body)}`);
      assert.strictEqual(body.title, "Test Video");
      assert.strictEqual(body.duration, 120);
      assert.ok(body.thumbnail, "thumbnail should be present");
      assert.strictEqual(body.uploader, "TestUser");
      assert.strictEqual(body.view_count, 999);
      assert.ok(Array.isArray(body.formats), "formats should be an array");
    });

    it("also accepts the API key via x-api-key header", async () => {
      const { status } = await new Promise((resolve, reject) => {
        const opts = {
          hostname: "127.0.0.1",
          port: TEST_PORT,
          path: `/info?url=${encodeURIComponent("https://youtu.be/wO1282na3w4")}`,
          method: "GET",
          headers: { "x-api-key": TEST_KEY },
        };
        const req = http.request(opts, (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => {
            try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
            catch { resolve({ status: res.statusCode, body }); }
          });
        });
        req.on("error", reject);
        req.end();
      });
      assert.strictEqual(status, 200);
    });
  });
});
