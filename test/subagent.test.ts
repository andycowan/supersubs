import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
	agentStatusFrom,
	buildDelegationPool,
	cleanLabel,
	columnSplitRatios,
	extractAssistantResult,
	formatDelegationModel,
	loadSubagentConfig,
	paneIdFrom,
	parseHerdrResponse,
	resolveDelegationThinking,
	resolveMaxConcurrency,
	resolveRoutingMode,
	sessionLineCount,
	supportedDelegationThinking,
	sessionPathFrom,
	splitPathsToPane,
} from "../.pi/extensions/subagent/helpers.ts";

const active = { provider: "openai", id: "gpt-6", name: "GPT-6" };

test("subagent config follows default, global, trusted-project precedence", () => {
	const root = mkdtempSync(path.join(tmpdir(), "subagent-config-"));
	const agentDir = path.join(root, "agent");
	const cwd = path.join(root, "project");
	mkdirSync(path.join(cwd, ".pi"), { recursive: true });
	mkdirSync(agentDir);

	try {
		assert.deepEqual(loadSubagentConfig(cwd, agentDir, ".pi", true), {
			routingMode: "overhead",
			allowCrossProvider: true,
			maxConcurrency: 4,
			modelHints: {},
		});

		writeFileSync(
			path.join(agentDir, "subagent.json"),
			JSON.stringify({
				routingMode: "cost",
				allowCrossProvider: false,
				maxConcurrency: 8,
				modelHints: {
					"openai/gpt-6": { costTier: "low", bestFor: ["bounded work"], avoidFor: ["security"] },
					"deepseek/v4-pro": { costTier: "high" },
				},
			}),
		);
		writeFileSync(
			path.join(cwd, ".pi", "subagent.json"),
			JSON.stringify({
				allowCrossProvider: true,
				maxConcurrency: 12,
				modelHints: {
					"openai/gpt-6": { avoidFor: ["architecture"] },
					"openai/gpt-5.6": { bestFor: ["tests"] },
				},
			}),
		);
		assert.deepEqual(loadSubagentConfig(cwd, agentDir, ".pi", true), {
			routingMode: "cost",
			allowCrossProvider: true,
			maxConcurrency: 12,
			modelHints: {
				"openai/gpt-6": { costTier: "low", bestFor: ["bounded work"], avoidFor: ["architecture"] },
				"deepseek/v4-pro": { costTier: "high" },
				"openai/gpt-5.6": { bestFor: ["tests"] },
			},
		});
		assert.deepEqual(loadSubagentConfig(cwd, agentDir, ".pi", false), {
			routingMode: "cost",
			allowCrossProvider: false,
			maxConcurrency: 8,
			modelHints: {
				"openai/gpt-6": { costTier: "low", bestFor: ["bounded work"], avoidFor: ["security"] },
				"deepseek/v4-pro": { costTier: "high" },
			},
		});

		writeFileSync(path.join(cwd, ".pi", "subagent.json"), JSON.stringify({ typo: true }));
		assert.throws(() => loadSubagentConfig(cwd, agentDir, ".pi", true), /unknown field typo/);
		for (const value of [0, 17, 1.5, "4", null]) {
			writeFileSync(path.join(cwd, ".pi", "subagent.json"), JSON.stringify({ maxConcurrency: value }));
			assert.throws(() => loadSubagentConfig(cwd, agentDir, ".pi", true), /maxConcurrency must be an integer from 1 through 16/);
		}
		assert.equal(resolveMaxConcurrency(1), 1);
		assert.equal(resolveMaxConcurrency(16), 16);
		assert.throws(() => resolveRoutingMode("fast"), /must be "overhead" or "cost"/);
	} finally {
		rmSync(root, { recursive: true });
	}
});

test("model hints reject invalid selectors and values", () => {
	const root = mkdtempSync(path.join(tmpdir(), "subagent-hints-"));
	const agentDir = path.join(root, "agent");
	const cwd = path.join(root, "project");
	mkdirSync(agentDir);
	mkdirSync(path.join(cwd, ".pi"), { recursive: true });

	try {
		const invalid = [
			{ modelHints: [] },
			{ modelHints: { "gpt-6": {} } },
			{ modelHints: { "openai/gpt-6": { nope: true } } },
			{ modelHints: { "openai/gpt-6": { costTier: "free-ish" } } },
			{ modelHints: { "openai/gpt-6": { bestFor: "tests" } } },
			{ modelHints: { "openai/gpt-6": { bestFor: [""] } } },
			{ modelHints: { "openai/gpt-6": { avoidFor: [" "] } } },
		];
		for (const value of invalid) {
			writeFileSync(path.join(cwd, ".pi", "subagent.json"), JSON.stringify(value));
			assert.throws(() => loadSubagentConfig(cwd, agentDir, ".pi", true), /Invalid subagent config/);
		}
	} finally {
		rmSync(root, { recursive: true });
	}
});

test("delegation model lines prefer Pi prices over configured cost tiers", () => {
	const hint = { costTier: "medium" as const, bestFor: ["tests"], avoidFor: ["large refactors"] };
	assert.equal(
		formatDelegationModel({ selector: "openai-codex/gpt-5.6-luna", model: { provider: "openai-codex", id: "gpt-5.6-luna" } }, hint),
		"- openai-codex/gpt-5.6-luna — cost: medium; best for: tests; avoid for: large refactors",
	);
	assert.equal(
		formatDelegationModel(
			{ selector: "openai-codex/gpt-5.6-luna", model: { provider: "openai-codex", id: "gpt-5.6-luna", cost: { input: 1, output: 2 } } },
			hint,
		),
		"- openai-codex/gpt-5.6-luna — $1/M in, $2/M out; best for: tests; avoid for: large refactors",
	);
});

test("delegation pool allows cross-provider scoped models by default", () => {
	const scoped = [
		{ model: active },
		{ model: { provider: "openai", id: "gpt-5.6" }, thinkingLevel: "low" },
		{ model: { provider: "deepseek", id: "v4-pro" } },
	];

	assert.deepEqual(buildDelegationPool(active, "high", scoped).map(({ selector }) => selector), [
		"openai/gpt-6",
		"openai/gpt-5.6:low",
		"deepseek/v4-pro",
	]);
	assert.deepEqual(buildDelegationPool(active, "high", scoped, false).map(({ selector }) => selector), [
		"openai/gpt-6",
		"openai/gpt-5.6:low",
	]);
	assert.deepEqual(buildDelegationPool(active, "high", []).map(({ selector }) => selector), ["openai/gpt-6"]);
});

test("child thinking is selected dynamically from levels supported by the model", () => {
	const unpinned = buildDelegationPool(active, "high", [{ model: active }])[0];
	assert.equal(resolveDelegationThinking(unpinned, "low"), "low");

	const pinned = buildDelegationPool(active, "high", [{ model: active, thinkingLevel: "medium" }])[0];
	assert.equal(resolveDelegationThinking(pinned, "medium"), "medium");
	assert.throws(() => resolveDelegationThinking(pinned, "low"), /pinned to thinking level medium/);

	const flash = {
		provider: "opencode-go",
		id: "deepseek-v4-flash",
		reasoning: true,
		thinkingLevelMap: { minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" },
	};
	const flashEntry = buildDelegationPool(active, "high", [{ model: flash }])[0];
	assert.deepEqual(supportedDelegationThinking(flash), ["off", "low", "high", "max"]);
	assert.equal(resolveDelegationThinking(flashEntry, "low"), "low");
	assert.throws(() => resolveDelegationThinking(flashEntry, "medium"), /does not support medium thinking.*off, low, high, max/);
	assert.match(formatDelegationModel(flashEntry), /thinking: off, low, high, max/);
});

test("Herdr responses and agent fields are parsed", () => {
	const result = parseHerdrResponse(
		'diagnostic\n{"id":"1","result":{"type":"agent_info","agent":{"pane_id":"w1:p2","agent_status":"done","agent_session":{"kind":"path","value":"/tmp/child.jsonl"}}}}\n',
		"",
		0,
	);
	assert.equal(paneIdFrom(result), "w1:p2");
	assert.equal(agentStatusFrom(result), "done");
	assert.equal(sessionPathFrom(result), "/tmp/child.jsonl");
	assert.equal(parseHerdrResponse("", "", 0), undefined);
	assert.throws(
		() => parseHerdrResponse("", '{"error":{"code":"agent_blocked","message":"blocked"}}', 1),
		/agent_blocked: blocked/,
	);
});

test("final assistant output is read only after the launch baseline", () => {
	const before = JSON.stringify({ type: "session", version: 3 });
	const user = JSON.stringify({ type: "message", message: { role: "user", content: "task" } });
	const assistant = JSON.stringify({
		type: "message",
		message: {
			role: "assistant",
			provider: "openai",
			model: "gpt-6",
			stopReason: "stop",
			content: [
				{ type: "text", text: "result" },
				{ type: "text", text: "evidence" },
			],
		},
	});
	const jsonl = `${before}\n${user}\n${assistant}\n{incomplete`;

	assert.equal(sessionLineCount(""), 0);
	assert.equal(sessionLineCount(`${before}\n`), 1);
	assert.deepEqual(extractAssistantResult(jsonl, 1), {
		text: "result\nevidence",
		model: "openai/gpt-6",
		stopReason: "stop",
		errorMessage: undefined,
	});
});

test("subagent columns keep the parent at half width", () => {
	assert.deepEqual(columnSplitRatios(1), [0.5]);
	assert.deepEqual(columnSplitRatios(2), [0.75, 2 / 3]);
	assert.deepEqual(columnSplitRatios(3), [5 / 6, 0.8, 0.75]);

	const root = {
		type: "split" as const,
		first: {
			type: "split" as const,
			first: {
				type: "split" as const,
				first: { type: "pane" as const, pane_id: "parent" },
				second: { type: "pane" as const, pane_id: "new-column" },
			},
			second: { type: "pane" as const, pane_id: "old-column" },
		},
		second: { type: "pane" as const, pane_id: "unrelated" },
	};
	assert.deepEqual(splitPathsToPane(root, "parent"), [[], [false], [false, false]]);
	assert.equal(splitPathsToPane(root, "missing"), undefined);
});

test("labels are safe for Herdr metadata", () => {
	assert.equal(cleanLabel("  Review\n\tauth\u0000  "), "Review auth");
	assert.equal(cleanLabel("x".repeat(100)).length, 80);
});
