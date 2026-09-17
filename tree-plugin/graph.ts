// Pure graph construction: agents + delegation tokens → validated tree.
// Relationship rules follow docs/herdr-subagent-tree-plugin-spec.md §7.

export interface NodeInput {
	pane_id: string;
	workspace_id: string;
	status: string | null;
	label: string | null;
	order: number;
	tokens: Record<string, string>;
}

export type InvalidReason = "cycle" | "duplicate";

export interface TreeNode {
	pane_id: string;
	workspace_id: string;
	root_pane_id: string;
	parent_pane_id?: string;
	delegation_id?: string;
	depth: number;
	label: string;
	model?: string;
	thinking?: string;
	status: string | null;
	order: number;
	children: TreeNode[];
	invalid?: InvalidReason;
}

export interface TreeResult {
	roots: TreeNode[];
	unattached: TreeNode[];
	byPaneId: Map<string, TreeNode>;
}

function cleanLabel(value: string): string {
	return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
}

function isRoot(node: NodeInput): boolean {
	return node.tokens.delegation_root === node.pane_id && !node.tokens.delegation_parent;
}

function isDelegated(node: NodeInput): boolean {
	return Boolean(node.tokens.delegation_root || node.tokens.delegation_parent);
}

/** Build the delegation forest. Only delegation-rooted agents participate; standalone agents are ignored. */
export function buildTree(inputs: NodeInput[]): TreeResult {
	const byId = new Map(inputs.map((node) => [node.pane_id, node]));
	const participants = inputs.filter((node) => isRoot(node) || isDelegated(node));

	// Parent links: attach only when the parent is a known delegated agent pane.
	const parentOf = new Map<string, string>();
	for (const node of participants) {
		const parent = node.tokens.delegation_parent;
		if (!parent || parent === node.pane_id || !byId.has(parent)) continue;
		if (!byId.get(parent)!.tokens.delegation_root) continue; // non-agent or unrelated parent pane
		parentOf.set(node.pane_id, parent);
	}

	// Cycles: each child has at most one parent, so cycles are disjoint rings.
	// Break each ring at the edge whose child pane ID sorts last (spec §7).
	const cycleMembers = new Set<string>();
	const cycles: string[][] = [];
	{
		const state = new Map<string, 0 | 1 | 2>(); // 0 unvisited, 1 on stack, 2 done
		const visit = (id: string, stack: string[]): void => {
			const mark = state.get(id) ?? 0;
			if (mark === 1) cycles.push(stack.slice(stack.indexOf(id)));
			if (mark !== 0) return;
			state.set(id, 1);
			const parent = parentOf.get(id);
			if (parent) visit(parent, [...stack, id]);
			state.set(id, 2);
		};
		for (const node of participants) visit(node.pane_id, []);
		for (const cycle of cycles) {
			for (const member of cycle) cycleMembers.add(member);
			parentOf.delete(cycle.reduce((a, b) => (b > a ? b : a)));
		}
	}

	// Duplicate delegation_id under one root: mark every node sharing the duplicated ID.
	const duplicateKeys = new Set<string>();
	{
		const seenPerRoot = new Map<string, Set<string>>();
		for (const node of participants) {
			const root = node.tokens.delegation_root;
			const id = node.tokens.delegation_id;
			if (!root || !id) continue;
			const seen = seenPerRoot.get(root) ?? new Set<string>();
			if (seen.has(id)) duplicateKeys.add(`${root}\u0000${id}`);
			seen.add(id);
			seenPerRoot.set(root, seen);
		}
	}

	const nodes = new Map<string, TreeNode>();
	for (const node of participants) {
		const id = node.tokens.delegation_id;
		const invalid: InvalidReason | undefined =
			id && duplicateKeys.has(`${node.tokens.delegation_root}\u0000${id}`)
				? "duplicate"
				: cycleMembers.has(node.pane_id)
					? "cycle"
					: undefined;
		nodes.set(node.pane_id, {
			pane_id: node.pane_id,
			workspace_id: node.workspace_id,
			root_pane_id: node.tokens.delegation_root || node.pane_id,
			parent_pane_id: parentOf.get(node.pane_id),
			delegation_id: node.tokens.delegation_id,
			depth: 0,
			label: cleanLabel(node.tokens.delegation_label || node.label || "") || node.pane_id,
			model: cleanLabel(node.tokens.delegation_model || "") || undefined,
			thinking: cleanLabel(node.tokens.delegation_thinking || "") || undefined,
			status: node.status,
			order: node.order,
			children: [],
			invalid,
		});
	}

	for (const [childId, parentId] of parentOf) nodes.get(parentId)!.children.push(nodes.get(childId)!);

	// Walk each top node (no parent edge) and assign depths from the parent links.
	const roots: TreeNode[] = [];
	const unattached: TreeNode[] = [];
	const visited = new Set<string>();

	function finalize(node: TreeNode, depth: number): void {
		node.depth = depth;
		visited.add(node.pane_id);
		node.children.sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
		for (const child of node.children) finalize(child, depth + 1);
	}

	for (const node of nodes.values()) {
		if (parentOf.has(node.pane_id) || visited.has(node.pane_id)) continue;
		finalize(node, 0);
		if (isRoot(byId.get(node.pane_id)!)) {
			roots.push(node);
		} else {
			// Has a delegation_parent token but the parent is unknown/not an agent (or a cut cycle edge).
			unattached.push(node);
		}
	}

	roots.sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
	unattached.sort((a, b) => a.order - b.order);
	return { roots, unattached, byPaneId: nodes };
}

/** Scope resolution (spec §8): focused root tree → roots in the focused workspace → all roots. */
export function resolveScope(result: TreeResult, contextPaneId: string | undefined, contextWorkspaceId: string | undefined): TreeNode[] {
	if (contextPaneId) {
		const node = result.byPaneId.get(contextPaneId);
		const root = node && result.roots.find((candidate) => candidate.root_pane_id === node.root_pane_id);
		if (root) return [root];
	}
	if (contextWorkspaceId) {
		const inWorkspace = result.roots.filter((root) => root.workspace_id === contextWorkspaceId);
		if (inWorkspace.length > 0) return inWorkspace;
	}
	return result.roots;
}
