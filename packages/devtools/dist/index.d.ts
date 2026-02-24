import { LanguageModelV3Middleware } from '@ai-sdk/provider';

/**
 * Options for configuring the devtools middleware.
 */
interface DevToolsMiddlewareOptions {
    /**
     * Provide a custom run ID to group multiple steps together across different calls.
     * If not provided, a unique run ID will be generated automatically for each middleware instance.
     *
     * Use this to group related operations:
     * ```ts
     * const sharedRunId = 'my-workflow-' + Date.now();
     *
     * // Both calls will be grouped under the same run
     * await streamText({
     *   model: wrapLanguageModel({
     *     middleware: devToolsMiddleware({ runId: sharedRunId }),
     *     model: yourModel,
     *   }),
     *   prompt: "First step...",
     * });
     *
     * await generateText({
     *   model: wrapLanguageModel({
     *     middleware: devToolsMiddleware({ runId: sharedRunId }),
     *     model: yourModel,
     *   }),
     *   prompt: "Second step...",
     * });
     * ```
     */
    runId?: string | null;
}
/**
 * Factory function that creates a devtools middleware instance.
 * Each call generates a unique run ID by default, so all steps within a single
 * streamText/generateText call share the same run.
 *
 * Usage:
 * ```ts
 * // Basic usage - auto-generated run ID
 * const result = streamText({
 *   model: wrapLanguageModel({
 *     middleware: devToolsMiddleware(),
 *     model: yourModel,
 *   }),
 *   prompt: "...",
 * });
 *
 * // Group multiple calls under the same run
 * const runId = 'workflow-' + Date.now();
 * const middleware1 = devToolsMiddleware({ runId });
 * const middleware2 = devToolsMiddleware({ runId });
 * ```
 */
declare const devToolsMiddleware: (options?: DevToolsMiddlewareOptions) => LanguageModelV3Middleware;

export { type DevToolsMiddlewareOptions, devToolsMiddleware };
