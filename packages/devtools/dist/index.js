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
var createRun = async (id) => {
  const db = getDb();
  const started_at = (/* @__PURE__ */ new Date()).toISOString();
  const existing = db.runs.find((r) => r.id === id);
  if (existing) {
    return existing;
  }
  const run = { id, started_at };
  db.runs.push(run);
  saveDb(db);
  notifyServer("run");
  return run;
};
var createStep = async (step) => {
  const db = getDb();
  const newStep = {
    ...step,
    duration_ms: null,
    output: null,
    usage: null,
    error: null,
    raw_request: null,
    raw_response: null,
    raw_chunks: null
  };
  db.steps.push(newStep);
  saveDb(db);
  notifyServer("step");
};
var updateStepResult = async (stepId, result) => {
  const db = getDb();
  const step = db.steps.find((s) => s.id === stepId);
  if (step) {
    step.duration_ms = result.duration_ms;
    step.output = result.output;
    step.usage = result.usage;
    step.error = result.error;
    step.raw_request = result.raw_request ?? null;
    step.raw_response = result.raw_response ?? null;
    step.raw_chunks = result.raw_chunks ?? null;
    saveDb(db);
    notifyServer("step-update");
  }
};

// src/middleware.ts
var generateId = () => crypto.randomUUID();
var activeSteps = /* @__PURE__ */ new Map();
var signalHandlersRegistered = false;
var registerSignalHandlers = () => {
  if (signalHandlersRegistered) return;
  signalHandlersRegistered = true;
  const cleanup = async () => {
    if (activeSteps.size === 0) return;
    const promises = Array.from(activeSteps.entries()).map(
      async ([stepId, data]) => {
        const durationMs = Date.now() - data.startTime;
        await updateStepResult(stepId, {
          duration_ms: durationMs,
          output: JSON.stringify(data.collectedOutput),
          usage: null,
          error: "Request aborted",
          raw_request: data.request && typeof data.request === "object" && "body" in data.request ? JSON.stringify(data.request.body) : null,
          raw_response: JSON.stringify(data.fullStreamChunks),
          raw_chunks: JSON.stringify(data.rawChunks)
        });
      }
    );
    await Promise.all(promises);
    await notifyServerAsync("step-update");
  };
  process.on("SIGINT", () => {
    cleanup().then(() => process.exit(130));
  });
  process.on("SIGTERM", () => {
    cleanup().then(() => process.exit(143));
  });
};
var generateRunId = () => {
  const now = /* @__PURE__ */ new Date();
  const timestamp = now.toISOString().replace(/[-:T.Z]/g, "").slice(0, 17);
  const uniqueId = crypto.randomUUID().slice(0, 8);
  return `${timestamp}-${uniqueId}`;
};
var devToolsMiddleware = (options) => {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "@ai-sdk/devtools should not be used in production. Remove devToolsMiddleware from your model configuration for production builds."
    );
  }
  registerSignalHandlers();
  const runId = options?.runId ?? generateRunId();
  let runCreated = false;
  let stepCounter = 0;
  const ensureRunCreated = async () => {
    if (!runCreated) {
      await createRun(runId);
      runCreated = true;
    }
  };
  const getNextStepNumber = () => {
    stepCounter++;
    return stepCounter;
  };
  return {
    specificationVersion: "v3",
    wrapGenerate: async ({ doGenerate, params, model }) => {
      const startTime = Date.now();
      const stepId = generateId();
      const stepNumber = getNextStepNumber();
      await ensureRunCreated();
      await createStep({
        id: stepId,
        run_id: runId,
        step_number: stepNumber,
        type: "generate",
        model_id: model.modelId,
        // @ts-expect-error broken type
        provider: model.config?.provider,
        started_at: (/* @__PURE__ */ new Date()).toISOString(),
        input: JSON.stringify({
          prompt: params.prompt,
          tools: params.tools,
          toolChoice: params.toolChoice,
          maxOutputTokens: params.maxOutputTokens,
          temperature: params.temperature,
          topP: params.topP,
          topK: params.topK,
          presencePenalty: params.presencePenalty,
          frequencyPenalty: params.frequencyPenalty,
          seed: params.seed,
          responseFormat: params.responseFormat
        }),
        provider_options: params.providerOptions ? JSON.stringify(params.providerOptions) : null
      });
      try {
        const result = await doGenerate();
        const durationMs = Date.now() - startTime;
        await updateStepResult(stepId, {
          duration_ms: durationMs,
          output: JSON.stringify({
            content: result.content,
            finishReason: result.finishReason,
            response: result.response
          }),
          usage: result.usage ? JSON.stringify(result.usage) : null,
          error: null,
          raw_request: result.request?.body ? JSON.stringify(result.request.body) : null,
          raw_response: result.response?.body ? JSON.stringify(result.response.body) : null
        });
        return result;
      } catch (error) {
        const durationMs = Date.now() - startTime;
        await updateStepResult(stepId, {
          duration_ms: durationMs,
          output: null,
          usage: null,
          error: error instanceof Error ? error.message : String(error),
          raw_request: null,
          raw_response: null
        });
        throw error;
      }
    },
    wrapStream: async ({ doStream, params, model }) => {
      const startTime = Date.now();
      const stepId = generateId();
      const stepNumber = getNextStepNumber();
      await ensureRunCreated();
      const userRequestedRawChunks = params.includeRawChunks === true;
      params.includeRawChunks = true;
      await createStep({
        id: stepId,
        run_id: runId,
        step_number: stepNumber,
        type: "stream",
        model_id: model.modelId,
        // @ts-expect-error broken type
        provider: model.config?.provider,
        started_at: (/* @__PURE__ */ new Date()).toISOString(),
        input: JSON.stringify({
          prompt: params.prompt,
          tools: params.tools,
          toolChoice: params.toolChoice,
          maxOutputTokens: params.maxOutputTokens,
          temperature: params.temperature,
          topP: params.topP,
          topK: params.topK,
          presencePenalty: params.presencePenalty,
          frequencyPenalty: params.frequencyPenalty,
          seed: params.seed,
          responseFormat: params.responseFormat
        }),
        provider_options: params.providerOptions ? JSON.stringify(params.providerOptions) : null
      });
      try {
        const { stream, request, response, ...rest } = await doStream();
        const collectedOutput = {
          textParts: [],
          reasoningParts: [],
          toolCalls: []
        };
        const currentText = /* @__PURE__ */ new Map();
        const currentReasoning = /* @__PURE__ */ new Map();
        const fullStreamChunks = [];
        const rawChunks = [];
        activeSteps.set(stepId, {
          startTime,
          collectedOutput,
          request,
          fullStreamChunks,
          rawChunks
        });
        const transformStream = new TransformStream({
          transform(chunk, controller) {
            if (chunk.type === "raw") {
              rawChunks.push(chunk.rawValue);
              if (userRequestedRawChunks) {
                controller.enqueue(chunk);
              }
              return;
            }
            fullStreamChunks.push(chunk);
            switch (chunk.type) {
              case "text-start":
                currentText.set(chunk.id, "");
                break;
              case "text-delta":
                currentText.set(
                  chunk.id,
                  (currentText.get(chunk.id) ?? "") + chunk.delta
                );
                break;
              case "text-end":
                collectedOutput.textParts.push({
                  id: chunk.id,
                  text: currentText.get(chunk.id) ?? ""
                });
                break;
              case "reasoning-start":
                currentReasoning.set(chunk.id, "");
                break;
              case "reasoning-delta":
                currentReasoning.set(
                  chunk.id,
                  (currentReasoning.get(chunk.id) ?? "") + chunk.delta
                );
                break;
              case "reasoning-end":
                collectedOutput.reasoningParts.push({
                  id: chunk.id,
                  text: currentReasoning.get(chunk.id) ?? ""
                });
                break;
              case "tool-call":
                collectedOutput.toolCalls.push(chunk);
                break;
              case "finish":
                collectedOutput.finishReason = chunk.finishReason;
                collectedOutput.usage = chunk.usage;
                break;
            }
            controller.enqueue(chunk);
          },
          async flush() {
            activeSteps.delete(stepId);
            const durationMs = Date.now() - startTime;
            await updateStepResult(stepId, {
              duration_ms: durationMs,
              output: JSON.stringify(collectedOutput),
              usage: collectedOutput.usage ? JSON.stringify(collectedOutput.usage) : null,
              error: null,
              raw_request: request?.body ? JSON.stringify(request.body) : null,
              raw_response: JSON.stringify(fullStreamChunks),
              raw_chunks: JSON.stringify(rawChunks)
            });
          },
          // @ts-expect-error - cancel is valid per WHATWG Streams spec but missing from TS types
          async cancel() {
            activeSteps.delete(stepId);
            const durationMs = Date.now() - startTime;
            await updateStepResult(stepId, {
              duration_ms: durationMs,
              output: JSON.stringify(collectedOutput),
              usage: collectedOutput.usage ? JSON.stringify(collectedOutput.usage) : null,
              error: "Request aborted",
              raw_request: request?.body ? JSON.stringify(request.body) : null,
              raw_response: JSON.stringify(fullStreamChunks),
              raw_chunks: JSON.stringify(rawChunks)
            });
          }
        });
        return {
          stream: stream.pipeThrough(transformStream),
          request,
          response,
          ...rest
        };
      } catch (error) {
        activeSteps.delete(stepId);
        const durationMs = Date.now() - startTime;
        await updateStepResult(stepId, {
          duration_ms: durationMs,
          output: null,
          usage: null,
          error: error instanceof Error ? error.message : String(error),
          raw_request: null,
          raw_response: null,
          raw_chunks: null
        });
        throw error;
      }
    }
  };
};
export {
  devToolsMiddleware
};
