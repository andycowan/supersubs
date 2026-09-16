import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { ChildChannelMessage, SupervisorChannelMessage } from "./supervisor-channel.ts";

const channelPath = process.env.PI_SUBAGENT_CHANNEL;
const childName = process.env.PI_SUBAGENT_NAME || "subagent";

export default function (pi: ExtensionAPI) {
	if (!channelPath) return;

	let socket: Socket | undefined;
	let connectionError: Error | undefined;
	let settleConnected: (() => void) | undefined;
	const connected = new Promise<void>((resolve) => {
		settleConnected = resolve;
	});
	const pending = new Map<string, { resolve(message: string): void; reject(error: Error): void }>();

	function rejectPending(error: Error): void {
		for (const waiter of pending.values()) waiter.reject(error);
		pending.clear();
	}

	function handleMessage(message: SupervisorChannelMessage): void {
		if (message.type === "answer" && typeof message.requestId === "string" && typeof message.message === "string") {
			pending.get(message.requestId)?.resolve(message.message);
			pending.delete(message.requestId);
			return;
		}
		if (message.type !== "message" || typeof message.message !== "string") return;
		pi.sendMessage(
			{
				customType: "subagent-supervisor-message",
				content: `**Message from supervisor:**\n\n${message.message}`,
				display: true,
			},
			{ triggerTurn: true, deliverAs: "steer" },
		);
	}

	pi.on("session_start", () => {
		socket = createConnection(channelPath);
		let buffer = "";
		socket.setEncoding("utf8");
		socket.once("connect", () => settleConnected?.());
		socket.on("data", (chunk) => {
			buffer += chunk;
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) break;
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				try {
					handleMessage(JSON.parse(line) as SupervisorChannelMessage);
				} catch {
					// Ignore malformed frames from the private local channel.
				}
			}
		});
		socket.on("error", (error) => {
			connectionError = error;
			settleConnected?.();
			rejectPending(error);
		});
		socket.on("close", () => {
			settleConnected?.();
			rejectPending(new Error("Supervisor message channel closed"));
		});
	});

	pi.on("session_shutdown", () => {
		rejectPending(new Error("Subagent session ended"));
		socket?.destroy();
	});

	async function send(message: ChildChannelMessage): Promise<void> {
		await connected;
		if (connectionError) throw connectionError;
		if (!socket || socket.destroyed) throw new Error("Supervisor message channel is not connected");
		socket.write(`${JSON.stringify(message)}\n`);
	}

	pi.registerTool({
		name: "contact_supervisor",
		label: "Contact Supervisor",
		description:
			"Contact the parent agent that delegated this task. Use need_decision only when blocked and unable to continue safely; it waits for an answer. Use progress_update only for a meaningful discovery that changes the plan; it returns immediately. Return routine completion through the normal final response.",
		promptSnippet: "Contact the parent for a blocking decision or meaningful plan-changing update",
		promptGuidelines: [
			"Use contact_supervisor with reason='need_decision' only when blocked and unable to continue safely without the parent's answer.",
			"Use contact_supervisor with reason='progress_update' only for meaningful discoveries that change the plan, not routine narration or completion.",
		],
		parameters: Type.Object({
			reason: StringEnum(["need_decision", "progress_update"] as const),
			message: Type.String({ minLength: 1, maxLength: 20_000 }),
		}),
		async execute(_toolCallId, params, signal) {
			const message = params.message.trim();
			if (!message) throw new Error("Message must contain visible characters");
			if (params.reason === "progress_update") {
				await send({ type: "progress_update", message });
				return {
					content: [{ type: "text", text: `Progress update sent to supervisor from ${childName}.` }],
					details: { delivered: true },
				};
			}

			const requestId = randomUUID();
			let abort: (() => void) | undefined;
			const reply = new Promise<string>((resolve, reject) => {
				pending.set(requestId, { resolve, reject });
				abort = () => reject(new Error("Supervisor request cancelled"));
				signal?.addEventListener("abort", abort, { once: true });
			});
			reply.catch(() => undefined);
			try {
				await send({ type: "need_decision", requestId, message });
				const answer = await reply;
				return {
					content: [{ type: "text", text: `**Reply from supervisor:**\n\n${answer}` }],
					details: { requestId, delivered: true },
				};
			} finally {
				pending.delete(requestId);
				if (abort) signal?.removeEventListener("abort", abort);
			}
		},
	});
}
