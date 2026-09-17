// Pure rendering: tree model → terminal rows with ANSI colors.
import type { TreeNode } from "./graph.ts";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const MAGENTA = "\x1b[35m";

const STATUS_STYLE: Record<string, [string, string]> = {
	working: [`${CYAN}●${RESET}`, "working"],
	blocked: [`${RED}✗${RESET}`, "blocked"],
	done: [`${GREEN}✓${RESET}`, "done"],
	idle: [`${DIM}○${RESET}`, "idle"],
	unknown: [`${YELLOW}?${RESET}`, "unknown"],
};

export interface RenderState {
	expanded: Set<string>;
	selectedPaneId: string | undefined;
	connected: boolean;
}

/** One display row per line: [paneId, ansiText]. */
export function renderTree(
	roots: TreeNode[],
	unattached: TreeNode[],
	workspaceLabels: Map<string, string>,
	rootWorkspaceId: string | undefined,
	state: RenderState,
	width: number,
): Array<[string, string]> {
	const rows: Array<[string, string]> = [];

	function statusText(node: TreeNode): string {
		const [symbol, name] = STATUS_STYLE[node.status ?? "unknown"] ?? STATUS_STYLE.unknown;
		const invalid = node.invalid ? ` ${RED}[${node.invalid}]${RESET}` : "";
		const workspace =
			rootWorkspaceId && node.workspace_id !== rootWorkspaceId
				? ` ${DIM}· ${workspaceLabels.get(node.workspace_id) ?? node.workspace_id}${RESET}`
				: "";
		const extras = [node.model, node.thinking && `${node.thinking} thinking`].filter(Boolean).join(", ");
		const detail = extras ? ` ${DIM}(${extras})${RESET}` : "";
		return `${symbol} ${name}${invalid}${workspace}${detail}`;
	}

	function walk(node: TreeNode, prefix: string, isLast: boolean, isRoot: boolean): void {
		const selected = node.pane_id === state.selectedPaneId;
		const connector = isRoot ? "" : `${prefix}${isLast ? "└─ " : "├─ "}`;
		const hasChildren = node.children.length > 0;
		const expanded = hasChildren && state.expanded.has(node.pane_id);
		const toggle = hasChildren ? (expanded ? `${DIM}▼${RESET} ` : `${DIM}▶${RESET} `) : "  ";
		const label = `${selected ? `${BOLD}${CYAN}` : ""}${truncate(node.label, Math.max(12, width - 60))}${selected ? RESET : ""}`;
		rows.push([node.pane_id, `${connector}${toggle}${label} ${statusText(node)}`]);
		if (!expanded) return;
		const childPrefix = isRoot ? "" : `${prefix}${isLast ? "   " : "│  "}`;
		node.children.forEach((child, index) => walk(child, childPrefix, index === node.children.length - 1, false));
	}

	for (const root of roots) walk(root, "", true, true);

	if (unattached.length > 0) {
		rows.push(["", `${BOLD}Unattached${RESET}`]);
		for (const node of unattached) walk(node, "  ", true, false);
	}

	return rows;
}

/** Full frame: status header, rows, key hints footer. */
export function renderFrame(rows: Array<[string, string]>, title: string, state: RenderState, height: number, width: number): string {
	const lines: string[] = [];
	const inner = height - 2;

	lines.push(`${BOLD}${title}${RESET}${state.connected ? "" : ` ${RED}(herdr disconnected — retrying)${RESET}`}`);
	const body = rows.slice(0, Math.max(0, inner - 2));
	for (const [, text] of body) lines.push(` ${text}`);
	if (rows.length === 0) lines.push(` ${DIM}No delegation trees in scope.${RESET}`);
	while (lines.length < inner) lines.push("");

	const hints = `${DIM}j/k move · h/l collapse · space toggle · enter focus · v agent-view · r refresh · q close${RESET}`;
	lines.push(hints.slice(0, width));

	return `\x1b[H\x1b[2J${lines.join("\r\n")}`;
}

function truncate(text: string, width: number): string {
	return text.length <= width ? text : `${text.slice(0, Math.max(1, width - 1))}…`;
}
