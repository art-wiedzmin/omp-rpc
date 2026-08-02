import { getStatsDbPath } from "@oh-my-pi/pi-utils";
import { Client } from "@xhayper/discord-rpc";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { Database } from "bun:sqlite";
import * as path from "node:path";

type FirstLineConfig = Readonly<{
	showProject: boolean;
	showModel: boolean;
	showEffort: boolean;
	showSession: boolean;
}>;

type SecondLineConfig = Readonly<{
	showRequests: boolean;
	showTokens: boolean;
	showCost: boolean;
}>;

type RpcConfig = Readonly<{
	clientId: string;
	activityName: string;
	showTool: boolean;
	firstLine: FirstLineConfig;
	secondLine: SecondLineConfig;
}>;

type DailyStats = Readonly<{
	requests: number;
	tokens: number;
	cost: number;
}>;

const RECONNECT_INTERVAL_MS = 15_000;
const LINE_ROTATION_INTERVAL_MS = 5_000;
const STATS_REFRESH_INTERVAL_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1_000;
const DISCORD_TEXT_LIMIT = 128;
const CLIENT_ID_PATTERN = /^\d{17,20}$/;
const COMPACT_NUMBER_FORMATTER = new Intl.NumberFormat("en-US", {
	notation: "compact",
	maximumFractionDigits: 1,
});
const COST_FORMATTER = new Intl.NumberFormat("en-US", {
	style: "currency",
	currency: "USD",
	minimumFractionDigits: 2,
	maximumFractionDigits: 2,
});


function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export default function discordRpcExtension(pi: ExtensionAPI) {
	const configSchema = pi.zod
		.object({
			clientId: pi.zod.string().trim().optional().default(""),
			activityName: pi.zod.string().trim().min(2).max(DISCORD_TEXT_LIMIT).optional().default("Oh My Pi"),
			showTool: pi.zod.boolean().optional().default(false),
			firstLine: pi.zod
				.object({
					showProject: pi.zod.boolean().optional().default(false),
					showModel: pi.zod.boolean().optional().default(false),
					showEffort: pi.zod.boolean().optional().default(false),
					showSession: pi.zod.boolean().optional().default(false),
				})
				.strict()
				.optional()
				.default({
					showProject: false,
					showModel: false,
					showEffort: false,
					showSession: false,
				}),
			secondLine: pi.zod
				.object({
					showRequests: pi.zod.boolean().optional().default(false),
					showTokens: pi.zod.boolean().optional().default(false),
					showCost: pi.zod.boolean().optional().default(false),
				})
				.strict()
				.optional()
				.default({
					showRequests: false,
					showTokens: false,
					showCost: false,
				}),
		})
		.strict();
	let client: Client | undefined;
	let config: RpcConfig | undefined;
	let currentContext: ExtensionContext | undefined;
	const activeTools = new Map<string, string>();
	let dailyStats: DailyStats | undefined;
	let showSecondLine = false;
	let statsReadFailureLogged = false;
	let sessionStartedAt = Date.now();
	let working = false;
	let connecting = false;
	let stopped = false;
	let warnedConnectionFailure = false;
	let publishVersion = 0;
	let publishQueue = Promise.resolve();

	const loadConfig = async (): Promise<RpcConfig | undefined> => {
		let value: unknown = {};
		try {
			value = await Bun.file(new URL("./config.json", import.meta.url)).json();
		} catch (error) {
			const code = error instanceof Error && "code" in error ? error.code : undefined;
			if (code !== "ENOENT") {
				pi.logger.warn("Discord RPC config could not be read", { error: errorMessage(error) });
				return undefined;
			}
		}
		const parsed = configSchema.safeParse(value);
		if (!parsed.success) {
			pi.logger.warn("Discord RPC is disabled by invalid configuration", { error: parsed.error.message });
			return undefined;
		}
		const clientId = parsed.data.clientId || Bun.env.OMP_DISCORD_CLIENT_ID?.trim() || "";
		if (!CLIENT_ID_PATTERN.test(clientId)) {
			pi.logger.warn("Discord RPC is disabled by invalid configuration", {
				error: "clientId must be a 17-20 digit Discord application ID",
			});
			return undefined;
		}
		return {
			...parsed.data,
			clientId,
		};
	};

	const refreshStats = (): void => {
		if (
			!config ||
			(!config.secondLine.showRequests && !config.secondLine.showTokens && !config.secondLine.showCost)
		) {
			dailyStats = undefined;
			return;
		}
		let db: Database | undefined;
		try {
			db = new Database(getStatsDbPath(), { readonly: true, create: false });
			const row = db
				.query<DailyStats, [number]>(`
					SELECT
						COUNT(*) AS requests,
						COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens,
						COALESCE(SUM(cost_total), 0) AS cost
					FROM messages
					WHERE timestamp >= ?
				`)
				.get(Date.now() - DAY_MS);
			if (row) dailyStats = row;
			statsReadFailureLogged = false;
		} catch (error) {
			if (!statsReadFailureLogged) {
				pi.logger.debug("Discord RPC stats read failed", { error: errorMessage(error) });
				statsReadFailureLogged = true;
			}
		} finally {
			db?.close(false);
		}
	};

	const queuePresenceUpdate = (ctx: ExtensionContext): void => {
		currentContext = ctx;
		const version = ++publishVersion;
		publishQueue = publishQueue
			.then(async () => {
				if (version !== publishVersion || stopped || !config || !client?.isConnected || !client.user) return;
				const firstLineParts: string[] = [];
				if (config.firstLine.showProject) firstLineParts.push(`Project: ${path.basename(ctx.cwd)}`);
				const effort = config.firstLine.showEffort ? pi.getThinkingLevel() : undefined;
				if (config.firstLine.showModel) {
					const model = ctx.models.current();
					if (model) firstLineParts.push(`Model: ${model.name}${effort ? ` • ${effort}` : ""}`);
				} else if (effort) {
					firstLineParts.push(`Effort: ${effort}`);
				}
				if (config.firstLine.showSession) {
					const sessionName = pi.getSessionName()?.trim();
					if (sessionName) firstLineParts.push(`Session: ${sessionName}`);
				}
				const secondLineParts: string[] = [];
				if (dailyStats && config.secondLine.showRequests) {
					const requestLabel = dailyStats.requests === 1 ? "rqst" : "rqsts";
					secondLineParts.push(`${COMPACT_NUMBER_FORMATTER.format(dailyStats.requests)} ${requestLabel}`);
				}
				if (dailyStats && config.secondLine.showTokens) {
					secondLineParts.push(`${COMPACT_NUMBER_FORMATTER.format(dailyStats.tokens)} tkns`);
				}
				if (dailyStats && config.secondLine.showCost) {
					secondLineParts.push(COST_FORMATTER.format(dailyStats.cost));
				}
				let activeToolName: string | undefined;
				if (config.showTool) {
					for (const toolName of activeTools.values()) activeToolName = toolName;
				}
				const toolName = activeToolName?.replaceAll("_", " ").trim();
				const details = (toolName ? `Using ${toolName}` : working ? "Working with OMP" : "Idle in OMP")
					.trim()
					.slice(0, DISCORD_TEXT_LIMIT);
				const firstLine = firstLineParts.join(" | ") || "OMP coding session";
				const secondLine = secondLineParts.length > 0 ? `24h: ${secondLineParts.join(" • ")}` : undefined;
				const state = (showSecondLine && secondLine ? secondLine : firstLine).trim().slice(0, DISCORD_TEXT_LIMIT);
				await client.user.setActivity({
					name: config.activityName,
					details,
					state,
					startTimestamp: new Date(sessionStartedAt),
					instance: false,
				});
			})
			.catch(error => {
				pi.logger.debug("Discord RPC presence update failed", { error: errorMessage(error) });
			});
	};

	const disconnect = async (): Promise<void> => {
		const activeClient = client;
		client = undefined;
		publishVersion++;
		if (!activeClient) return;
		try {
			if (activeClient.isConnected && activeClient.user) await activeClient.user.clearActivity();
		} catch (error) {
			pi.logger.debug("Discord RPC activity cleanup failed", { error: errorMessage(error) });
		}
		try {
			await activeClient.destroy();
		} catch (error) {
			pi.logger.debug("Discord RPC disconnect failed", { error: errorMessage(error) });
		}
	};

	const connect = async (ctx: ExtensionContext): Promise<void> => {
		if (stopped || connecting || !config || client?.isConnected) return;
		connecting = true;
		const nextClient = new Client({ clientId: config.clientId });
		client = nextClient;
		nextClient.on("disconnected", () => {
			if (client === nextClient) client = undefined;
		});
		try {
			await nextClient.login();
			if (stopped || client !== nextClient) {
				await nextClient.destroy();
				return;
			}
			warnedConnectionFailure = false;
			queuePresenceUpdate(ctx);
		} catch (error) {
			if (client === nextClient) client = undefined;
			try {
				await nextClient.destroy();
			} catch {}
			if (!warnedConnectionFailure) {
				pi.logger.warn("Discord RPC connection failed; retrying in the background", {
					error: errorMessage(error),
				});
				warnedConnectionFailure = true;
			}
		} finally {
			connecting = false;
		}
	};

	const resetSession = (ctx: ExtensionContext): void => {
		currentContext = ctx;
		activeTools.clear();
		showSecondLine = false;
		working = false;
		sessionStartedAt = Date.now();
		queuePresenceUpdate(ctx);
	};

	pi.on("session_start", (_event, ctx) => {
		currentContext = ctx;
		sessionStartedAt = Date.now();
		void loadConfig().then(loadedConfig => {
			config = loadedConfig;
			if (config) {
				refreshStats();
				void connect(ctx);
			}
		});
		ctx.setInterval(() => {
			const latestContext = currentContext;
			if (!latestContext || stopped || !config) return;
			if (client?.isConnected) queuePresenceUpdate(latestContext);
			else void connect(latestContext);
		}, RECONNECT_INTERVAL_MS);
		ctx.setInterval(() => {
			if (!config || stopped) return;
			refreshStats();
			const latestContext = currentContext;
			if (showSecondLine && latestContext && client?.isConnected) queuePresenceUpdate(latestContext);
		}, STATS_REFRESH_INTERVAL_MS);
		ctx.setInterval(() => {
			const latestContext = currentContext;
			if (!config || !latestContext || stopped || !dailyStats) {
				showSecondLine = false;
				return;
			}
			const statsEnabled =
				config.secondLine.showRequests || config.secondLine.showTokens || config.secondLine.showCost;
			if (!statsEnabled) {
				showSecondLine = false;
				return;
			}
			showSecondLine = !showSecondLine;
			if (client?.isConnected) queuePresenceUpdate(latestContext);
		}, LINE_ROTATION_INTERVAL_MS);
	});

	pi.on("session_switch", (_event, ctx) => resetSession(ctx));
	pi.on("session_branch", (_event, ctx) => resetSession(ctx));
	pi.on("session_tree", (_event, ctx) => resetSession(ctx));

	pi.on("agent_start", (_event, ctx) => {
		activeTools.clear();
		working = true;
		queuePresenceUpdate(ctx);
	});

	pi.on("agent_end", (event, ctx) => {
		working = event.willContinue === true || !ctx.isIdle();
		if (!working) activeTools.clear();
		queuePresenceUpdate(ctx);
	});

	pi.on("tool_execution_start", (event, ctx) => {
		activeTools.set(event.toolCallId, event.toolName);
		queuePresenceUpdate(ctx);
	});

	pi.on("tool_execution_end", (event, ctx) => {
		activeTools.delete(event.toolCallId);
		queuePresenceUpdate(ctx);
	});

	pi.on("session_shutdown", async () => {
		stopped = true;
		await disconnect();
	});
}
