import fs from "fs";
import path from "path";
import { spawn } from "child_process";

import { DATA_DIR } from "@/lib/dataDir.js";

import {
  findHeadroomBinary,
  pkgManager,
  HEADROOM_COMPRESSION_EXTRAS,
  EXTRA_MARKERS,
  getInstalledHeadroomExtras,
} from "./detect.js";

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const HEADROOM_DIR =
  path.join(
    DATA_DIR,
    "headroom",
  );

const PID_FILE =
  path.join(
    HEADROOM_DIR,
    "proxy.pid",
  );

const LOG_FILE =
  path.join(
    HEADROOM_DIR,
    "proxy.log",
  );

const INSTALL_LOG_FILE =
  path.join(
    HEADROOM_DIR,
    "install.log",
  );

const DEFAULT_PORT = 8787;
const STARTUP_TIMEOUT_MS = 8000;

// -----------------------------------------------------------------------------
// Filesystem helpers
// -----------------------------------------------------------------------------

function ensureDir() {
  if (
    !fs.existsSync(
      HEADROOM_DIR,
    )
  ) {
    fs.mkdirSync(
      HEADROOM_DIR,
      {
        recursive: true,
      },
    );
  }
}

function readPid() {
  try {
    if (
      !fs.existsSync(
        PID_FILE,
      )
    ) {
      return null;
    }

    return parseInt(
      fs.readFileSync(
        PID_FILE,
        "utf8",
      ),
      10,
    );
  } catch {
    return null;
  }
}

function writePid(pid) {
  ensureDir();

  fs.writeFileSync(
    PID_FILE,
    String(pid),
  );
}

function clearPid() {
  try {
    if (
      fs.existsSync(
        PID_FILE,
      )
    ) {
      fs.unlinkSync(
        PID_FILE,
      );
    }
  } catch {
    // Already removed.
  }
}

// -----------------------------------------------------------------------------
// Process helpers
// -----------------------------------------------------------------------------

export function isPidAlive(pid) {
  if (
    !pid ||
    typeof pid !== "number"
  ) {
    return false;
  }

  try {
    process.kill(
      pid,
      0,
    );

    return true;
  } catch {
    return false;
  }
}

export function getManagedPid() {
  const pid = readPid();

  return pid &&
    isPidAlive(pid)
    ? pid
    : null;
}

// -----------------------------------------------------------------------------
// Proxy arguments
// -----------------------------------------------------------------------------

function extrasProxyArgs({
  codeAware = false,
  kompress = true,
} = {}) {
  const args = [];

  if (codeAware) {
    args.push(
      "--code-aware",
    );
  }

  if (!kompress) {
    args.push(
      "--disable-kompress",
    );
  }

  return args;
}

// -----------------------------------------------------------------------------
// Headroom process lifecycle
// -----------------------------------------------------------------------------

export async function startHeadroomProxy({
  port = DEFAULT_PORT,
  codeAware = false,
  kompress = true,
} = {}) {
  const safePort =
    Number(port) > 0 &&
    Number(port) < 65536
      ? Number(port)
      : DEFAULT_PORT;

  const binary =
    findHeadroomBinary();

  if (!binary) {
    const error =
      new Error(
        "Headroom CLI not installed",
      );

    error.code =
      "NOT_INSTALLED";

    throw error;
  }

  const existing =
    getManagedPid();

  if (existing) {
    return {
      pid: existing,
      alreadyRunning: true,
    };
  }

  ensureDir();

  // spawn() expects file descriptors for stdio.
  const outFd =
    fs.openSync(
      LOG_FILE,
      "a",
    );

  const args = [
    "proxy",
    "--port",
    String(safePort),
    ...extrasProxyArgs({
      codeAware,
      kompress,
    }),
  ];

  const child =
    spawn(
      binary,
      args,
      {
        stdio: [
          "ignore",
          outFd,
          outFd,
        ],
        detached: true,
        windowsHide: true,
        env: {
          ...process.env,
        },
      },
    );

  if (!child.pid) {
    fs.closeSync(
      outFd,
    );

    const error =
      new Error(
        "Failed to spawn headroom proxy",
      );

    error.code =
      "SPAWN_FAILED";

    throw error;
  }

  child.unref();

  writePid(
    child.pid,
  );

  await new Promise(
    (resolve, reject) => {
      const startupTimer =
        setTimeout(
          () => {
            if (
              isPidAlive(
                child.pid,
              )
            ) {
              resolve();
            } else {
              const error =
                new Error(
                  "headroom proxy exited during startup — see proxy.log",
                );

              error.code =
                "EARLY_EXIT";

              reject(error);
            }
          },
          STARTUP_TIMEOUT_MS,
        );

      child.once(
        "exit",
        (code) => {
          clearTimeout(
            startupTimer,
          );

          clearPid();

          try {
            fs.closeSync(
              outFd,
            );
          } catch {
            // Already closed.
          }

          const error =
            new Error(
              `headroom proxy exited early (code=${code}) — see proxy.log`,
            );

          error.code =
            "EARLY_EXIT";

          reject(error);
        },
      );

      child.once(
        "error",
        (error) => {
          clearTimeout(
            startupTimer,
          );

          clearPid();

          try {
            fs.closeSync(
              outFd,
            );
          } catch {
            // Already closed.
          }

          reject(error);
        },
      );
    },
  );

  // Parent no longer needs the file descriptor.
  try {
    fs.closeSync(
      outFd,
    );
  } catch {
    // Already closed by exit/error handler.
  }

  return {
    pid: child.pid,
    alreadyRunning: false,
  };
}

export function stopHeadroomProxy() {
  const pid =
    getManagedPid();

  if (!pid) {
    return {
      stopped: false,
      reason: "not_running",
    };
  }

  try {
    process.kill(
      pid,
      "SIGTERM",
    );

    // Give the process a moment before force-killing it.
    setTimeout(
      () => {
        if (
          !isPidAlive(pid)
        ) {
          return;
        }

        try {
          process.kill(
            pid,
            "SIGKILL",
          );
        } catch {
          // Process exited already.
        }
      },
      2000,
    );

    clearPid();

    return {
      stopped: true,
      pid,
    };
  } catch (error) {
    clearPid();

    const err =
      new Error(
        `Failed to stop headroom proxy: ${error.message}`,
      );

    err.code =
      "STOP_FAILED";

    throw err;
  }
}

export async function restartHeadroomProxy(
  opts = {},
) {
  const pid =
    getManagedPid();

  if (pid) {
    try {
      process.kill(
        pid,
        "SIGTERM",
      );
    } catch {
      // Already stopped.
    }

    // Wait up to ~3 seconds for graceful shutdown.
    for (
      let i = 0;
      i < 30 &&
      isPidAlive(pid);
      i++
    ) {
      await new Promise(
        (resolve) =>
          setTimeout(
            resolve,
            100,
          ),
      );
    }

    // Force kill if necessary.
    if (
      isPidAlive(pid)
    ) {
      try {
        process.kill(
          pid,
          "SIGKILL",
        );
      } catch {
        // Already stopped.
      }

      await new Promise(
        (resolve) =>
          setTimeout(
            resolve,
            300,
          ),
      );
    }

    clearPid();
  }

  return startHeadroomProxy(
    opts,
  );
}

// -----------------------------------------------------------------------------
// Logs
// -----------------------------------------------------------------------------

function readLogTail(
  file,
  maxLines,
) {
  try {
    if (
      !fs.existsSync(file)
    ) {
      return "";
    }

    const lines =
      fs.readFileSync(
        file,
        "utf8",
      )
        .split(/\r?\n/)
        .filter(Boolean);

    return lines
      .slice(-maxLines)
      .join("\n");
  } catch {
    return "";
  }
}

export function getHeadroomLogTail(
  maxLines = 200,
) {
  return readLogTail(
    LOG_FILE,
    maxLines,
  );
}

export function getInstallLogTail(
  maxLines = 15,
) {
  return readLogTail(
    INSTALL_LOG_FILE,
    maxLines,
  );
}

// -----------------------------------------------------------------------------
// Package operation helper
// -----------------------------------------------------------------------------

function runPackageCommand({
  command,
  args,
  success,
  failureCode,
}) {
  ensureDir();

  // Replace the previous installation log for each new operation.
  const outFd =
    fs.openSync(
      INSTALL_LOG_FILE,
      "w",
    );

  const child =
    spawn(
      command,
      args,
      {
        stdio: [
          "ignore",
          outFd,
          outFd,
        ],
        windowsHide: true,
        env: {
          ...process.env,
        },
      },
    );

  return new Promise(
    (resolve, reject) => {
      let settled = false;

      function closeFd() {
        try {
          fs.closeSync(
            outFd,
          );
        } catch {
          // Already closed.
        }
      }

      child.once(
        "error",
        (error) => {
          if (settled) return;

          settled = true;
          closeFd();

          reject(error);
        },
      );

      child.once(
        "exit",
        (code) => {
          if (settled) return;

          settled = true;
          closeFd();

          if (code === 0) {
            resolve(
              success(code),
            );
            return;
          }

          const error =
            new Error(
              `Package command exited with code=${code} — see headroom/install.log`,
            );

          error.code =
            failureCode;

          reject(error);
        },
      );
    },
  );
}

// -----------------------------------------------------------------------------
// Headroom package installation
// -----------------------------------------------------------------------------

export async function installHeadroomExtras(
  extras = [],
) {
  const requested =
    Array.isArray(extras)
      ? extras.filter(
          (extra) =>
            HEADROOM_COMPRESSION_EXTRAS.includes(
              extra,
            ),
        )
      : [];

  const pm =
    pkgManager();

  if (!pm.manager) {
    const error =
      new Error(
        "Neither uv nor Python >= 3.10 was found",
      );

    error.code =
      "NO_PACKAGE_MANAGER";

    throw error;
  }

  if (!findHeadroomBinary()) {
    const error =
      new Error(
        "headroom-ai is not installed",
      );

    error.code =
      "NOT_INSTALLED";

    throw error;
  }

  const extrasList =
    [
      "proxy",
      ...requested,
    ].join(",");

  const spec =
    `headroom-ai[${extrasList}]`;

  // pkgManager owns the actual package-manager choice.
  const operation =
    pm.install(
      spec,
    );

  return runPackageCommand({
    command:
      operation.command,

    args:
      operation.args,

    failureCode:
      "INSTALL_FAILED",

    success(code) {
      const status =
        getInstalledHeadroomExtras(
          pm.python,
        );

      return {
        success: true,
        code,
        spec,
        extras: requested,
        manager:
          operation.manager,
        ...status,
      };
    },
  });
}

// -----------------------------------------------------------------------------
// Headroom extra removal
// -----------------------------------------------------------------------------

export async function uninstallHeadroomExtras(
  extras = [],
) {
  const requested =
    Array.isArray(extras)
      ? extras.filter(
          (extra) =>
            HEADROOM_COMPRESSION_EXTRAS.includes(
              extra,
            ),
        )
      : [];

  const pkgs =
    [
      ...new Set(
        requested.flatMap(
          (extra) =>
            EXTRA_MARKERS[extra] || [],
        ),
      ),
    ];

  if (!pkgs.length) {
    const error =
      new Error(
        "No valid extras to remove",
      );

    error.code =
      "INVALID_EXTRAS";

    throw error;
  }

  const pm =
    pkgManager();

  // Uninstall intentionally uses pip against the selected Python environment.
  const operation =
    pm.uninstall(
      pkgs,
    );

  return runPackageCommand({
    command:
      operation.command,

    args:
      operation.args,

    failureCode:
      "UNINSTALL_FAILED",

    success(code) {
      const status =
        getInstalledHeadroomExtras(
          pm.python,
        );

      return {
        success: true,
        code,
        removed: pkgs,
        extras: requested,
        manager:
          operation.manager,
        ...status,
      };
    },
  });
}