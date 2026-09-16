import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
	CONFIG_DIR_NAME,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	getAgentDir,
	truncateHead,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
	agentStatusFrom,
	buildDelegationPool,
	cleanLabel,
	columnSplitRatios,
	DEFAULT_SUBAGENT_CONFIG,
	DELEGATION_THINKING_LEVELS,
	extractAssistantResult,
	formatDelegationModel,
	paneIdFrom,
	loadSubagentConfig,
	parseHerdrResponse,
	resolveDelegationThinking,
	resolveWorkingDirectory,
	sessionLineCount,
	splitPathsToPane,
	sessionPathFrom,
	type SubagentConfig,
} from "./helpers.ts";

const CHILD_TOOLS = "read,bash,edit,write,grep,find,ls";
const PANES_PER_COLUMN = 4;
const RESULT_TYPE = "subagent-result";
const TASK_SUFFIX =
	"Work autonomously on this assignment. Stay within the granted capabilities. " +
	"Your final response must report the result, supporting evidence, and any unresolved blocker in at most 800 words. " +
	"Do not spawn other agents.";

const SubagentParams = Type.Object(
	{
		name: Type.String({ minLength: 1, maxLength: 80, description: "Short task label shown in Herdr" }),
		task: Type.String({ minLength: 1, maxLength: 100_000, description: "Self-contained assignment for the child" }),
		model: Type.String({ minLength: 1, maxLength: 256, description: "Exact selector from the delegation pool" }),
		thinking: StringEnum(DELEGATION_THINKING_LEVELS, {
			description: "Child thinking level; choose the lowest level adequate for the task",
		}),
		cwd: Type.Optional(Type.String({ minLength: 1, maxLength: 4096, description: "Child working directory" })),
	},
	{ additionalProperties: false },
);

function herdrSocketRequest(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
	const socketPath = process.env.HERDR_SOCKET_PATH;
	if (!socketPath) throw new Error("HERDR_SOCKET_PATH is not set");
	if (signal?.aborted) throw new Error("Herdr request aborted");

	return new Promise((resolve, reject) => {
		const id = randomUUID();
		const socket = createConnection(socketPath);
		let buffer = "";
		let settled = false;

		function finish(error?: Error, result?: unknown): void {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			socket.destroy();
			if (error) reject(error);
			else resolve(result);
		}

		function onAbort(): void {
			finish(new Error("Herdr request aborted"));
		}

		signal?.addEventListener("abort", onAbort, { once: true });
		socket.setEncoding("utf8");
		socket.setTimeout(5000, () => finish(new Error(`Herdr ${method} timed out`)));
		socket.once("connect", () => socket.write(`${JSON.stringify({ id, method, params })}\n`));
		socket.on("data", (chunk) => {
			buffer += chunk;
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			try {
				const response = JSON.parse(buffer.slice(0, newline));
				if (response.error) {
					finish(new Error(`${response.error.code ?? "herdr_error"}: ${response.error.message ?? JSON.stringify(response.error)}`));
				} else if (!("result" in response)) {
					finish(new Error(`Herdr ${method} returned malformed JSON`));
				} else {
					finish(undefined, response.result);
				}
			} catch (error) {
				finish(error instanceof Error ? error : new Error(String(error)));
			}
		});
		socket.once("error", (error) => finish(error));
	});
}

function integrationPath(): string | undefined {
	const dir = path.join(getAgentDir(), "extensions");
	return ["herdr-agent-state.ts", "herdr-agent-state.js"]
		.map((name) => path.join(dir, name))
		.find(existsSync);
}

function poolPrompt(ctx: any, config: SubagentConfig): string {
	const pool = buildDelegationPool(ctx.model, ctx.thinkingLevel, ctx.scopedModels ?? [], config.allowCrossProvider);
	const models = pool.map((entry) => formatDelegationModel(entry, config.modelHints[entry.selector])).join("\n");

	return [
		"## Subagent delegation",
		"The subagent tool starts autonomous Pi children in visible Herdr panes.",
		`Use only these exact${config.allowCrossProvider ? "" : " same-provider"} model selectors:`,
		models || "- none",
		"Choose the cheapest adequate model and the lowest adequate thinking level shown for that model: off/minimal for mechanical lookups; low for bounded repository analysis, routine implementation, tests, and summaries; medium/high for complex planning, architecture, security-sensitive work, ambiguous debugging, or cross-cutting reasoning.",
		config.routingMode === "cost"
			? "Routing mode: minimize cost. Delegate serially only when a cheaper child can own a substantial bounded task end-to-end. Do small cohesive changes directly when they need only one investigation, edit, and verification pass."
			: "Routing mode: minimize overhead. Delegate only when parallelism or independent expertise outweighs startup and coordination overhead.",
		"Delegate only work removed from your own plan. After launch, continue only disjoint work; otherwise end the turn and wait for automatic completion. Do not inspect the same files, implement the same changes, or repeat the child's checks.",
		"After completion, review the result and run one verification pass. Avoid auxiliary mapping or test-discovery children when you must repeat that work yourself.",
		"Launch independent tasks together, avoid overlapping writers, make each task self-contained, and never poll for completion: results arrive automatically.",
	].join("\n");
}

export default function (pi: ExtensionAPI) {
	const active = new Set<string>();
	const columns: string[][] = [];
	let config = DEFAULT_SUBAGENT_CONFIG;
	let layoutQueue = Promise.resolve();
	const watchers = new Map<string, AbortController>();
	let shuttingDown = false;

	const herdrBin = () => process.env.HERDR_BIN_PATH || "herdr";

	async function herdr(args: string[], options: { signal?: AbortSignal; timeout?: number } = {}): Promise<any> {
		const result = await pi.exec(herdrBin(), args, options);
		return parseHerdrResponse(result.stdout, result.stderr, result.code);
	}

	async function closePane(paneId: string): Promise<void> {
		try {
			await pi.exec(herdrBin(), ["pane", "close", paneId], { timeout: 5000 });
		} catch {
			// Best effort cleanup after an incomplete launch.
		}
	}

	function mutateLayout<T>(operation: () => Promise<T>): Promise<T> {
		const result = layoutQueue.then(operation, operation);
		layoutQueue = result.then(() => undefined, () => undefined);
		return result;
	}

	async function rebalanceColumns(signal?: AbortSignal): Promise<void> {
		if (columns.length === 0) return;
		const exported = await herdrSocketRequest("layout.export", { tab_id: process.env.HERDR_TAB_ID }, signal);
		const allPaths = splitPathsToPane(exported?.layout?.root, process.env.HERDR_PANE_ID!);
		const paths = allPaths?.slice(-columns.length);
		if (!paths || paths.length !== columns.length) throw new Error("Could not find the subagent column splits in Herdr's layout");

		for (const [index, ratio] of columnSplitRatios(columns.length).entries()) {
			await herdrSocketRequest(
				"layout.set_split_ratio",
				{ tab_id: process.env.HERDR_TAB_ID, path: paths[index], ratio },
				signal,
			);
		}
	}

	async function createChildPane(cwd: string, signal?: AbortSignal): Promise<string> {
		return mutateLayout(async () => {
			const column = columns[0];
			let targetPane = process.env.HERDR_PANE_ID!;
			let direction = "right";

			if (column && column.length < PANES_PER_COLUMN) {
				const result = await herdr(["pane", "layout", "--pane", targetPane], { signal, timeout: 5000 });
				const heights = new Map<string, number>(
					(result?.layout?.panes ?? []).map((pane: any) => [pane.pane_id, pane.rect?.height ?? 0]),
				);
				targetPane = column.reduce((tallest, paneId) =>
					(heights.get(paneId) ?? 0) > (heights.get(tallest) ?? 0) ? paneId : tallest,
				);
				direction = "down";
			}

			const split = await herdr(
				["pane", "split", targetPane, "--direction", direction, "--ratio", "0.5", "--cwd", cwd, "--no-focus"],
				{ signal, timeout: 10_000 },
			);
			const paneId = paneIdFrom(split);
			if (!paneId) throw new Error("Herdr did not return the child pane ID");

			if (direction === "right") {
				columns.unshift([paneId]);
				try {
					await rebalanceColumns(signal);
				} catch (error) {
					await closePane(paneId);
					columns.shift();
					try {
						await rebalanceColumns();
					} catch {
						// Preserve the original layout error.
					}
					throw error;
				}
			} else {
				column!.push(paneId);
			}
			return paneId;
		});
	}

	async function closeChildPane(paneId: string): Promise<void> {
		await mutateLayout(async () => {
			await closePane(paneId);
			const columnIndex = columns.findIndex((column) => column.includes(paneId));
			if (columnIndex < 0) return;
			const column = columns[columnIndex];
			column.splice(column.indexOf(paneId), 1);
			if (column.length > 0) return;
			columns.splice(columnIndex, 1);
			try {
				await rebalanceColumns();
			} catch {
				// Pane cleanup should not fail because cosmetic rebalancing did.
			}
		});
	}

	async function startAgent(args: string[], signal: AbortSignal | undefined): Promise<any> {
		const deadline = Date.now() + 5000;
		for (;;) {
			try {
				return await herdr(args, { signal, timeout: 35_000 });
			} catch (error) {
				if (!String(error).includes("agent_pane_busy") || Date.now() >= deadline) throw error;
				await delay(100, undefined, { signal });
			}
		}
	}

	function sendParent(content: string, details: Record<string, unknown>): void {
		if (shuttingDown) return;
		try {
			pi.sendMessage(
				{ customType: RESULT_TYPE, content, display: true, details },
				{ triggerTurn: true, deliverAs: "steer" },
			);
		} catch {
			// The parent session may have shut down between the watcher check and delivery.
		}
	}

	async function watchChild(child: {
		id: string;
		name: string;
		task: string;
		model: string;
		thinking: string;
		paneId: string;
		sessionPath: string;
		baselineLines: number;
		startedAt: number;
		controller: AbortController;
	}): Promise<void> {
		const baseDetails = {
			delegationId: child.id,
			name: child.name,
			task: child.task,
			model: child.model,
			thinking: child.thinking,
			paneId: child.paneId,
			sessionPath: child.sessionPath,
		};

		try {
			let result = await herdr(["agent", "prompt", child.paneId, `${child.task}\n\n${TASK_SUFFIX}`, "--wait"], {
				signal: child.controller.signal,
			});
			let status = agentStatusFrom(result);

			for (;;) {
				if (status === "idle" || status === "done") break;
				if (status === "unknown") throw new Error("Child agent exited before completing its task");

				if (status === "blocked") {
					sendParent(
						`Subagent "${child.name}" is blocked in Herdr pane ${child.paneId}. Resolve it in that pane; completion will still arrive automatically.`,
						{ ...baseDetails, status: "blocked" },
					);
					result = await herdr(
						[
							"agent",
							"wait",
							child.paneId,
							"--until",
							"working",
							"--until",
							"idle",
							"--until",
							"done",
							"--until",
							"unknown",
						],
						{ signal: child.controller.signal },
					);
					status = agentStatusFrom(result);
					continue;
				}

				if (status === "working") {
					result = await herdr(
						[
							"agent",
							"wait",
							child.paneId,
							"--until",
							"idle",
							"--until",
							"done",
							"--until",
							"blocked",
							"--until",
							"unknown",
						],
						{ signal: child.controller.signal },
					);
					status = agentStatusFrom(result);
					continue;
				}

				throw new Error(`Unexpected child agent status: ${status ?? "missing"}`);
			}

			const final = extractAssistantResult(await readFile(child.sessionPath, "utf8"), child.baselineLines);
			if (!final) throw new Error("Child session contained no completed assistant response");

			const failed = final.stopReason === "error" || final.stopReason === "aborted";
			const fullOutput = final.text || final.errorMessage || "(no text output)";
			const output = truncateHead(fullOutput, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
			const truncationNote = output.truncated
				? `\n\n[Output truncated. Full output: ${child.sessionPath}]`
				: "";
			const elapsedMs = Date.now() - child.startedAt;
			sendParent(
				`Subagent "${child.name}" ${failed ? "failed" : "completed"} (${final.model ?? child.model}, ${child.thinking} thinking, ${Math.round(elapsedMs / 1000)}s).\n\n${output.content}${truncationNote}`,
				{
					...baseDetails,
					status: failed ? "failed" : "completed",
					stopReason: final.stopReason,
					errorMessage: final.errorMessage,
					elapsedMs,
				},
			);
		} catch (error) {
			if (!shuttingDown && !child.controller.signal.aborted) {
				sendParent(`Subagent "${child.name}" failed: ${error instanceof Error ? error.message : String(error)}`, {
					...baseDetails,
					status: "failed",
				});
			}
		} finally {
			if (!shuttingDown && !child.controller.signal.aborted) await closeChildPane(child.paneId);
			active.delete(child.id);
			watchers.delete(child.id);
		}
	}

	pi.on("session_start", (_event, ctx) => {
		config = loadSubagentConfig(ctx.cwd, getAgentDir(), CONFIG_DIR_NAME, ctx.isProjectTrusted());
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (!pi.getActiveTools().includes("subagent")) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${poolPrompt(ctx, config)}` };
	});

	pi.on("session_shutdown", () => {
		shuttingDown = true;
		for (const controller of watchers.values()) controller.abort();
		watchers.clear();
		active.clear();
		columns.length = 0;
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: "Start one autonomous Pi child in a Herdr pane using an exact model selector from the current delegation pool. Completion is delivered asynchronously.",
		promptSnippet: "Delegate a self-contained task to an autonomous Pi child in Herdr",
		promptGuidelines: [
			"Use subagent according to the active routing mode in the injected delegation guidance.",
			"Delegated work must replace parent work: after launch, continue only disjoint work or end the turn until completion.",
			"Do not poll after subagent starts; its result is delivered automatically.",
		],
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (
				process.env.HERDR_ENV !== "1" ||
				!process.env.HERDR_WORKSPACE_ID ||
				!process.env.HERDR_TAB_ID ||
				!process.env.HERDR_PANE_ID
			) {
				throw new Error("subagent requires Pi to be running in a Herdr-managed pane");
			}

			const name = cleanLabel(params.name);
			const task = params.task.trim();
			if (!name) throw new Error("Subagent name must contain visible characters");
			if (!task) throw new Error("Subagent task must contain visible characters");

			const pool = buildDelegationPool(ctx.model, ctx.thinkingLevel, ctx.scopedModels ?? [], config.allowCrossProvider);
			const selectedModel = pool.find(({ selector }) => selector === params.model);
			if (!selectedModel) {
				throw new Error(`Model is not in the delegation pool. Allowed: ${pool.map(({ selector }) => selector).join(", ") || "none"}`);
			}
			const thinking = resolveDelegationThinking(selectedModel, params.thinking);

			if (active.size >= config.maxConcurrency) throw new Error(`At most ${config.maxConcurrency} subagents may run concurrently`);
			const id = randomUUID();
			active.add(id);

			let paneId: string | undefined;
			try {
				const cwd = await resolveWorkingDirectory(ctx.cwd, params.cwd);
				const integration = integrationPath();
				if (!integration) throw new Error("Herdr's Pi integration was not found; run `herdr integration install pi`");

				paneId = await createChildPane(cwd, signal);

				const childAgentName = `subagent-${id.slice(0, 8)}`;
				const started = await startAgent(
					[
						"agent",
						"start",
						childAgentName,
						"--kind",
						"pi",
						"--pane",
						paneId,
						"--timeout",
						"30000",
						"--",
						"--model",
						params.model,
						"--thinking",
						thinking,
						"--tools",
						CHILD_TOOLS,
						"--no-extensions",
						"--extension",
						integration,
					],
					signal,
				);

				let sessionPath = sessionPathFrom(started);
				if (!sessionPath) sessionPath = sessionPathFrom(await herdr(["agent", "get", paneId], { signal, timeout: 5000 }));
				if (!sessionPath) throw new Error("Herdr did not report the child Pi session path");
				// Pi creates the reported session file lazily when the first prompt is written.
				const baselineLines = existsSync(sessionPath) ? sessionLineCount(await readFile(sessionPath, "utf8")) : 0;

				const parentPane = process.env.HERDR_PANE_ID;
				const parentLabel = cleanLabel(pi.getSessionName() || path.basename(ctx.cwd));
				const parentModel = cleanLabel(ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown");
				await herdr(
					[
						"pane",
						"report-metadata",
						parentPane,
						"--source",
						"pi:subagent",
						"--agent",
						"pi",
						"--token",
						`delegation_root=${parentPane}`,
						"--token",
						"delegation_depth=0",
						"--token",
						`delegation_label=${parentLabel}`,
						"--token",
						`delegation_model=${parentModel}`,
					],
					{ signal, timeout: 5000 },
				);
				await herdr(
					[
						"pane",
						"report-metadata",
						paneId,
						"--source",
						"pi:subagent",
						"--agent",
						"pi",
						"--display-agent",
						name,
						"--token",
						`delegation_id=${id}`,
						"--token",
						`delegation_parent=${parentPane}`,
						"--token",
						`delegation_root=${parentPane}`,
						"--token",
						"delegation_depth=1",
						"--token",
						`delegation_label=${name}`,
						"--token",
						`delegation_model=${cleanLabel(params.model)}`,
						"--token",
						`delegation_thinking=${thinking}`,
					],
					{ signal, timeout: 5000 },
				);

				const controller = new AbortController();
				watchers.set(id, controller);
				void watchChild({
					id,
					name,
					task,
					model: params.model,
					thinking,
					paneId,
					sessionPath,
					baselineLines,
					startedAt: Date.now(),
					controller,
				});

				return {
					content: [
						{
							type: "text" as const,
							text: `Started subagent "${name}" in Herdr pane ${paneId} with ${params.model} at ${thinking} thinking. Completion will arrive automatically. Do not poll or duplicate its assignment; continue only disjoint work, otherwise end this turn.`,
						},
					],
					details: { delegationId: id, name, paneId, model: params.model, thinking, sessionPath, status: "started" },
				};
			} catch (error) {
				active.delete(id);
				if (paneId) await closeChildPane(paneId);
				throw error;
			}
		},
	});
}
