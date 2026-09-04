import { describe, it, expect, vi, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  execFileSync: vi.fn(() => {
    throw new Error("no mock configured");
  }),
}));

vi.mock("child_process", () => ({
  execFileSync: mocks.execFileSync,
}));

import {
  findPython310,
  getHeadroomStatus,
  getInstalledHeadroomExtras,
  isLoopbackHeadroomUrl,
} from "../../src/lib/headroom/detect.js";

afterEach(() => {
  vi.clearAllMocks();
});

// Command-dispatch mock for the child_process.execFileSync-driven detection
// in detect.js. `replies` keys:
//   which  -> { <command>: pathOrBin }  (missing = command not found)
//   uvTools -> raw `uv tool list --show-paths` output
//   version -> { <python>: "X.Y.Z" }    (missing = interpreter absent)
//   pipShow -> { <python>: "x.y.z" }    (missing = headroom-ai not installed there)
//   pipList -> { <python>: packageJson }
function installMock(replies) {
  mocks.execFileSync.mockImplementation((cmd, args = []) => {
    if (cmd === "which" || cmd === "where") {
      const hit = replies.which?.[args[0]];
      if (hit) return Buffer.from(String(hit));
      throw new Error(`command not found: ${args[0]}`);
    }

    const joined = args.join(" ");

    if (joined === "--version") {
      const version = replies.version?.[cmd];
      if (version) return Buffer.from(`Python ${version}\n`);
      throw new Error(`interpreter not found: ${cmd}`);
    }

    if (joined === "-m pip show headroom-ai") {
      const version = replies.pipShow?.[cmd];
      if (version) {
        return Buffer.from(`Name: headroom-ai\nVersion: ${version}\n`);
      }
      throw new Error(`headroom-ai not installed in ${cmd}`);
    }

    if (joined.startsWith("-m pip list ")) {
      return Buffer.from(JSON.stringify(replies.pipList?.[cmd] || []));
    }

    if (joined === "tool list --show-paths") {
      return Buffer.from(replies.uvTools || "");
    }

    throw new Error(`unexpected execFileSync: ${cmd} ${joined}`);
  });
}

describe("headroom detect", () => {
  it("detects installed headroom version and extras from pip list", () => {
    installMock({
      pipList: {
        python3: [
          { name: "headroom-ai", version: "0.26.0" },
          { name: "tree-sitter", version: "0.25.0" },
        ],
      },
    });

    const result = getInstalledHeadroomExtras("python3");

    expect(mocks.execFileSync).toHaveBeenCalledWith(
      "python3",
      ["-m", "pip", "list", "--format=json", "--disable-pip-version-check"],
      expect.objectContaining({ windowsHide: true, timeout: 8000 }),
    );
    expect(result).toEqual({
      installed: true,
      version: "0.26.0",
      extras: { code: true, ml: false },
    });
  });

  it("prefers the interpreter that actually has headroom-ai installed", () => {
    // headroom binary lives in a bin dir; the python next to it has headroom-ai.
    const binPython = "/opt/hr/bin/python3";
    installMock({
      which: { headroom: "/opt/hr/bin/headroom" },
      version: { [binPython]: "3.13.0" },
      pipShow: { [binPython]: "0.26.0" },
    });

    expect(findPython310()).toBe(binPython);
  });

  it("keeps top-level installed flag true when extras are readable", async () => {
    global.fetch = vi.fn(async () => new Response("ok", { status: 200 }));
    installMock({
      which: { headroom: "C:/Python/Scripts/headroom.exe" },
      version: { python3: "3.13.0", python: "3.13.0" },
      pipShow: { python: "0.26.0" },
      pipList: {
        python: [
          { name: "headroom-ai", version: "0.26.0" },
          { name: "tree-sitter", version: "0.25.0" },
        ],
      },
    });

    const status = await getHeadroomStatus("http://localhost:8787");

    expect(status.installed).toBe(true);
    expect(status.version).toBe("0.26.0");
    expect(status.extras).toEqual({ code: true, ml: false });
  });

  it("prefers the uv tool environment when headroom is installed via uv", async () => {
    global.fetch = vi.fn(async () => new Response("ok", { status: 200 }));
    const envPython = "/home/u/.local/share/uv/tools/headroom/bin/python";
    installMock({
      which: { headroom: "/home/u/.local/bin/headroom", uv: "/usr/local/bin/uv" },
      uvTools: [
        "headroom v0.26.0 (/home/u/.local/share/uv/tools/headroom)",
        "- headroom (/home/u/.local/bin/headroom)",
        "",
      ].join("\n"),
      version: { [envPython]: "3.12.0" },
      pipList: {
        [envPython]: [
          { name: "headroom-ai", version: "0.26.0" },
          { name: "tree-sitter", version: "0.25.0" },
        ],
      },
    });

    const status = await getHeadroomStatus("http://localhost:8787");

    expect(status.packageManager).toBe("uv");
    expect(status.python).toBe(envPython);
    expect(status.installed).toBe(true);
    expect(status.version).toBe("0.26.0");
    expect(status.extras).toEqual({ code: true, ml: false });
  });

  it("treats a reachable external proxy as running without local CLI", async () => {
    global.fetch = vi.fn(async () => new Response("ok", { status: 200 }));
    installMock({});

    const status = await getHeadroomStatus("http://headroom:8787");

    expect(status.installed).toBe(false);
    expect(status.running).toBe(true);
    expect(status.localUrl).toBe(false);
    expect(status.canStart).toBe(false);
    expect(global.fetch).toHaveBeenCalledWith("http://headroom:8787/health", expect.any(Object));
  });

  it("recognizes loopback URLs for managed local mode", () => {
    expect(isLoopbackHeadroomUrl("http://localhost:8787")).toBe(true);
    expect(isLoopbackHeadroomUrl("http://127.0.0.1:8787")).toBe(true);
    expect(isLoopbackHeadroomUrl("http://headroom:8787")).toBe(false);
    expect(isLoopbackHeadroomUrl("not-a-url")).toBe(false);
  });
});