import {
	formatDelegationModel,
	type DelegationModel,
	type ModelRoutingHint,
} from "./helpers.ts";

const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const JEV_MODEL = "jev-latest";
const SECURITY_THRESHOLD = 0.5;

interface ChoiceAnswer {
	type: "choice";
	choice: string;
	confidence: number;
}

interface NoulAnswer {
	type: "noul";
	noul: number;
}

export interface JevRoutingResponse {
	model: string;
	answers: {
		capability: ChoiceAnswer;
		economy: ChoiceAnswer;
		security_sensitive: NoulAnswer;
	};
	usage?: { input_tokens?: number; output_tokens?: number };
}

export interface JevRoutingResult {
	entry: DelegationModel;
	policy: "capability" | "economy";
	securitySensitive: number;
	model: string;
	confidence: number;
	usage?: { input_tokens?: number; output_tokens?: number };
	elapsedMs: number;
}

function hasPrices(entry: DelegationModel): boolean {
	return (entry.model.cost?.input ?? 0) !== 0 || (entry.model.cost?.output ?? 0) !== 0;
}

function candidateDescriptions(
	pool: DelegationModel[],
	hints: Record<string, ModelRoutingHint>,
): { criteria: Record<string, string>; byId: Map<string, DelegationModel> } {
	const priced = pool
		.filter(hasPrices)
		.toSorted((a, b) =>
			(a.model.cost?.input ?? 0) + (a.model.cost?.output ?? 0) -
			((b.model.cost?.input ?? 0) + (b.model.cost?.output ?? 0)),
		);
	const priceRank = new Map(priced.map((entry, index) => [entry.selector, index + 1]));
	const criteria: Record<string, string> = {};
	const byId = new Map<string, DelegationModel>();

	pool.forEach((entry, index) => {
		const id = `m${index}`;
		const hint = hints[entry.selector];
		const rank = priceRank.get(entry.selector);
		const rankText = rank ? `; cost rank ${rank} of ${priced.length} priced candidates (1 is cheapest)` : "";
		criteria[id] = `${formatDelegationModel(entry, hint).slice(2)}${rankText}`;
		byId.set(id, entry);
	});

	return { criteria, byId };
}

export function buildJevRoutingRequest(
	task: string,
	pool: DelegationModel[],
	hints: Record<string, ModelRoutingHint>,
): { request: Record<string, unknown>; byId: Map<string, DelegationModel> } {
	if (pool.length === 0) throw new Error("Jev model routing requires at least one eligible model");
	const { criteria, byId } = candidateDescriptions(pool, hints);
	return {
		request: {
			model: JEV_MODEL,
			state: { task },
			questions: {
				capability: {
					type: "choice",
					instructions:
						"Which model is the best capability fit for this software-engineering task? Judge correctness and risk, not price.",
					criteria,
				},
				economy: {
					type: "choice",
					instructions:
						"Which is the cheapest model that can reliably complete this software-engineering task? Do not trade away correctness, security, or required reasoning capability to save cost.",
					criteria,
				},
				security_sensitive: {
					type: "noul",
					instructions:
						"Does this task directly change authentication, authorization, credential storage, encryption, payments, privacy boundaries, or destructive data operations?",
				},
			},
		},
		byId,
	};
}

function choiceAnswer(value: unknown, name: string, byId: Map<string, DelegationModel>): ChoiceAnswer {
	if (!value || typeof value !== "object") throw new Error(`Jev returned an invalid ${name} answer`);
	const answer = value as Partial<ChoiceAnswer>;
	if (
		answer.type !== "choice" ||
		typeof answer.choice !== "string" ||
		!byId.has(answer.choice) ||
		typeof answer.confidence !== "number" ||
		!Number.isFinite(answer.confidence) ||
		answer.confidence < 0 ||
		answer.confidence > 1
	) {
		throw new Error(`Jev returned an invalid ${name} answer`);
	}
	return answer as ChoiceAnswer;
}

export function selectJevModel(
	response: unknown,
	byId: Map<string, DelegationModel>,
): Omit<JevRoutingResult, "elapsedMs"> {
	if (!response || typeof response !== "object") throw new Error("Jev returned an invalid response");
	const payload = response as Partial<JevRoutingResponse>;
	if (!payload.answers || typeof payload.answers !== "object") throw new Error("Jev response did not include answers");
	const capability = choiceAnswer(payload.answers.capability, "capability", byId);
	const economy = choiceAnswer(payload.answers.economy, "economy", byId);
	const security = payload.answers.security_sensitive;
	if (
		!security ||
		security.type !== "noul" ||
		typeof security.noul !== "number" ||
		!Number.isFinite(security.noul) ||
		security.noul < 0 ||
		security.noul > 1
	) {
		throw new Error("Jev returned an invalid security_sensitive answer");
	}

	const policy = security.noul >= SECURITY_THRESHOLD ? "capability" : "economy";
	const selected = policy === "capability" ? capability : economy;
	return {
		entry: byId.get(selected.choice)!,
		policy,
		securitySensitive: security.noul,
		model: typeof payload.model === "string" ? payload.model : JEV_MODEL,
		confidence: selected.confidence,
		usage: payload.usage,
	};
}

export async function routeModelWithJev(
	task: string,
	pool: DelegationModel[],
	hints: Record<string, ModelRoutingHint>,
	apiKey: string | undefined,
	signal?: AbortSignal,
): Promise<JevRoutingResult> {
	if (!apiKey) throw new Error("modelRouter is jev but jevApiKey is not configured in supersubs.json");
	const { request, byId } = buildJevRoutingRequest(task, pool, hints);
	const startedAt = Date.now();
	const requestSignal = signal
		? AbortSignal.any([signal, AbortSignal.timeout(5000)])
		: AbortSignal.timeout(5000);

	let response: Response;
	try {
		response = await fetch(JEV_ENDPOINT, {
			method: "POST",
			signal: requestSignal,
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(request),
		});
	} catch (error) {
		throw new Error(`Jev model routing failed: ${error instanceof Error ? error.message : String(error)}`);
	}

	if (!response.ok) throw new Error(`Jev model routing failed with HTTP ${response.status}`);

	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		throw new Error("Jev model routing returned invalid JSON");
	}
	return { ...selectJevModel(payload, byId), elapsedMs: Date.now() - startedAt };
}
