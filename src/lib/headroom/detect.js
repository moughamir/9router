import { execFileSync } from "child_process";
import path from "path";

// -----------------------------------------------------------------------------
// Headroom package metadata
// -----------------------------------------------------------------------------

// Extras that improve headroom compression quality.
// `proxy` is the base package extra.
// `code` adds tree-sitter AST compression.
// `ml` adds Kompress-v2 / HuggingFace model support.
export const HEADROOM_COMPRESSION_EXTRAS = [
  "code",
  "ml",
];

// Marker packages used to determine whether an extra is installed.
export const EXTRA_MARKERS = {
  code: [
    "tree-sitter",
    "tree-sitter-language-pack",
  ],
  ml: [
    "torch",
    "huggingface-hub",
  ],
};

// -----------------------------------------------------------------------------
// Environment constants
// -----------------------------------------------------------------------------

const IS_WINDOWS = process.platform === "win32";

const WHICH_COMMAND = IS_WINDOWS
  ? "where"
  : "which";

const HEADROOM_PIP_TIMEOUT_MS = 8000;
const HEADROOM_HEALTH_TIMEOUT_MS = 1500;

const MIN_PYTHON = {
  major: 3,
  minor: 10,
};

const PYTHON_CANDIDATES = [
  "python3.13",
  "python3.12",
  "python3.11",
  "python3.10",
  "python3",
  "python",
];

const LOOPBACK_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
  "0.0.0.0",
]);

// Extra binary locations frequently missing from packaged applications,
// launchd services, desktop shells, etc.
const EXTRA_BINS = IS_WINDOWS
  ? [
      `${process.env.LOCALAPPDATA || ""}\\Programs\\Python\\Python313\\Scripts`,
      `${process.env.LOCALAPPDATA || ""}\\Programs\\Python\\Python312\\Scripts`,
      `${process.env.LOCALAPPDATA || ""}\\Programs\\Python\\Python311\\Scripts`,
      `${process.env.LOCALAPPDATA || ""}\\Programs\\Python\\Python310\\Scripts`,
      `${process.env.APPDATA || ""}\\Python\\Python313\\Scripts`,
      `${process.env.APPDATA || ""}\\Python\\Python312\\Scripts`,
      `${process.env.APPDATA || ""}\\Python\\Python311\\Scripts`,
      `${process.env.APPDATA || ""}\\Python\\Python310\\Scripts`,
    ]
  : [
      "/usr/local/bin",
      "/opt/homebrew/bin",
      "/Library/Frameworks/Python.framework/Versions/3.13/bin",
      "/Library/Frameworks/Python.framework/Versions/3.12/bin",
      "/Library/Frameworks/Python.framework/Versions/3.11/bin",
      "/Library/Frameworks/Python.framework/Versions/3.10/bin",
      `${process.env.HOME || ""}/.local/bin`,
      "/usr/bin",
      "/bin",
    ];

const EXTENDED_PATH = [
  ...EXTRA_BINS,
  process.env.PATH || "",
]
  .filter(Boolean)
  .join(path.delimiter);

export const DEFAULT_HEADROOM_URL =
  process.env.HEADROOM_URL ||
  "http://localhost:8787";

// -----------------------------------------------------------------------------
// Generic command helpers
// -----------------------------------------------------------------------------

function commandPath(command) {
  try {
    const output = execFileSync(
      WHICH_COMMAND,
      [command],
      {
        stdio: [
          "ignore",
          "pipe",
          "ignore",
        ],
        windowsHide: true,
        env: {
          ...process.env,
          PATH: EXTENDED_PATH,
        },
      },
    )
      .toString()
      .trim();

    return output
      ? output.split(/\r?\n/)[0].trim()
      : null;
  } catch {
    return null;
  }
}

function runCommand(
  command,
  args = [],
  options = {},
) {
  return execFileSync(
    command,
    args,
    {
      stdio: [
        "ignore",
        "pipe",
        "pipe",
      ],
      windowsHide: true,
      env: {
        ...process.env,
        PATH: EXTENDED_PATH,
      },
      ...options,
    },
  )
    .toString()
    .trim();
}

// -----------------------------------------------------------------------------
// Headroom binary detection
// -----------------------------------------------------------------------------

export function findHeadroomBinary() {
  return commandPath(
    IS_WINDOWS
      ? "headroom.exe"
      : "headroom",
  );
}

// -----------------------------------------------------------------------------
// Central package manager
// -----------------------------------------------------------------------------

// When headroom was installed with `uv tool install`, its packages live in an
// isolated env under the uv tools directory rather than in a Python on PATH.
// Resolve that env's interpreter from `uv tool list --show-paths` so detection
// and uninstall read the same environment the installer wrote to.
function headroomUvToolPython(uv) {
  try {
    const output = runCommand(
      uv,
      ["tool", "list", "--show-paths"],
      {
        timeout: HEADROOM_PIP_TIMEOUT_MS,
      },
    );

    const match = output.match(
      /^headroom\s+v[^\s]+\s+\(([^)]+)\)/m,
    );

    if (!match) return null;

    return path.join(
      match[1],
      IS_WINDOWS ? "Scripts" : "bin",
      IS_WINDOWS ? "python.exe" : "python",
    );
  } catch {
    return null;
  }
}

/**
 * Detect the complete Python/package environment.
 *
 * This is the ONLY place that decides:
 *
 * - operating system
 * - available Python
 * - Python version
 * - available uv
 * - preferred package manager
 * - install command
 * - uninstall command
 * - pip command
 *
 * Policy:
 *
 *   install:
 *     1. uv tool
 *     2. Python -m pip
 *
 *   Python selection:
 *     1. Python inside the uv-managed headroom tool env (uv tool install)
 *     2. Python associated with installed Headroom
 *     3. known Python installation directories
 *     4. PATH
 *     5. first supported Python >= 3.10
 */
export function pkgManager() {
  const os = {
    platform: process.platform,
    isWindows: IS_WINDOWS,
    isLinux: process.platform === "linux",
    isMacOS: process.platform === "darwin",
  };

  // ---------------------------------------------------------------------------
  // Discover uv
  // ---------------------------------------------------------------------------

  const uv = commandPath(
    IS_WINDOWS
      ? "uv.exe"
      : "uv",
  );

  // ---------------------------------------------------------------------------
  // Discover Python candidates
  // ---------------------------------------------------------------------------

  const pythonCandidates = [];
  const seenCandidates = new Set();

  function addPythonCandidate(candidate) {
    if (!candidate) return;
    if (seenCandidates.has(candidate)) return;

    seenCandidates.add(candidate);
    pythonCandidates.push(candidate);
  }

  // Strongest signal: Python next to the Headroom binary.
  const headroomBinary = findHeadroomBinary();

  // Prefer the interpreter of a uv-managed headroom env when headroom is
  // installed via uv tool.
  if (uv && headroomBinary) {
    const uvToolPython = headroomUvToolPython(uv);

    if (uvToolPython && !seenCandidates.has(uvToolPython)) {
      seenCandidates.add(uvToolPython);
      pythonCandidates.unshift(uvToolPython);
    }
  }

  if (headroomBinary) {
    const headroomDir = path.dirname(
      headroomBinary,
    );

    const siblingNames = IS_WINDOWS
      ? [
          "python.exe",
          "python3.exe",
        ]
      : [
          "python3",
          "python",
          "python3.13",
        ];

    for (const name of siblingNames) {
      addPythonCandidate(
        path.join(
          headroomDir,
          name,
        ),
      );
    }
  }

  // Known installation directories.
  for (const directory of EXTRA_BINS) {
    if (!directory) continue;

    for (const name of PYTHON_CANDIDATES) {
      addPythonCandidate(
        path.join(
          directory,
          IS_WINDOWS
            ? `${name}.exe`
            : name,
        ),
      );
    }
  }

  // PATH-resolved candidates.
  for (const name of PYTHON_CANDIDATES) {
    addPythonCandidate(name);
  }

  // ---------------------------------------------------------------------------
  // Discover supported Python
  // ---------------------------------------------------------------------------

  let python = null;
  let fallbackPython = null;

  function parsePythonVersion(version) {
    const match = String(version).match(
      /(\d+)\.(\d+)/,
    );

    if (!match) {
      return null;
    }

    return {
      major: Number(match[1]),
      minor: Number(match[2]),
    };
  }

  function supportsPython(version) {
    if (!version) {
      return false;
    }

    return (
      version.major > MIN_PYTHON.major ||
      (
        version.major === MIN_PYTHON.major &&
        version.minor >= MIN_PYTHON.minor
      )
    );
  }

  function pythonHasHeadroom(candidate) {
    try {
      runCommand(
        candidate,
        [
          "-m",
          "pip",
          "show",
          "headroom-ai",
        ],
        {
          timeout: HEADROOM_PIP_TIMEOUT_MS,
        },
      );

      return true;
    } catch {
      return false;
    }
  }

  for (const candidate of pythonCandidates) {
    try {
      const versionOutput = runCommand(
        candidate,
        ["--version"],
      );

      const version =
        parsePythonVersion(
          versionOutput,
        );

      if (!supportsPython(version)) {
        continue;
      }

      // Keep the first valid interpreter as fallback.
      fallbackPython ||= candidate;

      // Prefer an interpreter already containing headroom-ai.
      if (
        pythonHasHeadroom(
          candidate,
        )
      ) {
        python = candidate;
        break;
      }
    } catch {
      // Candidate unavailable.
    }
  }

  python ||= fallbackPython;

  // uv wins for installation.
  //
  // We still retain Python because uninstall/status operations target the
  // existing Python environment.
  const manager =
    uv
      ? "uv"
      : python
        ? "pip"
        : null;

  // ---------------------------------------------------------------------------
  // Command builders
  // ---------------------------------------------------------------------------

  function requirePython() {
    if (!python) {
      const error = new Error(
        "Python >= 3.10 not found",
      );

      error.code = "NO_PYTHON";

      throw error;
    }

    return python;
  }

  function requireManager() {
    if (!manager) {
      const error = new Error(
        "Neither uv nor Python >= 3.10 was found",
      );

      error.code = "NO_PACKAGE_MANAGER";

      throw error;
    }

    return manager;
  }

  function install(spec) {
    const selectedManager =
      requireManager();

    if (selectedManager === "uv") {
      return {
        manager: "uv",
        command: uv,
        args: [
          "tool",
          "install",
          "--upgrade",
          spec,
        ],
      };
    }

    return {
      manager: "pip",
      command: python,
      args: [
        "-m",
        "pip",
        "install",
        "--upgrade",
        spec,
      ],
    };
  }

  function uninstall(packages) {
    const selectedPython =
      requirePython();

    const list = Array.isArray(packages)
      ? packages
      : [packages];

    return {
      manager: "pip",
      command: selectedPython,
      args: [
        "-m",
        "pip",
        "uninstall",
        "-y",
        ...list,
      ],
    };
  }

  function pip(args = []) {
    const selectedPython =
      requirePython();

    return {
      manager: "pip",
      command: selectedPython,
      args: [
        "-m",
        "pip",
        ...args,
      ],
    };
  }

  function version() {
    return {
      python: python
        ? runCommand(
            python,
            ["--version"],
          )
        : null,

      uv: uv
        ? runCommand(
            uv,
            ["--version"],
          )
        : null,
    };
  }

  return {
    os,

    python,
    uv,

    manager,

    headroom: {
      binary: headroomBinary,
      installed: Boolean(
        headroomBinary,
      ),
    },

    install,
    uninstall,
    pip,
    version,
  };
}

// -----------------------------------------------------------------------------
// Backward compatibility
// -----------------------------------------------------------------------------

/**
 * Existing callers can continue using findPython310().
 *
 * New code should normally use:
 *
 *   const pm = pkgManager();
 *   pm.python
 */
export function findPython310() {
  return pkgManager().python;
}

// -----------------------------------------------------------------------------
// Headroom health helpers
// -----------------------------------------------------------------------------

export async function probeProxyRunning(
  url,
) {
  if (!url) {
    return false;
  }

  const base =
    String(url).replace(
      /\/$/,
      "",
    );

  try {
    const response =
      await fetch(
        `${base}/health`,
        {
          signal:
            AbortSignal.timeout(
              HEADROOM_HEALTH_TIMEOUT_MS,
            ),
        },
      );

    return response.ok;
  } catch {
    return false;
  }
}

export function isLoopbackHeadroomUrl(
  url,
) {
  try {
    const parsed =
      new URL(url);

    return LOOPBACK_HOSTS.has(
      parsed.hostname,
    );
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------------
// Headroom status
// -----------------------------------------------------------------------------

export async function getHeadroomStatus(
  url,
) {
  const binary =
    findHeadroomBinary();

  const pm =
    pkgManager();

  const installed =
    Boolean(binary);

  const running =
    await probeProxyRunning(url);

  const localUrl =
    isLoopbackHeadroomUrl(url);

  const extrasStatus =
    installed
      ? getInstalledHeadroomExtras(
          pm.python,
        )
      : {
          installed: false,
          version: null,
          extras: {
            code: false,
            ml: false,
          },
        };

  return {
    installed,
    path: binary,
    running,
    python: pm.python,
    uv: pm.uv,
    manager: pm.manager,
    packageManager: pm.manager,
    localUrl,
    canStart:
      installed && localUrl,
    version:
      extrasStatus.version,
    extras:
      extrasStatus.extras,
  };
}

// -----------------------------------------------------------------------------
// Installed package inspection
// -----------------------------------------------------------------------------

export function getInstalledHeadroomExtras(
  python,
) {
  const py =
    python || pkgManager().python;

  if (!py) {
    return {
      installed: false,
      version: null,
      extras: {
        code: false,
        ml: false,
      },
    };
  }

  try {
    const output =
      runCommand(
        py,
        [
          "-m",
          "pip",
          "list",
          "--format=json",
          "--disable-pip-version-check",
        ],
        {
          timeout:
            HEADROOM_PIP_TIMEOUT_MS,
        },
      );

    const packages =
      JSON.parse(output);

    const names =
      new Set(
        packages.map(
          (pkg) =>
            String(
              pkg.name || "",
            ).toLowerCase(),
        ),
      );

    const installed =
      names.has("headroom-ai");

    if (!installed) {
      return {
        installed: false,
        version: null,
        extras: {
          code: false,
          ml: false,
        },
      };
    }

    const packageInfo =
      packages.find(
        (pkg) =>
          String(
            pkg.name || "",
          ).toLowerCase() ===
          "headroom-ai",
      );

    const extras = {};

    for (
      const extra
      of HEADROOM_COMPRESSION_EXTRAS
    ) {
      extras[extra] =
        EXTRA_MARKERS[extra].some(
          (marker) =>
            names.has(
              marker.toLowerCase(),
            ),
        );
    }

    return {
      installed: true,
      version:
        packageInfo?.version ||
        null,
      extras,
    };
  } catch {
    return {
      installed: false,
      version: null,
      extras: {
        code: false,
        ml: false,
      },
    };
  }
}