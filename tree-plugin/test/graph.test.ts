import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTree, resolveScope, type NodeInput, type TreeNode } from "../graph.ts";

function node(paneId: string, tokens: Record<string, string>, overrides: Partial<NodeInput> = {}): NodeInput {
	return {
		pane_id: paneId,
		workspace_id: tokens.delegation_workspace ?? "w1",
		status: "working",
		label: null,
		order: Number(paneId.replace(/\D/g, "")) || 0,
		tokens,
		...overrides,
	};
}

function flat(roots: TreeNode[]): string[] {
	return roots.flatMap((root) => [`${root.depth}:${root.label}`, ...flat(root.children)]);
}

test("builds a nested tree with computed depths and sibling order", () => {
	const result = buildTree([
		node("w1:p1", { delegation_root: "w1:p1", delegation_depth: "0", delegation_label: "Main task" }),
		node("w1:p3", {
			delegation_root: "w1:p1",
			delegation_parent: "w1:p1",
			delegation_label: "Implement",
			delegation_model: "gpt-6",
			delegation_thinking: "low",
		}),
		node("w1:p2", { delegation_root: "w1:p1", delegation_parent: "w1:p1", delegation_label: "Map codebase" }),
		node("w1:p4", { delegation_root: "w1:p1", delegation_parent: "w1:p3", delegation_label: "Check compat" }),
	]);

	assert.deepEqual(flat(result.roots), ["0:Main task", "1:Map codebase", "1:Implement", "2:Check compat"]);
	assert.equal(result.byPaneId.get("w1:p4")?.depth, 2);
	assert.equal(result.byPaneId.get("w1:p3")?.model, "gpt-6");
	assert.equal(result.unattached.length, 0);
});

test("missing parents land under Unattached", () => {
	const result = buildTree([
		node("w1:p1", { delegation_root: "w1:p1", delegation_label: "Main task" }),
		node("w1:p2", { delegation_root: "w1:p1", delegation_parent: "w1:p9", delegation_label: "Orphan" }),
	]);

	assert.equal(result.roots.length, 1);
	assert.deepEqual(flat(result.unattached), ["0:Orphan"]);
});

test("cyclic metadata is broken at the largest child pane ID without crashing", () => {
	const result = buildTree([
		node("w1:p1", { delegation_root: "w1:p1", delegation_label: "Main task" }),
		node("w1:p2", { delegation_root: "w1:p1", delegation_parent: "w1:p3", delegation_label: "A" }),
		node("w1:p3", { delegation_root: "w1:p1", delegation_parent: "w1:p2", delegation_label: "B" }),
	]);

	// Edge p3→p2 is cut (child p3 sorts last), so p3 tops the unattached group with p2 below it.
	assert.deepEqual(flat(result.unattached), ["0:B", "1:A"]);
	assert.equal(result.byPaneId.get("w1:p3")?.parent_pane_id, undefined);
	assert.equal(result.byPaneId.get("w1:p3")?.invalid, "cycle");
	assert.equal(result.roots.length, 1);
});

test("duplicate delegation IDs under one root are both retained and marked", () => {
	const result = buildTree([
		node("w1:p1", { delegation_root: "w1:p1", delegation_label: "Main task" }),
		node("w1:p2", { delegation_root: "w1:p1", delegation_parent: "w1:p1", delegation_id: "d1", delegation_label: "First" }),
		node("w1:p3", { delegation_root: "w1:p1", delegation_parent: "w1:p1", delegation_id: "d1", delegation_label: "Second" }),
	]);

	assert.equal(result.byPaneId.get("w1:p2")?.invalid, "duplicate");
	assert.equal(result.byPaneId.get("w1:p3")?.invalid, "duplicate");
	assert.equal(result.roots[0].children.length, 2);
});

test("non-agent parent panes do not attach children", () => {
	const result = buildTree([
		node("w1:p1", { delegation_root: "w1:p1", delegation_label: "Main task" }),
		node("w1:p2", { delegation_root: "w1:p1", delegation_parent: "w1:p1", delegation_label: "Child" }),
		// p3 is a pane with tokens but no delegation_root: not an agent participant.
		node("w1:p4", { delegation_root: "w1:p2", delegation_parent: "w1:p3", delegation_label: "Grandchild" }),
	]);

	assert.deepEqual(flat(result.roots), ["0:Main task", "1:Child"]);
	assert.deepEqual(flat(result.unattached), ["0:Grandchild"]);
});

test("standalone agents are ignored entirely", () => {
	const result = buildTree([
		node("w1:p1", { delegation_root: "w1:p1", delegation_label: "Main task" }),
		node("w1:p5", {}, { label: "Random shell" }),
	]);

	assert.equal(result.roots.length, 1);
	assert.equal(result.byPaneId.size, 1);
});

test("scope prefers the focused root tree, then workspace, then everything", () => {
	const result = buildTree([
		node("w1:p1", { delegation_root: "w1:p1", delegation_label: "Root A" }, { workspace_id: "w1" }),
		node("w1:p2", { delegation_root: "w1:p2", delegation_label: "Root B" }, { workspace_id: "w1" }),
		node("w2:p1", { delegation_root: "w2:p1", delegation_label: "Root C" }, { workspace_id: "w2" }),
	]);

	assert.deepEqual(resolveScope(result, "w1:p3", "w1").map((root) => root.label), ["Root A", "Root B"]);
	assert.deepEqual(resolveScope(result, "w1:p1", "w2").map((root) => root.label), ["Root A"]);
	assert.deepEqual(resolveScope(result, undefined, undefined).length, 3);
});
