// src/viewer/server.ts
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import path2 from "path";
import fs2 from "fs";
import { fileURLToPath } from "url";

// src/db.ts
import path from "node:path";
import fs from "node:fs";
var DB_DIR = path.join(process.cwd(), ".devtools");
var DB_PATH = path.join(DB_DIR, "generations.json");
var DEVTOOLS_PORT = process.env.AI_SDK_DEVTOOLS_PORT ? parseInt(process.env.AI_SDK_DEVTOOLS_PORT) : 4983;
var notifyServer = (event) => {
  notifyServerAsync(event);
};
var notifyServerAsync = async (event) => {
  try {
    await fetch(`http://localhost:${DEVTOOLS_PORT}/api/notify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event, timestamp: Date.now() })
    });
  } catch {
  }
};
var ensureGitignore = () => {
  const gitignorePath = path.join(process.cwd(), ".gitignore");
  if (!fs.existsSync(gitignorePath)) {
    return;
  }
  const content = fs.readFileSync(gitignorePath, "utf-8");
  const lines = content.split("\n");
  const alreadyIgnored = lines.some(
    (line) => line.trim() === ".devtools" || line.trim() === ".devtools/"
  );
  if (!alreadyIgnored) {
    const newContent = content.endsWith("\n") ? `${content}.devtools
` : `${content}
.devtools
`;
    fs.writeFileSync(gitignorePath, newContent);
  }
};
var readDb = () => {
  try {
    if (fs.existsSync(DB_PATH)) {
      const content = fs.readFileSync(DB_PATH, "utf-8");
      return JSON.parse(content);
    }
  } catch {
  }
  return { runs: [], steps: [] };
};
var writeDb = (db) => {
  const isFirstRun = !fs.existsSync(DB_DIR);
  if (isFirstRun) {
    fs.mkdirSync(DB_DIR, { recursive: true });
    ensureGitignore();
  }
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
};
var dbCache = null;
var getDb = () => {
  if (!dbCache) {
    dbCache = readDb();
  }
  return dbCache;
};
var saveDb = (db) => {
  dbCache = db;
  writeDb(db);
};
var reloadDb = async () => {
  dbCache = readDb();
};
var getRuns = async () => {
  const db = getDb();
  return [...db.runs].sort(
    (a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime()
  );
};
var getStepsForRun = async (runId) => {
  const db = getDb();
  return db.steps.filter((s) => s.run_id === runId).sort((a, b) => a.step_number - b.step_number);
};
var getRunWithSteps = async (runId) => {
  const db = getDb();
  const run = db.runs.find((r) => r.id === runId);
  if (!run) return null;
  const steps = await getStepsForRun(runId);
  return { run, steps };
};
var clearDatabase = async () => {
  const db = { runs: [], steps: [] };
  saveDb(db);
  notifyServer("clear");
};

// src/viewer/server.ts
var sseClients = /* @__PURE__ */ new Set();
var broadcastToClients = (event, data) => {
  const message = `event: ${event}
data: ${JSON.stringify(data)}

`;
  for (const client of sseClients) {
    try {
      client.controller.enqueue(message);
    } catch {
      sseClients.delete(client);
    }
  }
};
var __dirname = path2.dirname(fileURLToPath(import.meta.url));
var devEnv = process.env.AI_SDK_DEVTOOLS_DEV;
var isDevMode = devEnv !== void 0 && devEnv !== "false" && devEnv !== "0";
var projectRoot = path2.resolve(__dirname, "../..");
var clientDir = path2.join(projectRoot, "dist/client");
var app = new Hono();
app.use("/*", cors());
app.get("/api/runs", async (c) => {
  const runs = await getRuns();
  const runsWithMeta = await Promise.all(
    runs.map(async (run) => {
      const steps = await getStepsForRun(run.id);
      let firstMessage = "No user message";
      let hasError = false;
      let isInProgress = false;
      const firstStep = steps[0];
      if (firstStep) {
        try {
          const input = JSON.parse(firstStep.input);
          const userMsg = input?.prompt?.findLast(
            (m) => m.role === "user"
          );
          if (userMsg) {
            const content = typeof userMsg.content === "string" ? userMsg.content : userMsg.content?.[0]?.text || "";
            firstMessage = content.slice(0, 60) + (content.length > 60 ? "..." : "");
          }
        } catch {
        }
        hasError = steps.some((s) => s.error);
        isInProgress = steps.some((s) => s.duration_ms === null && !s.error);
      }
      return {
        ...run,
        stepCount: steps.length,
        firstMessage,
        hasError,
        isInProgress,
        type: firstStep?.type
      };
    })
  );
  return c.json(runsWithMeta);
});
app.get("/api/runs/:id", async (c) => {
  const data = await getRunWithSteps(c.req.param("id"));
  if (!data) {
    return c.json({ error: "Run not found" }, 404);
  }
  const isInProgress = data.steps.some((s) => s.duration_ms === null && !s.error);
  return c.json({
    run: { ...data.run, isInProgress },
    steps: data.steps
  });
});
app.post("/api/clear", async (c) => {
  await clearDatabase();
  return c.json({ success: true });
});
app.get("/api/events", (c) => {
  return streamSSE(c, async (stream) => {
    const clientId = crypto.randomUUID();
    const client = {
      id: clientId,
      controller: null
    };
    await stream.writeSSE({
      event: "connected",
      data: JSON.stringify({ clientId })
    });
    const originalWrite = stream.writeSSE.bind(stream);
    client.controller = {
      enqueue: (message) => {
        const lines = message.split("\n");
        let event = "message";
        let data = "";
        for (const line of lines) {
          if (line.startsWith("event: ")) {
            event = line.slice(7);
          } else if (line.startsWith("data: ")) {
            data = line.slice(6);
          }
        }
        originalWrite({ event, data }).catch(() => {
        });
      }
    };
    sseClients.add(client);
    const heartbeat = setInterval(async () => {
      try {
        await stream.writeSSE({
          event: "heartbeat",
          data: JSON.stringify({ time: Date.now() })
        });
      } catch {
        clearInterval(heartbeat);
      }
    }, 3e4);
    try {
      while (true) {
        await stream.sleep(1e3);
      }
    } finally {
      clearInterval(heartbeat);
      sseClients.delete(client);
    }
  });
});
app.post("/api/notify", async (c) => {
  const body = await c.req.json();
  await reloadDb();
  broadcastToClients("update", body);
  return c.json({ success: true });
});
app.use(
  "/assets/*",
  serveStatic({
    root: clientDir.replace(/\/+$/, "")
  })
);
app.get("*", async (c) => {
  if (isDevMode) {
    return c.html(`
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="UTF-8">
          <title>AI SDK DevTools</title>
          <style>
            body { font-family: system-ui, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #0a0a0a; color: #fafafa; }
            .container { text-align: center; }
            a { color: #3b82f6; text-decoration: none; font-size: 1.25rem; }
            a:hover { text-decoration: underline; }
            p { color: #737373; margin-top: 1rem; }
          </style>
        </head>
        <body>
          <div class="container">
            <h2>Development Mode</h2>
            <a href="http://localhost:5173">Open DevTools UI \u2192</a>
            <p>This port (4983) only serves the API in dev mode.</p>
          </div>
        </body>
      </html>
    `);
  }
  const indexPath = path2.join(clientDir, "index.html");
  try {
    const html = fs2.readFileSync(indexPath, "utf-8");
    return c.html(html);
  } catch {
    return c.text("DevTools client not built. Run `pnpm build` first.", 500);
  }
});
var startViewer = (port = 4983) => {
  const server = serve(
    {
      fetch: app.fetch,
      port
    },
    () => {
      if (isDevMode) {
        console.log(`\u{1F50D} AI SDK DevTools API running on port ${port}`);
        console.log(`   Open http://localhost:5173 for the dev UI`);
      } else {
        console.log(`\u{1F50D} AI SDK DevTools running at http://localhost:${port}`);
      }
    }
  );
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`
\u274C Port ${port} is already in use.`);
      console.error(
        `
   This likely means AI SDK DevTools is already running.`
      );
      console.error(`   Open http://localhost:${port} in your browser.
`);
      console.error(`   To use a different port, set AI_SDK_DEVTOOLS_PORT:
`);
      console.error(`   AI_SDK_DEVTOOLS_PORT=4984 npx ai-sdk-devtools
`);
      process.exit(1);
    }
    throw err;
  });
};
var currentFile = fileURLToPath(import.meta.url);
var isDirectRun = process.argv[1] === currentFile || process.argv[1]?.endsWith("/server.ts") || process.argv[1]?.endsWith("/server.js");
if (isDirectRun) {
  const port = process.env.AI_SDK_DEVTOOLS_PORT ? parseInt(process.env.AI_SDK_DEVTOOLS_PORT) : 4983;
  startViewer(port);
}
export {
  startViewer
};
