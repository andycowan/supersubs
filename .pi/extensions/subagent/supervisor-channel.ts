import { chmod, unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

export type ChildChannelMessage =
	| { type: "progress_update"; message: string }
	| { type: "need_decision"; requestId: string; message: string };

export type SupervisorChannelMessage =
	| { type: "message"; message: string }
	| { type: "answer"; requestId: string; message: string };

export interface SupervisorChannel {
	path: string;
	send(message: SupervisorChannelMessage): void;
	close(): Promise<void>;
}

function socketPath(id: string): string {
	return process.platform === "win32"
		? `\\\\.\\pipe\\pi-subagent-${id}`
		: path.join(tmpdir(), `pi-sa-${id.slice(0, 12)}.sock`);
}

function isChildMessage(value: unknown): value is ChildChannelMessage {
	if (!value || typeof value !== "object") return false;
	const message = value as Record<string, unknown>;
	return (
		(message.type === "progress_update" && typeof message.message === "string") ||
		(message.type === "need_decision" && typeof message.requestId === "string" && typeof message.message === "string")
	);
}

export async function createSupervisorChannel(
	id: string,
	onMessage: (message: ChildChannelMessage) => void,
): Promise<SupervisorChannel> {
	const address = socketPath(id);
	if (process.platform !== "win32") await unlink(address).catch(() => undefined);

	let child: Socket | undefined;
	const server: Server = createServer((socket) => {
		child?.destroy();
		child = socket;
		let buffer = "";
		socket.setEncoding("utf8");
		socket.on("data", (chunk) => {
			buffer += chunk;
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) break;
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				try {
					const message: unknown = JSON.parse(line);
					if (isChildMessage(message)) onMessage(message);
				} catch {
					// Ignore malformed frames from the private local channel.
				}
			}
		});
		socket.on("close", () => {
			if (child === socket) child = undefined;
		});
		socket.on("error", () => undefined);
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(address, () => {
			server.off("error", reject);
			resolve();
		});
	});
	server.on("error", () => undefined);
	let closed = false;
	async function close(): Promise<void> {
		if (closed) return;
		closed = true;
		child?.destroy();
		if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
		if (process.platform !== "win32") await unlink(address).catch(() => undefined);
	}

	try {
		if (process.platform !== "win32") await chmod(address, 0o600);
	} catch (error) {
		await close();
		throw error;
	}

	return {
		path: address,
		send(message) {
			if (!child || child.destroyed) throw new Error("Subagent message channel is not connected");
			child.write(`${JSON.stringify(message)}\n`);
		},
		close,
	};
}
