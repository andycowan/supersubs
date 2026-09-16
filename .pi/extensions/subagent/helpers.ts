import { constants, existsSync, readFileSync } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import path from "node:path";

export const DELEGATION_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type DelegationThinkingLevel = (typeof DELEGATION_THINKING_LEVELS)[number];

export interface ModelLike {
	provider: string;
	id: string;
	name?: string;
	reasoning?: boolean;
	thinkingLevelMap?: Partial<Record<DelegationThinkingLevel, string | null>>;
	cost?: {
		input?: number;
		output?: number;
	};
}

export interface DelegationModel {
	selector: string;
	model: ModelLike;
	thinkingLevel?: string;
}

export type RoutingMode = "overhead" | "cost";
export type CostTier = "free" | "low" | "medium" | "high";

export interface ModelRoutingHint {
	costTier?: CostTier;
	bestFor?: string[];
	avoidFor?: string[];
}

export interface SubagentConfig {
	routingMode: RoutingMode;
	allowCrossProvider: boolean;
	maxConcurrency: number;
	maxDepth: number;
	modelHints: Record<string, ModelRoutingHint>;
}

export const DEFAULT_SUBAGENT_CONFIG: SubagentConfig = {
	routingMode: "overhead",
	allowCrossProvider: true,
	maxConcurrency: 4,
	maxDepth: 1,
	modelHints: {},
};

export function resolveRoutingMode(value: unknown): RoutingMode {
	if (value === "overhead" || value === "cost") return value;
	throw new Error(`routingMode must be "overhead" or "cost", got ${JSON.stringify(value)}`);
}

export function resolveMaxConcurrency(value: unknown): number {
	if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 16) return value;
	throw new Error(`maxConcurrency must be an integer from 1 through 16, got ${JSON.stringify(value)}`);
}

export function resolveMaxDepth(value: unknown): number {
	if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 8) return value;
	throw new Error(`maxDepth must be an integer from 1 through 8, got ${JSON.stringify(value)}`);
}

const MODEL_SELECTOR = /^[^/\s:]+\/[^/\s:]+(?::[^/\s:]+)?$/;
const COST_TIERS = new Set<CostTier>(["free", "low", "medium", "high"]);

function resolveModelHints(value: unknown, file: string): Record<string, ModelRoutingHint> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`Invalid subagent config ${file}: modelHints must be an object`);
	}

	const hints: Record<string, ModelRoutingHint> = {};
	for (const selector of Object.keys(value)) {
		if (!MODEL_SELECTOR.test(selector)) {
			throw new Error(`Invalid subagent config ${file}: modelHints selector ${JSON.stringify(selector)} must be provider/model[:thinking]`);
		}
		const raw = (value as Record<string, unknown>)[selector];
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
			throw new Error(`Invalid subagent config ${file}: modelHints.${selector} must be an object`);
		}

		const hint = raw as Record<string, unknown>;
		const unknown = Object.keys(hint).filter((key) => key !== "costTier" && key !== "bestFor" && key !== "avoidFor");
		if (unknown.length) throw new Error(`Invalid subagent config ${file}: unknown model hint field ${unknown.join(", ")}`);
		if (hint.costTier !== undefined && !COST_TIERS.has(hint.costTier as CostTier)) {
			throw new Error(`Invalid subagent config ${file}: modelHints.${selector}.costTier must be "free", "low", "medium", or "high"`);
		}

		const parsed: ModelRoutingHint = {};
		if (hint.costTier !== undefined) parsed.costTier = hint.costTier as CostTier;
		for (const field of ["bestFor", "avoidFor"] as const) {
			if (hint[field] === undefined) continue;
			if (!Array.isArray(hint[field]) || hint[field].some((item) => typeof item !== "string" || !item.trim())) {
				throw new Error(`Invalid subagent config ${file}: modelHints.${selector}.${field} must be an array of non-empty strings`);
			}
			parsed[field] = [...(hint[field] as string[])];
		}
		hints[selector] = parsed;
	}
	return hints;
}

function readConfig(file: string): Partial<SubagentConfig> {
	if (!existsSync(file)) return {};

	let value: unknown;
	try {
		value = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		throw new Error(`Invalid subagent config ${file}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid subagent config ${file}: expected an object`);

	const input = value as Record<string, unknown>;
	const unknown = Object.keys(input).filter(
		(key) =>
			key !== "routingMode" &&
			key !== "allowCrossProvider" &&
			key !== "maxConcurrency" &&
			key !== "maxDepth" &&
			key !== "modelHints",
	);
	if (unknown.length) throw new Error(`Invalid subagent config ${file}: unknown field ${unknown.join(", ")}`);
	if (input.allowCrossProvider !== undefined && typeof input.allowCrossProvider !== "boolean") {
		throw new Error(`Invalid subagent config ${file}: allowCrossProvider must be a boolean`);
	}

	return {
		...(input.routingMode === undefined ? {} : { routingMode: resolveRoutingMode(input.routingMode) }),
		...(input.allowCrossProvider === undefined ? {} : { allowCrossProvider: input.allowCrossProvider }),
		...(input.maxConcurrency === undefined ? {} : { maxConcurrency: resolveMaxConcurrency(input.maxConcurrency) }),
		...(input.maxDepth === undefined ? {} : { maxDepth: resolveMaxDepth(input.maxDepth) }),
		...(input.modelHints === undefined ? {} : { modelHints: resolveModelHints(input.modelHints, file) }),
	};
}

function mergeModelHints(...configs: Partial<SubagentConfig>[]): Record<string, ModelRoutingHint> {
	return configs.reduce<Record<string, ModelRoutingHint>>((merged, config) => {
		for (const [selector, hint] of Object.entries(config.modelHints ?? {})) {
			merged[selector] = { ...merged[selector], ...hint };
		}
		return merged;
	}, {});
}

export function loadSubagentConfig(cwd: string, agentDir: string, configDirName: string, projectTrusted: boolean): SubagentConfig {
	const globalConfig = readConfig(path.join(agentDir, "subagent.json"));
	const projectConfig = projectTrusted ? readConfig(path.join(cwd, configDirName, "subagent.json")) : {};
	return {
		...DEFAULT_SUBAGENT_CONFIG,
		...globalConfig,
		...projectConfig,
		modelHints: mergeModelHints(DEFAULT_SUBAGENT_CONFIG, globalConfig, projectConfig),
	};
}

export function buildDelegationPool(
	active: ModelLike | undefined,
	_thinkingLevel: string | undefined,
	scoped: readonly { model: ModelLike; thinkingLevel?: string }[],
	allowCrossProvider = true,
): DelegationModel[] {
	if (!active) return [];

	const candidates = allowCrossProvider ? scoped : scoped.filter(({ model }) => model.provider === active.provider);
	const source = candidates.length > 0 ? candidates : [{ model: active }];
	const pool = new Map<string, DelegationModel>();

	for (const entry of source) {
		const selector = `${entry.model.provider}/${entry.model.id}${entry.thinkingLevel ? `:${entry.thinkingLevel}` : ""}`;
		pool.set(selector, { selector, model: entry.model, thinkingLevel: entry.thinkingLevel });
	}

	return [...pool.values()];
}

export function supportedDelegationThinking(model: ModelLike): DelegationThinkingLevel[] {
	if (model.reasoning === false) return ["off"];
	return DELEGATION_THINKING_LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		if (mapped !== undefined) return true;
		return level !== "xhigh" && level !== "max";
	});
}

export function resolveDelegationThinking(entry: DelegationModel, requested: DelegationThinkingLevel): DelegationThinkingLevel {
	if (entry.thinkingLevel && entry.thinkingLevel !== requested) {
		throw new Error(`Model ${entry.selector} is pinned to thinking level ${entry.thinkingLevel}`);
	}
	const supported = supportedDelegationThinking(entry.model);
	if (!supported.includes(requested)) {
		throw new Error(`Model ${entry.selector} does not support ${requested} thinking. Supported: ${supported.join(", ")}`);
	}
	return requested;
}

export function formatDelegationModel(entry: DelegationModel, hint?: ModelRoutingHint): string {
	const cost = entry.model.cost;
	const hasPrices = (cost?.input ?? 0) !== 0 || (cost?.output ?? 0) !== 0;
	const details: string[] = [];
	if (hasPrices) details.push(`$${cost?.input ?? 0}/M in, $${cost?.output ?? 0}/M out`);
	else if (hint?.costTier) details.push(`cost: ${hint.costTier}`);
	if (entry.model.reasoning !== undefined) details.push(`thinking: ${supportedDelegationThinking(entry.model).join(", ")}`);
	if (hint?.bestFor?.length) details.push(`best for: ${hint.bestFor.join(", ")}`);
	if (hint?.avoidFor?.length) details.push(`avoid for: ${hint.avoidFor.join(", ")}`);
	return `- ${entry.selector}${entry.model.name && entry.model.name !== entry.model.id ? ` (${entry.model.name})` : ""}${details.length ? ` — ${details.join("; ")}` : ""}`;
}

export async function resolveWorkingDirectory(base: string, requested?: string): Promise<string> {
	const input = requested?.replace(/^@/, "") || base;
	const resolved = await realpath(path.resolve(base, input));
	if (!(await stat(resolved)).isDirectory()) throw new Error(`Working directory is not a directory: ${requested}`);
	await access(resolved, constants.R_OK | constants.X_OK);
	return resolved;
}

export function cleanLabel(value: string): string {
	return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
}

export type HerdrLayoutNode =
	| { type: "pane"; pane_id?: string }
	| { type: "split"; first: HerdrLayoutNode; second: HerdrLayoutNode };

export function splitPathsToPane(node: HerdrLayoutNode | undefined, paneId: string, path: boolean[] = []): boolean[][] | undefined {
	if (!node) return undefined;
	if (node.type === "pane") return node.pane_id === paneId ? [] : undefined;

	const first = splitPathsToPane(node.first, paneId, [...path, false]);
	if (first) return [path, ...first];
	const second = splitPathsToPane(node.second, paneId, [...path, true]);
	return second ? [path, ...second] : undefined;
}

export function columnSplitRatios(columnCount: number): number[] {
	return Array.from({ length: columnCount }, (_, index) => (2 * columnCount - index - 1) / (2 * columnCount - index));
}

export function parseHerdrResponse(stdout: string, stderr: string, code: number): unknown {
	let payload: any;
	for (const line of `${stdout}\n${stderr}`.trim().split(/\r?\n/).reverse()) {
		try {
			payload = JSON.parse(line);
			break;
		} catch {
			// Herdr normally emits one JSON line; tolerate preceding diagnostics.
		}
	}

	if (payload?.error) throw new Error(`${payload.error.code ?? "herdr_error"}: ${payload.error.message ?? JSON.stringify(payload.error)}`);
	if (code !== 0) throw new Error(stderr.trim() || stdout.trim() || `Herdr exited with code ${code}`);
	if (!payload) return undefined; // Report commands succeed without output.
	if (!("result" in payload)) throw new Error("Herdr returned malformed JSON");
	return payload.result;
}

export function paneIdFrom(result: any): string | undefined {
	return result?.pane?.pane_id ?? result?.root_pane?.pane_id ?? result?.agent?.pane_id;
}

export function agentStatusFrom(result: any): string | undefined {
	return result?.agent?.agent_status ?? result?.pane?.agent_status;
}

export function sessionPathFrom(result: any): string | undefined {
	const session = result?.agent?.agent_session ?? result?.pane?.agent_session;
	return session?.kind === "path" && typeof session.value === "string" ? session.value : undefined;
}

export function sessionLineCount(jsonl: string): number {
	return jsonl.split(/\r?\n/).filter(Boolean).length;
}

export interface AssistantResult {
	text: string;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
}

export function extractAssistantResult(jsonl: string, afterLine: number): AssistantResult | undefined {
	const entries = jsonl.split(/\r?\n/).filter(Boolean).slice(afterLine);
	let last: any;

	for (const line of entries) {
		try {
			const entry = JSON.parse(line);
			if (entry.type === "message" && entry.message?.role === "assistant") last = entry.message;
		} catch {
			// Ignore an incomplete trailing line while the session file is being flushed.
		}
	}

	if (!last) return undefined;
	const text = Array.isArray(last.content)
		? last.content
				.filter((part: any) => part?.type === "text" && typeof part.text === "string")
				.map((part: any) => part.text)
				.join("\n")
		: "";

	return {
		text,
		model: last.provider && last.model ? `${last.provider}/${last.model}` : last.model,
		stopReason: last.stopReason,
		errorMessage: last.errorMessage,
	};
}
