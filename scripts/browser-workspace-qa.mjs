import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";

const DEFAULT_BASE_URL = "http://localhost:3000";
const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900, mobile: false },
  { name: "tablet", width: 1024, height: 768, mobile: false },
  { name: "mobile", width: 390, height: 844, mobile: true }
];
const INTERNAL_PUBLIC_TERMS = [
  "Runtime readiness",
  "Runtime diagnostics",
  "Run diagnostics",
  "Claim inventory",
  "Evidence pack",
  "Hosted health",
  "Provider failure",
  "Stage timings",
  "backend",
  "model",
  "alpha",
  "debug",
  "qwen",
  "ollama",
  "vllm"
];
const PUBLIC_DEV_SESSION_PATHS = new Set(["/api/session/dev", "/api/dev/session"]);

function parseArgs(argv) {
  const options = {
    baseUrl: process.env.CLAIMGRAPH_QA_BASE_URL ?? DEFAULT_BASE_URL,
    reviewMode: process.env.CLAIMGRAPH_QA_REVIEW === "1",
    saveScreenshots: process.env.CLAIMGRAPH_QA_SAVE_SCREENSHOTS === "1",
    screenshotDir: process.env.CLAIMGRAPH_QA_SCREENSHOT_DIR ?? null
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--screenshots" || arg === "--save-screenshots") {
      options.saveScreenshots = true;
      continue;
    }

    if (arg === "--review") {
      options.reviewMode = true;
      options.saveScreenshots = true;
      continue;
    }

    if (arg === "--screenshot-dir") {
      const nextArg = argv[index + 1];

      if (!nextArg) {
        throw new Error("--screenshot-dir requires a path.");
      }

      options.screenshotDir = nextArg;
      index += 1;
      continue;
    }

    if (arg === "--base-url") {
      const nextArg = argv[index + 1];

      if (!nextArg) {
        throw new Error("--base-url requires a URL.");
      }

      options.baseUrl = nextArg;
      index += 1;
      continue;
    }

    if (!arg.startsWith("--")) {
      options.baseUrl = arg;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (options.reviewMode) {
    options.saveScreenshots = true;
  }

  return options;
}

function createScreenshotRecorder(options) {
  if (!options.saveScreenshots) {
    return {
      enabled: false,
      dir: null,
      paths: []
    };
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const defaultFolderName = options.reviewMode
    ? `workspace-review-${timestamp}`
    : `workspace-qa-${timestamp}`;
  const dir = path.resolve(
    options.screenshotDir ?? path.join("runtime_data", "qa-screenshots", defaultFolderName)
  );

  mkdirSync(dir, { recursive: true });

  return {
    enabled: true,
    reviewMode: options.reviewMode,
    dir,
    paths: [],
    shots: []
  };
}

function screenshotName(label) {
  return `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}.png`;
}

async function saveScreenshot(client, recorder, label) {
  if (!recorder.enabled) {
    return null;
  }

  const result = await client.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false
  });
  const filename = screenshotName(label);
  const outputPath = path.join(recorder.dir, filename);

  writeFileSync(outputPath, Buffer.from(result.data, "base64"));
  recorder.paths.push(outputPath);
  recorder.shots.push({
    label,
    filename,
    path: outputPath
  });
  return outputPath;
}

function expectedScreenshotLabels() {
  return VIEWPORTS.flatMap((viewport) => {
    const labels = [
      `${viewport.name}-home`,
      `${viewport.name}-home-sources`,
      `${viewport.name}-home-files`,
      `${viewport.name}-workspace`,
      `${viewport.name}-workspace-inspector`
    ];

    if (viewport.mobile) {
      labels.push(`${viewport.name}-workspace-filters`);
    }

    return labels;
  });
}

function getUrlPathname(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

function isInternalDiagnosticRequest(url) {
  const pathname = getUrlPathname(url);

  if (!pathname || PUBLIC_DEV_SESSION_PATHS.has(pathname)) {
    return false;
  }

  return pathname.startsWith("/api/dev/") || pathname.startsWith("/api/runtime/");
}

function findPublicTextLeaks(text) {
  const lowerText = text.toLowerCase();

  return INTERNAL_PUBLIC_TERMS.filter((term) => lowerText.includes(term.toLowerCase()));
}

function assertNoPublicTextLeaks(label, text) {
  const leakedTerms = findPublicTextLeaks(text);

  if (leakedTerms.length) {
    throw new Error(`${label} leaked internal terms: ${leakedTerms.join(", ")}`);
  }
}

function assertNoPublicDiagnosticRequests(label, requests) {
  const devDiagnosticRequests = requests.filter(isInternalDiagnosticRequest);

  if (devDiagnosticRequests.length) {
    throw new Error(`${label} fetched developer diagnostics: ${devDiagnosticRequests.join(", ")}`);
  }

  return devDiagnosticRequests;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Unable to resolve a free localhost port.")));
        return;
      }

      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

function findChromeExecutable() {
  const configured = process.env.CHROME_PATH;

  if (configured && existsSync(configured)) {
    return configured;
  }

  const candidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
  ];

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

async function waitForJson(url, timeoutMs = 8000) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);

      if (response.ok) {
        return await response.json();
      }
    } catch (error) {
      lastError = error;
    }

    await sleep(120);
  }

  throw new Error(
    `Timed out waiting for ${url}${lastError instanceof Error ? `: ${lastError.message}` : ""}`
  );
}

class CdpClient {
  constructor(url) {
    this.url = url;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.socket = new WebSocket(this.url);
      this.socket.addEventListener("open", () => resolve());
      this.socket.addEventListener("error", () => reject(new Error("Unable to connect to Chrome DevTools.")), {
        once: true
      });
      this.socket.addEventListener("message", (event) => {
        const message = JSON.parse(event.data.toString());

        if (message.id && this.pending.has(message.id)) {
          const pending = this.pending.get(message.id);
          this.pending.delete(message.id);

          if (message.error) {
            pending.reject(new Error(`${pending.method} failed: ${message.error.message ?? "Chrome DevTools command failed."}`));
          } else {
            pending.resolve(message.result);
          }

          return;
        }

        const callbacks = this.listeners.get(message.method);
        if (callbacks) {
          for (const callback of callbacks) {
            callback(message.params);
          }
        }
      });
    });
  }

  send(method, params = {}) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Chrome DevTools socket is not open.");
    }

    const id = ++this.id;
    const payload = JSON.stringify({ id, method, params });

    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      this.socket.send(payload);
    });
  }

  on(method, callback) {
    const callbacks = this.listeners.get(method) ?? [];
    callbacks.push(callback);
    this.listeners.set(method, callbacks);
  }

  close() {
    this.socket?.close();
  }
}

async function createPageClient(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {
    method: "PUT"
  });

  if (!response.ok) {
    throw new Error(`Unable to create Chrome target: ${response.status}`);
  }

  const target = await response.json();
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();
  await client.send("Page.enable");
  await client.send("Runtime.enable");
  await client.send("Network.enable");
  await client.send("Log.enable");
  return client;
}

async function waitForLoad(client) {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, 5000);
    client.on("Page.loadEventFired", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function evaluate(client, expression, returnByValue = true) {
  let result;

  try {
    result = await client.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue
    });
  } catch (error) {
    throw new Error(
      `Browser evaluation failed for ${expression.slice(0, 140)}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text ?? "Browser evaluation failed.");
  }

  return result.result?.value;
}

async function waitForCondition(client, expression, label, timeoutMs = 10000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const matched = await evaluate(client, expression);

    if (matched) {
      return;
    }

    await sleep(120);
  }

  throw new Error(`Timed out waiting for ${label}.`);
}

async function assertPracticalA11y(client, label) {
  const issues = await evaluate(
    client,
    `(() => {
      const visible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        if (element.closest('[aria-hidden="true"], [inert]')) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== 'none' &&
          style.visibility !== 'hidden'
        );
      };
      const textById = (id) => {
        if (!id) return '';
        return id
          .split(/\\s+/)
          .map((part) => document.getElementById(part)?.textContent?.trim() ?? '')
          .filter(Boolean)
          .join(' ');
      };
      const controlName = (element) => {
        const ariaLabel = element.getAttribute('aria-label')?.trim();
        if (ariaLabel) return ariaLabel;
        const ariaLabelledBy = textById(element.getAttribute('aria-labelledby'));
        if (ariaLabelledBy) return ariaLabelledBy;
        const title = element.getAttribute('title')?.trim();
        if (title) return title;
        const text = element.textContent?.replace(/\\s+/g, ' ').trim();
        if (text) return text;
        const value = element.getAttribute('value')?.trim();
        if (value) return value;
        const placeholder = element.getAttribute('placeholder')?.trim();
        if (placeholder) return placeholder;
        return '';
      };
      const labelForField = (element) => {
        const directName = controlName(element);
        if (directName) return directName;
        const id = element.getAttribute('id');
        if (id && typeof CSS !== 'undefined' && CSS.escape) {
          const explicitLabel = document.querySelector('label[for="' + CSS.escape(id) + '"]');
          if (explicitLabel?.textContent?.trim()) return explicitLabel.textContent.trim();
        }
        const wrappingLabel = element.closest('label');
        return wrappingLabel?.textContent?.trim() ?? '';
      };
      const issues = [];
      for (const element of document.querySelectorAll('button, a[href], [role="button"], [role="link"]')) {
        if (visible(element) && !controlName(element)) {
          issues.push({
            type: 'unnamed-action',
            tag: element.tagName.toLowerCase(),
            className: element.className?.toString() ?? ''
          });
        }
      }
      for (const element of document.querySelectorAll('input:not([type="hidden"]), textarea, select')) {
        if (visible(element) && !labelForField(element)) {
          issues.push({
            type: 'unnamed-field',
            tag: element.tagName.toLowerCase(),
            typeAttr: element.getAttribute('type') ?? '',
            className: element.className?.toString() ?? ''
          });
        }
      }
      return issues.slice(0, 12);
    })()`
  );

  if (issues.length) {
    throw new Error(`${label} has unlabeled accessible controls: ${JSON.stringify(issues)}`);
  }
}

async function assertNoPublicDevEntry(client, label) {
  const metrics = await evaluate(
    client,
    `(() => {
      const button = document.querySelector('.dev-entry-button');
      if (!button) return { exists: false };
      const rect = button.getBoundingClientRect();
      const style = getComputedStyle(button);
      const hitX = Math.min(Math.max(rect.left + rect.width / 2, 1), innerWidth - 1);
      const hitY = Math.min(Math.max(rect.top + rect.height / 2, 1), innerHeight - 1);
      const hitElement = document.elementFromPoint(hitX, hitY);
      return {
        exists: true,
        visible: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none',
        reachable: Boolean(hitElement && (button === hitElement || button.contains(hitElement))),
        accessibleName: button.getAttribute('aria-label') ?? button.textContent?.trim() ?? '',
        text: button.textContent?.trim() ?? '',
        width: rect.width,
        height: rect.height,
        area: rect.width * rect.height,
        rightGap: innerWidth - rect.right,
        bottomGap: innerHeight - rect.bottom,
        opacity: Number.parseFloat(style.opacity || '1'),
        position: style.position,
        zIndex: style.zIndex
      };
    })()`
  );

  if (metrics.exists && metrics.visible) {
    throw new Error(`${label} rendered a public Dev entry: ${JSON.stringify(metrics)}`);
  }
}

async function clickByRect(client, selector, label) {
  const rect = await evaluate(
    client,
    `(() => {
      const candidates = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
      const element = candidates.find((candidate) => {
        const candidateRect = candidate.getBoundingClientRect();
        const centerX = candidateRect.left + candidateRect.width / 2;
        const centerY = candidateRect.top + candidateRect.height / 2;

        return (
          candidateRect.width >= 48 &&
          candidateRect.height >= 32 &&
          centerX >= 0 &&
          centerX <= innerWidth &&
          centerY >= 0 &&
          centerY <= innerHeight &&
          (() => {
            const hitElement = document.elementFromPoint(centerX, centerY);
            return Boolean(hitElement && (candidate === hitElement || candidate.contains(hitElement)));
          })()
        );
      }) ?? candidates[0];
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2
      };
    })()`
  );

  if (!rect) {
    throw new Error(`Unable to find ${label}.`);
  }

  await client.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: rect.x,
    y: rect.y
  });
  await client.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: rect.x,
    y: rect.y,
    button: "left",
    clickCount: 1
  });
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: rect.x,
    y: rect.y,
    button: "left",
    clickCount: 1
  });
}

async function pressEscape(client) {
  await client.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27
  });
  await client.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27
  });
}

async function runHomeViewportCheck(client, baseUrl, viewport, screenshotRecorder) {
  const errors = [];
  const requests = [];

  client.on("Runtime.consoleAPICalled", (params) => {
    if (params.type === "error") {
      errors.push(`console: ${params.args?.map((arg) => arg.value ?? arg.description).join(" ")}`);
    }
  });
  client.on("Log.entryAdded", (params) => {
    if (params.entry?.level === "error") {
      const entryText = params.entry.text ?? "";
      const entryUrl = params.entry.url ?? "";

      if (entryUrl.endsWith("/favicon.ico") || entryText.includes("favicon.ico")) {
        return;
      }

      errors.push(`log: ${entryText}${entryUrl ? ` (${entryUrl})` : ""}`);
    }
  });
  client.on("Network.requestWillBeSent", (params) => {
    if (params.request?.url) {
      requests.push(params.request.url);
    }
  });

  await client.send("Emulation.setDeviceMetricsOverride", {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: viewport.mobile ? 2 : 1,
    mobile: viewport.mobile
  });

  const loadPromise = waitForLoad(client);
  await client.send("Page.navigate", {
    url: `${baseUrl}/`
  });
  await loadPromise;

  await waitForCondition(
    client,
    "Boolean(document.querySelector('.landing-shell--minimal') && document.querySelector('.composer--command'))",
    `${viewport.name} minimal public shell`
  );
  await evaluate(client, "window.scrollTo(0, 0)");
  await sleep(120);

  const bodyText = await evaluate(client, "document.body.innerText");
  assertNoPublicTextLeaks(`${viewport.name} public home`, bodyText);
  const devDiagnosticRequests = assertNoPublicDiagnosticRequests(`${viewport.name} public home`, requests);

  const shellMetrics = await evaluate(
    client,
    `(() => {
      const shell = document.querySelector('.landing-shell--minimal');
      const title = document.querySelector('#minimal-home-title');
      const prompt = document.querySelector('.composer-command__bar');
      const demo = document.querySelector('.minimal-home__demo-link');
      const legacyCards = document.querySelectorAll('.public-hero, .step-strip, .composer-card').length;
      if (!shell || !title || !prompt || !demo) return null;
      const shellStyle = getComputedStyle(shell);
      const promptRect = prompt.getBoundingClientRect();
      const titleRect = title.getBoundingClientRect();
      return {
        legacyCards,
        background: shellStyle.backgroundColor + ' ' + shellStyle.backgroundImage,
        promptWidth: promptRect.width,
        promptLeft: promptRect.left,
        promptRight: promptRect.right,
        titleTop: titleRect.top,
        titleWidth: titleRect.width,
        demoHref: demo.getAttribute('href')
      };
    })()`
  );

  if (!shellMetrics) {
    throw new Error(`${viewport.name} public home did not render the minimal shell.`);
  }

  if (shellMetrics.legacyCards) {
    throw new Error(`${viewport.name} public home still rendered legacy card sections.`);
  }

  if (shellMetrics.promptWidth < Math.min(320, viewport.width - 36)) {
    throw new Error(`${viewport.name} public prompt is too narrow to use comfortably.`);
  }

  if (
    shellMetrics.promptLeft < -1 ||
    shellMetrics.promptRight > viewport.width + 1 ||
    shellMetrics.titleTop < 72 ||
    shellMetrics.demoHref !== "/workspace/demo"
  ) {
    throw new Error(`${viewport.name} public home layout controls are outside the expected viewport.`);
  }

  await assertNoPublicDevEntry(client, `${viewport.name} public home`);
  await assertPracticalA11y(client, `${viewport.name} public home`);
  await saveScreenshot(client, screenshotRecorder, `${viewport.name}-home`);

  await clickByRect(client, ".composer-command__source-toggle", `${viewport.name} source tray toggle`);
  await waitForCondition(
    client,
    "Boolean(document.querySelector('.composer-command__source-menu'))",
    `${viewport.name} source menu open`
  );
  await clickByRect(client, ".composer-command__source-option--links", `${viewport.name} add link option`);
  await waitForCondition(
    client,
    "Boolean(document.querySelector('.composer-command__source-panel[data-state=\"open\"]'))",
    `${viewport.name} source tray open`
  );

  // The focus handoff happens after the tray entrance transition. Keep the
  // smoke path synchronized with review mode before checking activeElement.
  await sleep(220);
  await assertPracticalA11y(client, `${viewport.name} public home source tray`);
  await saveScreenshot(client, screenshotRecorder, `${viewport.name}-home-sources`);

  const focusMovedInsideTray = await evaluate(
    client,
    "Boolean(document.activeElement?.closest('.composer-command__source-panel'))"
  );

  if (!focusMovedInsideTray) {
    throw new Error(`${viewport.name} source tray did not move focus into the tray on open.`);
  }

  await pressEscape(client);
  await waitForCondition(
    client,
    "!document.querySelector('.composer-command__source-panel')",
    `${viewport.name} source tray Escape close`
  );

  const focusReturnedToToggle = await evaluate(
    client,
    "document.activeElement?.classList.contains('composer-command__source-toggle')"
  );

  if (!focusReturnedToToggle) {
    throw new Error(`${viewport.name} source tray did not return focus to plus after Escape close.`);
  }

  await clickByRect(client, ".composer-command__source-toggle", `${viewport.name} file source menu toggle`);
  await waitForCondition(
    client,
    "Boolean(document.querySelector('.composer-command__source-menu'))",
    `${viewport.name} file source menu open`
  );
  await clickByRect(client, ".composer-command__source-option--files", `${viewport.name} add files option`);
  await waitForCondition(
    client,
    "Boolean(document.querySelector('.composer-command__source-panel[data-state=\"open\"]'))",
    `${viewport.name} file source tray open`
  );
  await waitForCondition(
    client,
    "Boolean(document.activeElement?.closest('.composer-command__file-section'))",
    `${viewport.name} file section focus`
  );

  await sleep(220);
  await assertPracticalA11y(client, `${viewport.name} public home file tray`);
  await saveScreenshot(client, screenshotRecorder, `${viewport.name}-home-files`);

  const fileSectionEmphasized = await evaluate(
    client,
    "Boolean(document.querySelector('.composer-command__file-section--emphasized'))"
  );

  if (!fileSectionEmphasized) {
    throw new Error(`${viewport.name} Add files option did not emphasize the file source section.`);
  }

  await evaluate(client, "document.querySelector('.composer-command__panel-close')?.click()");
  await waitForCondition(
    client,
    "!document.querySelector('.composer-command__source-panel')",
    `${viewport.name} file source tray close`
  );

  const focusReturnedToAttach = await evaluate(
    client,
    "document.activeElement?.classList.contains('composer-command__source-toggle')"
  );

  if (!focusReturnedToAttach) {
    throw new Error(`${viewport.name} source tray did not return focus to plus after file close.`);
  }

  if (errors.length) {
    throw new Error(`${viewport.name} public home browser errors: ${errors.join(" | ")}`);
  }

  return {
    viewport: viewport.name,
    requests: requests.length,
    diagnosticRequests: devDiagnosticRequests.length,
    screenshots: screenshotRecorder.enabled
      ? screenshotRecorder.paths.filter((screenshotPath) =>
          screenshotPath.includes(`${viewport.name}-home`)
        )
      : []
  };
}

async function runViewportCheck(client, baseUrl, viewport, screenshotRecorder) {
  const errors = [];
  const requests = [];

  client.on("Runtime.consoleAPICalled", (params) => {
    if (params.type === "error") {
      errors.push(`console: ${params.args?.map((arg) => arg.value ?? arg.description).join(" ")}`);
    }
  });
  client.on("Log.entryAdded", (params) => {
    if (params.entry?.level === "error") {
      const entryText = params.entry.text ?? "";
      const entryUrl = params.entry.url ?? "";

      if (entryUrl.endsWith("/favicon.ico") || entryText.includes("favicon.ico")) {
        return;
      }

      errors.push(`log: ${entryText}${entryUrl ? ` (${entryUrl})` : ""}`);
    }
  });
  client.on("Network.requestWillBeSent", (params) => {
    if (params.request?.url) {
      requests.push(params.request.url);
    }
  });

  await client.send("Emulation.setDeviceMetricsOverride", {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: viewport.mobile ? 2 : 1,
    mobile: viewport.mobile
  });

  const loadPromise = waitForLoad(client);
  await client.send("Page.navigate", {
    url: `${baseUrl}/workspace/demo`
  });
  await loadPromise;

  await waitForCondition(
    client,
    "Boolean(document.querySelector('.react-flow__node'))",
    `${viewport.name} graph nodes`,
    30000
  );
  await evaluate(client, "window.scrollTo(0, 0)");
  await sleep(1400);

  const inspectorAlreadyOpen = await evaluate(
    client,
    "Boolean(document.querySelector('.workspace-inspector-drawer--open'))"
  );

  if (inspectorAlreadyOpen) {
    await evaluate(client, "document.querySelector('[aria-label=\"Close map inspector\"]')?.click()");
    await waitForCondition(
      client,
      "!document.querySelector('.workspace-inspector-drawer--open')",
      `${viewport.name} default inspector closed`
    );
  }

  const bodyText = await evaluate(client, "document.body.innerText");
  assertNoPublicTextLeaks(`${viewport.name} public workspace`, bodyText);
  const devDiagnosticRequests = assertNoPublicDiagnosticRequests(`${viewport.name} public workspace`, requests);

  if (!bodyText.includes("Curated demo") || !bodyText.includes("sample sources")) {
    throw new Error(`${viewport.name} public workspace did not clearly label the starter map as a curated demo.`);
  }

  await saveScreenshot(client, screenshotRecorder, `${viewport.name}-workspace`);

  const initialReadabilityMetrics = await evaluate(
    client,
    `(() => {
      const controls = Array.from(document.querySelectorAll('.workspace-command-bar, .status-banner, .workspace-floating-toolbar, .react-flow__controls'))
        .map((element) => element.getBoundingClientRect())
        .filter((rect) => rect.width > 0 && rect.height > 0);
      const visibleNodes = Array.from(document.querySelectorAll('.react-flow__node'))
        .map((node) => {
          const rect = node.getBoundingClientRect();
          const visibleWidth = Math.max(0, Math.min(rect.right, innerWidth) - Math.max(rect.left, 0));
          const visibleHeight = Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0));
          const visibleArea = visibleWidth * visibleHeight;
          const area = Math.max(1, rect.width * rect.height);
          const maxControlOverlapRatio = controls.reduce((maxOverlap, controlRect) => {
            const overlapWidth = Math.max(0, Math.min(rect.right, controlRect.right) - Math.max(rect.left, controlRect.left));
            const overlapHeight = Math.max(0, Math.min(rect.bottom, controlRect.bottom) - Math.max(rect.top, controlRect.top));
            return Math.max(maxOverlap, (overlapWidth * overlapHeight) / area);
          }, 0);
          const overlapThreshold = innerWidth <= 700 ? 0.16 : 0.08;
          return {
            id: node.getAttribute('data-id'),
            className: node.className,
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            top: Math.round(rect.top),
            bottom: Math.round(rect.bottom),
            visibleRatio: visibleArea / area,
            maxControlOverlapRatio,
            overlapsControl: maxControlOverlapRatio > overlapThreshold
          };
        })
        .filter((node) => node.visibleRatio >= 0.42);
      const minimumReadableWidth = innerWidth <= 700 ? 92 : 120;
      const minimumReadableHeight = innerWidth <= 700 ? 40 : 48;
      const readableNodes = visibleNodes.filter(
        (node) => node.width >= minimumReadableWidth && node.height >= minimumReadableHeight
      );
      const overlappingNodes = visibleNodes.filter((node) => node.overlapsControl);
      const visibleLabels = Array.from(document.querySelectorAll('.react-flow__edge-text'))
        .filter((label) => {
          const rect = label.getBoundingClientRect();
          const opacity = Number.parseFloat(getComputedStyle(label).opacity || '0');
          return opacity > 0.24 && rect.right > 0 && rect.left < innerWidth && rect.bottom > 0 && rect.top < innerHeight;
        });
      return {
        visibleNodeCount: visibleNodes.length,
        readableNodeCount: readableNodes.length,
        overlappingNodes,
        visibleEdgeLabelCount: visibleLabels.length
      };
    })()`
  );

  if (!initialReadabilityMetrics || initialReadabilityMetrics.visibleNodeCount < 2) {
    throw new Error(
      `${viewport.name} public workspace did not open on a useful graph cluster: ${JSON.stringify(initialReadabilityMetrics)}`
    );
  }

  if (initialReadabilityMetrics.readableNodeCount < Math.min(2, initialReadabilityMetrics.visibleNodeCount)) {
    throw new Error(
      `${viewport.name} public workspace opened with unreadable graph nodes: ${JSON.stringify(initialReadabilityMetrics)}`
    );
  }

  if (initialReadabilityMetrics.overlappingNodes.length) {
    throw new Error(
      `${viewport.name} public workspace opened with graph nodes under floating controls: ${JSON.stringify(initialReadabilityMetrics.overlappingNodes)}`
    );
  }

  if (initialReadabilityMetrics.visibleEdgeLabelCount > (viewport.mobile ? 0 : 2)) {
    throw new Error(
      `${viewport.name} public workspace opened with noisy edge labels: ${initialReadabilityMetrics.visibleEdgeLabelCount}`
    );
  }

  await assertNoPublicDevEntry(client, `${viewport.name} public workspace`);
  await assertPracticalA11y(client, `${viewport.name} public workspace`);

  await clickByRect(client, ".graph-node:not(.graph-node--question)", `${viewport.name} graph node`);
  await waitForCondition(
    client,
    "Boolean(document.querySelector('.workspace-inspector-drawer--open') && document.querySelector('[aria-label=\"Close map inspector\"]'))",
    `${viewport.name} inspector open`
  );

  const inspectorMetrics = await evaluate(
    client,
    `(() => {
      const inspector = document.querySelector('.workspace-inspector-drawer');
      if (!inspector) return null;
      return {
        text: inspector.innerText,
        sections: Array.from(
          inspector.querySelectorAll('.node-inspector > [aria-label]')
        ).map((section) => section.getAttribute('aria-label')),
        selectedNodeTitle: inspector.querySelector('[aria-label="Selected node details"] h2')?.textContent?.trim() ?? "",
        summaryTitle: inspector.querySelector('[aria-label="Summary"] h2')?.textContent?.trim() ?? "",
        evidenceTitle: inspector.querySelector('[aria-label="Evidence"] h2')?.textContent?.trim() ?? "",
        sourcesTitle: inspector.querySelector('[aria-label="Sources"] h2')?.textContent?.trim() ?? ""
      };
    })()`
  );

  const expectedInspectorSections = [
    "Selected node details",
    "Summary",
    "Evidence",
    "Sources",
    "Related nodes",
    "Open gaps"
  ];

  if (!inspectorMetrics) {
    throw new Error(`${viewport.name} inspector did not expose hierarchy metrics.`);
  }

  if (
    expectedInspectorSections.some(
      (section, index) => inspectorMetrics.sections[index] !== section
    )
  ) {
    throw new Error(
      `${viewport.name} inspector hierarchy changed unexpectedly: ${JSON.stringify(inspectorMetrics.sections)}`
    );
  }

  if (
    !inspectorMetrics.selectedNodeTitle ||
    !inspectorMetrics.summaryTitle ||
    !inspectorMetrics.evidenceTitle ||
    !inspectorMetrics.sourcesTitle
  ) {
    throw new Error(`${viewport.name} inspector is missing a primary selected-node/provenance heading.`);
  }

  if (
    !inspectorMetrics.text.toLowerCase().includes("where this came from") ||
    !inspectorMetrics.text.toLowerCase().includes("sample starter")
  ) {
    throw new Error(
      `${viewport.name} inspector did not expose starter provenance clearly enough for the selected node: ${JSON.stringify(inspectorMetrics.text.slice(0, 1000))}`
    );
  }

  const leakedInspectorTerms = INTERNAL_PUBLIC_TERMS.filter((term) =>
    inspectorMetrics.text.toLowerCase().includes(term.toLowerCase())
  );

  if (leakedInspectorTerms.length) {
    throw new Error(
      `${viewport.name} public inspector leaked internal terms: ${leakedInspectorTerms.join(", ")}`
    );
  }

  await assertPracticalA11y(client, `${viewport.name} public inspector`);

  if (viewport.mobile) {
    await waitForCondition(
      client,
      "Boolean(Array.from(document.querySelectorAll('.react-flow__node')).find((node) => node.querySelector('.graph-node--selected')) && document.querySelector('.workspace-inspector-drawer--open'))",
      `${viewport.name} selected graph node state`
    );
  } else {
    await waitForCondition(
      client,
      `(() => {
        const node = Array.from(document.querySelectorAll('.react-flow__node')).find((candidate) => candidate.querySelector('.graph-node--selected')) || document.querySelector('.react-flow__node');
        if (!node) return false;
        const rect = node.getBoundingClientRect();
        return rect.width >= 120 && rect.height >= 48 && rect.bottom > 0 && rect.right > 0 && rect.left < innerWidth && rect.top < innerHeight;
      })()`,
      `${viewport.name} selected graph node readability`
    );
  }

  const overlapMetrics = await evaluate(
    client,
    `(() => {
      const node = Array.from(document.querySelectorAll('.react-flow__node')).find((candidate) => candidate.querySelector('.graph-node--selected')) || document.querySelector('.react-flow__node');
      const controls = Array.from(document.querySelectorAll('.workspace-top-layer, .workspace-floating-toolbar, .react-flow__controls-button'));
      if (!node || controls.length < 2) return null;
      const nodeRect = node.getBoundingClientRect();
      const overlaps = (left, right) =>
        left.left < right.right &&
        left.right > right.left &&
        left.top < right.bottom &&
        left.bottom > right.top;
      const overlapRects = controls
        .map((control) => control.getBoundingClientRect())
        .filter((rect) => rect.width > 0 && rect.height > 0);
      const nodeArea = Math.max(1, nodeRect.width * nodeRect.height);
      const maxControlOverlapRatio = overlapRects.reduce((maxOverlap, rect) => {
        const overlapWidth = Math.max(0, Math.min(nodeRect.right, rect.right) - Math.max(nodeRect.left, rect.left));
        const overlapHeight = Math.max(0, Math.min(nodeRect.bottom, rect.bottom) - Math.max(nodeRect.top, rect.top));
        return Math.max(maxOverlap, (overlapWidth * overlapHeight) / nodeArea);
      }, 0);
      const overlappingControls = overlapRects.filter((rect) => overlaps(nodeRect, rect));
      return {
        overlapsControls: overlappingControls.length && maxControlOverlapRatio > 0.08,
        maxControlOverlapRatio,
        nodeTop: Math.round(nodeRect.top),
        nodeBottom: Math.round(nodeRect.bottom),
        controls: overlapRects.map((rect) => ({
          top: Math.round(rect.top),
          bottom: Math.round(rect.bottom),
          left: Math.round(rect.left),
          right: Math.round(rect.right)
        }))
      };
    })()`
  );

  if (!overlapMetrics || overlapMetrics.overlapsControls) {
    throw new Error(
      `${viewport.name} selected graph node overlaps floating controls: ${JSON.stringify(overlapMetrics)}`
    );
  }

  // React Flow recenters the selected node asynchronously even when the QA run
  // is not saving screenshots. Measure only after the same stabilization
  // window in both smoke and review modes so the fast path cannot observe the
  // outgoing transform and report an impossible off-screen canvas center.
  await sleep(760);

  if (!viewport.mobile) {
    const selectedCenterMetrics = await evaluate(
      client,
      `(() => {
        const node = Array.from(document.querySelectorAll('.react-flow__node')).find((candidate) => candidate.querySelector('.graph-node--selected'));
        const canvas = document.querySelector('.canvas-shell');
        if (!node || !canvas) return null;
        const nodeRect = node.getBoundingClientRect();
        const canvasRect = canvas.getBoundingClientRect();
        const nodeCenterX = nodeRect.left + nodeRect.width / 2;
        const canvasCenterX = canvasRect.left + canvasRect.width / 2;
        return {
          deltaX: Math.round(nodeCenterX - canvasCenterX),
          allowedDeltaX: Math.round(canvasRect.width * 0.18),
          nodeCenterX: Math.round(nodeCenterX),
          canvasCenterX: Math.round(canvasCenterX),
          canvasWidth: Math.round(canvasRect.width)
        };
      })()`
    );

    if (!selectedCenterMetrics || Math.abs(selectedCenterMetrics.deltaX) > selectedCenterMetrics.allowedDeltaX) {
      throw new Error(
        `${viewport.name} selected graph node is not centered in the graph region: ${JSON.stringify(selectedCenterMetrics)}`
      );
    }
  }

  await saveScreenshot(client, screenshotRecorder, `${viewport.name}-workspace-inspector`);

  await evaluate(client, "document.querySelector('[aria-label=\"Close map inspector\"]')?.click()");
  await waitForCondition(
    client,
    "!document.querySelector('.workspace-inspector-drawer--open')",
    `${viewport.name} inspector close`
  );

  if (viewport.mobile) {
    await evaluate(
      client,
      `Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.trim() === 'Filters')?.click()`
    );
    await waitForCondition(
      client,
      "Boolean(document.querySelector('#workspace-mobile-filter-sheet'))",
      "mobile filter sheet open"
    );
    await assertPracticalA11y(client, `${viewport.name} mobile filter sheet`);
    await saveScreenshot(client, screenshotRecorder, `${viewport.name}-workspace-filters`);
    await evaluate(
      client,
      `document.querySelector('#workspace-mobile-filter-sheet button')?.click()`
    );
    await waitForCondition(
      client,
      "!document.querySelector('#workspace-mobile-filter-sheet')",
      "mobile filter sheet close"
    );
  }

  if (errors.length) {
    throw new Error(`${viewport.name} browser errors: ${errors.join(" | ")}`);
  }

  return {
    viewport: viewport.name,
    requests: requests.length,
    diagnosticRequests: devDiagnosticRequests.length,
    screenshots: screenshotRecorder.enabled
      ? screenshotRecorder.paths.filter((screenshotPath) =>
          screenshotPath.includes(`${viewport.name}-workspace`)
        )
      : []
  };
}

async function runApiChecks(baseUrl) {
  const graphResponse = await fetch(`${baseUrl}/api/workspaces/demo/graph`);

  if (!graphResponse.ok) {
    throw new Error(`Public graph API failed: ${graphResponse.status}`);
  }

  const graphPayload = await graphResponse.json();
  if (graphPayload.evidence !== null || graphPayload.claimInventory !== null) {
    throw new Error("Public graph API exposed raw evidence or claim inventory artifacts.");
  }

  if (!graphPayload.starterMode) {
    throw new Error("Public demo graph API is expected to identify the demo as starter mode.");
  }

  const ungroundedStarterNodes = graphPayload.graph.nodes.filter(
    (node) =>
      node.kind !== "question" &&
      (!Array.isArray(node.sourceIds) ||
        !node.sourceIds.length ||
        !Array.isArray(node.snippetIds) ||
        !node.snippetIds.length)
  );

  if (ungroundedStarterNodes.length) {
    throw new Error(
      `Public demo starter graph has nodes without visible provenance: ${ungroundedStarterNodes
        .map((node) => node.id)
        .join(", ")}`
    );
  }

  const nonStarterSnippets = graphPayload.snippets.filter(
    (snippet) => snippet.origin !== "starter_curated"
  );

  if (nonStarterSnippets.length) {
    throw new Error("Public demo graph should expose only starter-curated snippets.");
  }

  const forbiddenPublicKeys = new Set([
    "backendMode",
    "claimInventory",
    "cleanupDetails",
    "cleanupLog",
    "debug",
    "diagnostics",
    "evidencePack",
    "hostedHealth",
    "modelName",
    "providerFailure",
    "rawEvidence",
    "runtimeDiagnostics",
    "runtimeReadiness",
    "stageTimings"
  ]);
  const foundForbiddenKeys = [];
  const visit = (value, pathParts = []) => {
    if (!value || typeof value !== "object") {
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, [...pathParts, String(index)]));
      return;
    }

    for (const [key, nestedValue] of Object.entries(value)) {
      if (forbiddenPublicKeys.has(key) && nestedValue !== null && nestedValue !== undefined) {
        foundForbiddenKeys.push([...pathParts, key].join("."));
      }

      visit(nestedValue, [...pathParts, key]);
    }
  };

  visit(graphPayload);

  if (foundForbiddenKeys.length) {
    throw new Error(`Public graph API exposed developer-only fields: ${foundForbiddenKeys.join(", ")}`);
  }

  const devResponse = await fetch(`${baseUrl}/api/dev/workspaces/demo/graph`);
  if (devResponse.status !== 401) {
    throw new Error(`Unauthenticated developer graph API returned ${devResponse.status}, expected 401.`);
  }

  return {
    publicGraphStatus: graphResponse.status,
    developerGraphStatus: devResponse.status,
    forbiddenPublicFields: foundForbiddenKeys.length
  };
}

function writeReviewArtifacts(recorder, { baseUrl, viewportResults, apiChecks }) {
  if (!recorder.enabled) {
    return null;
  }

  const expectedLabels = expectedScreenshotLabels();
  const savedLabels = new Set(recorder.shots.map((shot) => shot.label));
  const missingLabels = expectedLabels.filter((label) => !savedLabels.has(label));

  if (missingLabels.length) {
    throw new Error(`Screenshot review folder is missing canonical captures: ${missingLabels.join(", ")}`);
  }

  const manifestPath = path.join(recorder.dir, "manifest.json");
  const reviewPath = path.join(recorder.dir, "review.md");
  const manifest = {
    generatedAt: new Date().toISOString(),
    baseUrl,
    mode: recorder.reviewMode ? "review" : "screenshots",
    expectedLabels,
    screenshots: recorder.shots.map((shot) => ({
      label: shot.label,
      filename: shot.filename
    })),
    assertions: {
      publicDiagnosticLeakage: "checked rendered text, public page requests, public graph API fields, and unauthenticated developer API protection",
      devEntry: "checked public pages do not render the opt-in local developer entry by default",
      accessibility: "checked visible buttons, links, and fields for practical accessible names"
    },
    apiChecks,
    viewports: viewportResults
  };

  const rows = recorder.shots
    .map((shot) => `| ${shot.label} | ${shot.filename} |`)
    .join("\n");
  const reviewMarkdown = `# ClaimGraph Workspace Visual QA Review

Generated: ${manifest.generatedAt}
Base URL: ${baseUrl}

Run this check again with:

\`\`\`powershell
npm.cmd run qa:workspace:review
\`\`\`

## What This Review Checks

- Public homepage and workspace screenshots at desktop, tablet, and mobile widths.
- Source menu, link-source tray, file-source tray, inspector drawer/sheet, and mobile filter sheet states.
- Public pages do not render or fetch internal diagnostics.
- Public graph JSON does not expose raw evidence pack, claim inventory, runtime, backend, model, hosted-health, cleanup, or stage-timing fields.
- The opt-in Dev entry stays hidden on public pages by default.
- Visible buttons, links, and fields expose practical accessible names.

## Screenshots

| State | File |
| --- | --- |
${rows}
`;

  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(reviewPath, reviewMarkdown);

  return {
    manifestPath,
    reviewPath
  };
}

async function assertServerReady(baseUrl) {
  try {
    const response = await fetch(`${baseUrl}/api/workspaces/demo/graph`);
    if (!response.ok) {
      throw new Error(`status ${response.status}`);
    }
  } catch (error) {
    throw new Error(
      `ClaimGraph server is not reachable at ${baseUrl}. Start it first with npm.cmd run dev or npm.cmd run start. ${error instanceof Error ? error.message : ""}`
    );
  }
}

async function stopBrowserProcess(processHandle) {
  if (processHandle.exitCode !== null || processHandle.signalCode !== null) {
    return;
  }

  const closed = new Promise((resolve) => {
    processHandle.once("exit", resolve);
  });

  processHandle.kill();
  await Promise.race([closed, sleep(3000)]);
}

async function removeProfileDir(profileDir) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(profileDir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 4) {
        throw error;
      }

      await sleep(250);
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const baseUrl = options.baseUrl;
  const screenshotRecorder = createScreenshotRecorder(options);
  const chromePath = findChromeExecutable();

  if (!chromePath) {
    throw new Error("Chrome or Edge was not found. Set CHROME_PATH to run the workspace browser QA script.");
  }

  await assertServerReady(baseUrl);

  const debuggingPort = await getFreePort();
  const profileDir = mkdtempSync(path.join(tmpdir(), "claimgraph-workspace-qa-"));
  const chrome = spawn(
    chromePath,
    [
      "--headless=new",
      `--remote-debugging-port=${debuggingPort}`,
      `--user-data-dir=${profileDir}`,
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank"
    ],
    {
      stdio: "ignore"
    }
  );

  try {
    await waitForJson(`http://127.0.0.1:${debuggingPort}/json/version`);
    const client = await createPageClient(debuggingPort);

    try {
      const viewportResults = [];
      for (const viewport of VIEWPORTS) {
        viewportResults.push({
          publicHome: await runHomeViewportCheck(client, baseUrl, viewport, screenshotRecorder),
          workspace: await runViewportCheck(client, baseUrl, viewport, screenshotRecorder)
        });
      }

      const apiChecks = await runApiChecks(baseUrl);
      const reviewArtifacts = writeReviewArtifacts(screenshotRecorder, {
        baseUrl,
        viewportResults,
        apiChecks
      });

      console.log(
        JSON.stringify(
          {
            ok: true,
            baseUrl,
            screenshotDir: screenshotRecorder.dir,
            reviewArtifacts,
            screenshotCount: screenshotRecorder.paths.length,
            viewports: viewportResults
          },
          null,
          2
        )
      );
    } finally {
      client.close();
    }
  } finally {
    await stopBrowserProcess(chrome);
    await removeProfileDir(profileDir);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
