// Impure shell: socket I/O, snapshot polling, raw keyboard, redraw loop.
import { createConnection, type Socket } from "node:net";
import {
	buildTree,
	resolveScope,
	type NodeInput,
	type TreeNode,
	type TreeResult,
} from "./graph.ts";
import { renderFrame, renderTree } from "./render.ts";

interface SocketClient {
	request(method: string, params: Record<string, unknown>): Promise<any>;
	close(): void;
}

function connectSocket(): SocketClient {
	const socketPath = process.env.HERDR_SOCKET_PATH;
	if (!socketPath) throw new Error("HERDR_SOCKET_PATH is not set");

	const socket: Socket = createConnection(socketPath);
	socket.setEncoding("utf8");
	let nextId = 0;
	const pending = new Map<string, { resolve(value: any): void; reject(error: Error): void }>();
	let buffer = "";

	socket.on("data", (chunk) => {
		buffer += chunk.toString("utf8");
		for (;;) {
			const newline = buffer.indexOf("\n");
			if (newline < 0) break;
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			let message: any;
			try {
				message = JSON.parse(line);
			} catch {
				continue;
			}
			const waiter = pending.get(message.id);
			if (waiter) {
				pending.delete(message.id);
				if (message.error) waiter.reject(new Error(`${message.error.code ?? "herdr_error"}: ${message.error.message ?? ""}`));
				else waiter.resolve(message.result);
			}
		}
	});

	return {
		request(method, params) {
			return new Promise((resolve, reject) => {
				const id = `req-${nextId++}`;
				pending.set(id, { resolve, reject });
				socket.write(`${JSON.stringify({ id, method, params })}\n`);
			});
		},
		close() {
			socket?.destroy();
		},
	};
}

interface PaneRecord {
	workspace_id: string;
	status: string | null;
	label: string | null;
	order: number;
	tokens: Record<string, string>;
}

function recordFromPane(pane: any, order: number): PaneRecord {
	return {
		workspace_id: pane.workspace_id,
		status: pane.agent_status ?? null,
		label: pane.display_agent ?? pane.label ?? pane.title ?? null,
		order,
		tokens: pane.tokens ?? {},
	};
}

function inputsFromTreeUi(records: Map<string, PaneRecord>): NodeInput[] {
	return [...records.entries()].map(([paneId, record]) => ({ pane_id: paneId, ...record }));
}

class TreeUi {
	readonly scopePaneId: string | undefined;
	readonly scopeWorkspaceId: string | undefined;
	records = new Map<string, PaneRecord>();
	workspaceLabels = new Map<string, string>();
	expanded = new Set<string>();
	selectedPaneId: string | undefined;
	connected = false;
	tree: TreeResult = { roots: [], unattached: [], byPaneId: new Map() };

	constructor(context: any) {
		this.scopePaneId = context?.focused_pane_id ?? undefined;
		this.scopeWorkspaceId = context?.workspace_id ?? undefined;
	}

	applySnapshot(snapshot: any): void {
		this.workspaceLabels = new Map((snapshot.workspaces ?? []).map((workspace: any) => [workspace.workspace_id, workspace.label]));
		const order = new Map<string, number>();
		for (const [index, pane] of (snapshot.panes ?? []).entries()) order.set(pane.pane_id, index);
		this.records = new Map(
			(snapshot.agents ?? []).map((agent: any, index: number) => [
				agent.pane_id,
				recordFromPane(agent, order.get(agent.pane_id) ?? (snapshot.panes?.length ?? 0) + index),
			]),
		);
		this.rebuild();
		this.connected = true;
	}

	rebuild(): void {
		this.tree = buildTree(inputsFromTreeUi(this.records));
	}

	scope(): TreeNode[] {
		return resolveScope(this.tree, this.scopePaneId, this.scopeWorkspaceId);
	}

	draw(): void {
		const roots = this.scope();
		const rootWorkspaceId = roots[0]?.workspace_id;
		const rows = renderTree(roots, this.tree.unattached, this.workspaceLabels, rootWorkspaceId, {
			expanded: this.expanded,
			selectedPaneId: this.selectedPaneId,
			connected: this.connected,
		}, process.stdout.columns ?? 80);

		// Auto-select the first visible row after the tree changes shape.
		if (!rows.some(([paneId]) => paneId === this.selectedPaneId)) {
			this.selectedPaneId = rows.find(([paneId]) => paneId)?.[0];
		}

		const title = roots.length === 1 ? `${roots[0].label} — delegation tree` : `Delegation trees (${roots.length})`;
		process.stdout.write(renderFrame(rows, title, this, process.stdout.rows ?? 24, process.stdout.columns ?? 80));
	}

	toggleExpand(paneId: string): void {
		if (this.expanded.has(paneId)) this.expanded.delete(paneId);
		else this.expanded.add(paneId);
	}
}

function stateKey(ui: TreeUi): string {
	return JSON.stringify({
		records: [...ui.records.entries()],
		labels: [...ui.workspaceLabels.entries()],
		connected: ui.connected,
	});
}

async function main(): Promise<void> {
	const context = process.env.HERDR_PLUGIN_CONTEXT_JSON ? JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON) : undefined;
	const ui = new TreeUi(context);
	let client: SocketClient | undefined;
	let closing = false;

	function reconnect(backoffMs: number): void {
		if (closing) return;
		ui.connected = false;
		ui.draw();
		setTimeout(() => {
			start().catch(() => reconnect(Math.min(backoffMs * 2, 5_000)));
		}, backoffMs);
	}

	// ponytail: 2s snapshot polling instead of event subscription — Herdr 0.8.2 rejects
	// global pane.agent_status_changed subscriptions (requires pane_id), so a live event
	// pump is not viable yet. Switch to events.subscribe when that constraint lifts.
	async function start(): Promise<void> {
		client?.close();
		client = connectSocket();
		ui.applySnapshot(await client.request("session.snapshot", {}));
		ui.draw();
	}

	// Raw keyboard + alt screen.
	process.stdout.write("\x1b[?1049h\x1b[?25l");
	process.stdin.setRawMode(true);
	process.stdin.resume();
	process.stdout.on("resize", () => ui.draw());

	const shutdown = (code: number): never => {
		closing = true;
		process.stdout.write("\x1b[?25h\x1b[?1049l");
		process.exit(code);
	};

	process.on("SIGINT", () => shutdown(130));
	process.on("SIGTERM", () => shutdown(143));

	const poll = setInterval(async () => {
		if (closing || !client) return;
		try {
			const before = stateKey(ui);
			ui.applySnapshot(await client.request("session.snapshot", {}));
			if (stateKey(ui) !== before) ui.draw();
		} catch {
			clearInterval(poll);
			reconnect(500);
		}
	}, 2_000);

	process.stdin.on("data", (data: Buffer) => {
		const key = data.toString("utf8");
		const rows = renderTree(ui.scope(), ui.tree.unattached, ui.workspaceLabels, ui.scope()[0]?.workspace_id, {
			expanded: ui.expanded,
			selectedPaneId: ui.selectedPaneId,
			connected: true,
		}, 200);
		const selectable = rows.filter(([paneId]) => paneId);
		const index = selectable.findIndex(([paneId]) => paneId === ui.selectedPaneId);

		const move = (delta: number): void => {
			if (selectable.length === 0) return;
			const next = Math.min(selectable.length - 1, Math.max(0, index + delta));
			ui.selectedPaneId = selectable[next][0];
			ui.draw();
		};

		if (key === "q" || key === "\x1b" || key === "\x03") return shutdown(0);
		if (key === "j" || key === "\x1b[B") return move(1);
		if (key === "k" || key === "\x1b[A") return move(-1);
		if (key === "v" && client) {
			// Flat projection of Herdr's built-in Agents view: delegation participants only,
			// sorted by the DFS-order token the extension reports. Cosmetic; see spec §16.
			client
				.request("agent.view.set", {
					source: "subagents.tree",
					label: "delegation tree",
					filter: { op: "exists", field: { token: "delegation_root" } },
					sort: [{ field: { token: "delegation_path" }, order: "asc" }],
				})
				.catch(() => undefined);
			return;
		}
		if (key === "V" && client) {
			client.request("agent.view.clear", { source: "subagents.tree" }).catch(() => undefined);
			return;
		}
		if (key === "r") {
			reconnect(0);
			return;
		}
		if (key === " " || key === "\x1b[C" || key === "\x1b[D") {
			if (ui.selectedPaneId) ui.toggleExpand(ui.selectedPaneId);
			ui.draw();
			return;
		}
		if (key === "\r" || key === "\n") {
			if (ui.selectedPaneId && client) {
				client.request("agent.focus", { target: ui.selectedPaneId }).catch(() => undefined);
			}
			return;
		}
		// h/l also collapse/expand (spec §8); arrows left/right share the space handler above.
		if ((key === "h" || key === "l") && ui.selectedPaneId) {
			const node = ui.tree.byPaneId.get(ui.selectedPaneId);
			if (node?.children.length) {
				ui.toggleExpand(ui.selectedPaneId);
				ui.draw();
			}
		}
	});

	try {
		await start();
	} catch {
		// Server not reachable yet (e.g. opened before the socket existed): retry instead of dying.
		reconnect(500);
	}

	// Keep the process alive: stdin is resumed, redraws are poll-driven.
	setInterval(() => {}, 1 << 30);
}

await main();
