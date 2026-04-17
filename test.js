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
const TEST_KEY = "@SHINDARA1i"; // sample API key used for testing; set API_KEY=<this> in your Railway env

process.env.PORT = String(TEST_PORT);
process.env.API_KEY = TEST_KEY;
process.env.YT_DLP_PATH = STUB_PATH;

const app = require("./server");
const { isMissingBinaryError, findExecutableInPath, resolveFfmpegLocation } = app.__test__;

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

function getWithHeaders(urlPath, headers) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: "127.0.0.1",
      port: TEST_PORT,
      path: urlPath,
      method: "GET",
      headers,
    };
    const req = http.request(opts, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body, headers: res.headers }));
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
    it("returns HTML test page by default (browser request)", async () => {
      const { status, body, headers } = await getWithHeaders("/", { accept: "text/html" });
      assert.strictEqual(status, 200);
      assert.ok(headers["content-type"]?.includes("text/html"), "should be HTML");
      assert.ok(body.includes("Boss-Bot Download Server"), "should contain server name");
      assert.ok(body.includes("/info"), "should reference /info endpoint");
      assert.ok(body.includes("testInfo"), "should include the JS test function");
    });

    it("returns JSON health-check when Accept is application/json", async () => {
      const { status, body: raw } = await getWithHeaders("/", { accept: "application/json" });
      const body = JSON.parse(raw);
      assert.strictEqual(status, 200);
      assert.strictEqual(body.status, "ok");
      assert.strictEqual(body.service, "Boss-Bot Download Server");
      assert.ok(Array.isArray(body.endpoints), "endpoints should be an array");
      assert.ok(body.endpoints.includes("/info"), "endpoints should include /info");
    });

    it("returns JSON health-check when ?format=json is specified", async () => {
      const { status, body } = await get("/?format=json");
      assert.strictEqual(status, 200);
      assert.strictEqual(body.status, "ok");
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

  describe("isMissingBinaryError", () => {
    it("detects true missing binary errors", () => {
      assert.equal(isMissingBinaryError({ code: "ENOENT" }, ""), true);
      assert.equal(isMissingBinaryError(new Error("spawn yt-dlp ENOENT"), ""), true);
      assert.equal(isMissingBinaryError(new Error("spawn /usr/local/bin/yt-dlp ENOENT"), ""), true);
    });

    it("does not misclassify generic runtime not found text", () => {
      assert.equal(
        isMissingBinaryError(new Error("Command failed"), "ERROR: HTTP Error 404: Not Found"),
        false,
      );
    });

    it("does not treat ffmpeg stderr missing-file text as missing yt-dlp binary", () => {
      assert.equal(
        isMissingBinaryError(new Error("Command failed"), "ffmpeg: No such file or directory"),
        false,
      );
    });

    it("does not treat non-yt-dlp spawn ENOENT text as missing yt-dlp binary", () => {
      assert.equal(
        isMissingBinaryError(new Error("spawn ffmpeg ENOENT"), ""),
        false,
      );
    });

    it("handles yt-dlp spawn ENOENT when binary path contains spaces", () => {
      assert.equal(
        isMissingBinaryError(new Error("spawn /Program Files/tools/yt-dlp.exe ENOENT"), ""),
        true,
      );
    });
  });

  describe("findExecutableInPath", () => {
    it("finds an executable in PATH", () => {
      const fakeDir = path.join(TMP, "path-bin");
      fs.mkdirSync(fakeDir, { recursive: true });
      const fakeBin = path.join(fakeDir, "yt-dlp");
      fs.writeFileSync(fakeBin, "#!/bin/sh\nexit 0\n", "utf8");
      fs.chmodSync(fakeBin, 0o755);

      const originalPath = process.env.PATH;
      process.env.PATH = `${fakeDir}${path.delimiter}${originalPath || ""}`;
      try {
        const resolved = findExecutableInPath("yt-dlp");
        assert.strictEqual(resolved, fakeBin);
      } finally {
        process.env.PATH = originalPath;
      }
    });

    it("returns null when executable is missing from PATH", () => {
      const originalPath = process.env.PATH;
      process.env.PATH = "";
      try {
        assert.strictEqual(findExecutableInPath("yt-dlp"), null);
      } finally {
        process.env.PATH = originalPath;
      }
    });
  });

  describe("resolveFfmpegLocation", () => {
    it("prefers explicit ffmpeg location environment variable", () => {
      const originalYtdlp = process.env.YTDLP_FFMPEG_LOCATION;
      const originalFfmpeg = process.env.FFMPEG_LOCATION;
      process.env.YTDLP_FFMPEG_LOCATION = "/custom/ffmpeg";
      process.env.FFMPEG_LOCATION = "/custom/fallback";
      try {
        assert.strictEqual(resolveFfmpegLocation(), "/custom/ffmpeg");
      } finally {
        process.env.YTDLP_FFMPEG_LOCATION = originalYtdlp;
        process.env.FFMPEG_LOCATION = originalFfmpeg;
      }
    });

    it("returns a directory when ffmpeg and ffprobe are both available there", () => {
      const fakeDir = path.join(TMP, "ffmpeg-bin");
      fs.mkdirSync(fakeDir, { recursive: true });
      const ffmpegName = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
      const ffprobeName = process.platform === "win32" ? "ffprobe.exe" : "ffprobe";
      const ffmpegPath = path.join(fakeDir, ffmpegName);
      const ffprobePath = path.join(fakeDir, ffprobeName);
      fs.writeFileSync(ffmpegPath, "#!/bin/sh\nexit 0\n", "utf8");
      fs.writeFileSync(ffprobePath, "#!/bin/sh\nexit 0\n", "utf8");
      if (process.platform !== "win32") {
        fs.chmodSync(ffmpegPath, 0o755);
        fs.chmodSync(ffprobePath, 0o755);
      }

      const originalPath = process.env.PATH;
      const originalYtdlp = process.env.YTDLP_FFMPEG_LOCATION;
      const originalFfmpeg = process.env.FFMPEG_LOCATION;
      process.env.PATH = `${fakeDir}${path.delimiter}${originalPath || ""}`;
      delete process.env.YTDLP_FFMPEG_LOCATION;
      delete process.env.FFMPEG_LOCATION;
      try {
        assert.strictEqual(resolveFfmpegLocation(), fakeDir);
      } finally {
        process.env.PATH = originalPath;
        process.env.YTDLP_FFMPEG_LOCATION = originalYtdlp;
        process.env.FFMPEG_LOCATION = originalFfmpeg;
      }
    });

    it("returns ffmpeg executable path when ffprobe is available in a different directory", () => {
      const ffmpegDir = path.join(TMP, "ffmpeg-only-bin");
      const ffprobeDir = path.join(TMP, "ffprobe-only-bin");
      fs.mkdirSync(ffmpegDir, { recursive: true });
      fs.mkdirSync(ffprobeDir, { recursive: true });

      const ffmpegName = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
      const ffprobeName = process.platform === "win32" ? "ffprobe.exe" : "ffprobe";
      const ffmpegPath = path.join(ffmpegDir, ffmpegName);
      const ffprobePath = path.join(ffprobeDir, ffprobeName);
      fs.writeFileSync(ffmpegPath, "#!/bin/sh\nexit 0\n", "utf8");
      fs.writeFileSync(ffprobePath, "#!/bin/sh\nexit 0\n", "utf8");
      if (process.platform !== "win32") {
        fs.chmodSync(ffmpegPath, 0o755);
        fs.chmodSync(ffprobePath, 0o755);
      }

      const originalPath = process.env.PATH;
      const originalYtdlp = process.env.YTDLP_FFMPEG_LOCATION;
      const originalFfmpeg = process.env.FFMPEG_LOCATION;
      process.env.PATH = `${ffmpegDir}${path.delimiter}${ffprobeDir}${path.delimiter}${originalPath || ""}`;
      delete process.env.YTDLP_FFMPEG_LOCATION;
      delete process.env.FFMPEG_LOCATION;
      try {
        assert.strictEqual(resolveFfmpegLocation(), ffmpegPath);
      } finally {
        process.env.PATH = originalPath;
        process.env.YTDLP_FFMPEG_LOCATION = originalYtdlp;
        process.env.FFMPEG_LOCATION = originalFfmpeg;
      }
    });
  });
});
