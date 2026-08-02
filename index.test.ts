import { afterAll, expect, mock, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { z } from "zod";

type Activity = Readonly<{ details?: string }>;
type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;

const bufferedActivities: Activity[] = [];
const activityWaiters: Array<(activity: Activity) => void> = [];
const originalClientId = Bun.env.OMP_DISCORD_CLIENT_ID;
Bun.env.OMP_DISCORD_CLIENT_ID = "12345678901234567";

mock.module("@xhayper/discord-rpc", () => ({
	Client: class {
		isConnected = true;
		user = {
			setActivity: async (activity: Activity) => {
				const waiter = activityWaiters.shift();
				if (waiter) waiter(activity);
				else bufferedActivities.push(activity);
			},
			clearActivity: async () => {},
		};

		on(): this {
			return this;
		}

		async login(): Promise<void> {}
		async destroy(): Promise<void> {}
	},
}));

// The extension must load after the Discord module mock is registered.
const { default: discordRpcExtension } = await import("./index.ts");

function nextActivity(): Promise<Activity> {
	const activity = bufferedActivities.shift();
	if (activity) return Promise.resolve(activity);
	const { promise, resolve } = Promise.withResolvers<Activity>();
	activityWaiters.push(resolve);
	return promise;
}

afterAll(() => {
	if (originalClientId === undefined) delete Bun.env.OMP_DISCORD_CLIENT_ID;
	else Bun.env.OMP_DISCORD_CLIENT_ID = originalClientId;
	mock.restore();
});

test("ignores a delayed agent_end from an interrupted run", async () => {
	const handlers = new Map<string, EventHandler>();
	let idle = true;
	const ctx = {
		cwd: "D:/repos/omp-rpc",
		isIdle: () => idle,
		models: { current: () => undefined },
		setInterval: () => 0,
	} as unknown as ExtensionContext;
	const pi = {
		zod: z,
		logger: { debug: () => {}, warn: () => {} },
		on: (event: string, handler: EventHandler) => handlers.set(event, handler),
		getThinkingLevel: () => undefined,
		getSessionName: () => undefined,
	} as unknown as ExtensionAPI;

	discordRpcExtension(pi);
	const initialActivity = nextActivity();
	handlers.get("session_start")?.({}, ctx);
	expect((await initialActivity).details).toBe("Idle in OMP");

	idle = false;
	const startedActivity = nextActivity();
	handlers.get("agent_start")?.({}, ctx);
	expect((await startedActivity).details).toBe("Working with OMP");

	const delayedEndActivity = nextActivity();
	handlers.get("agent_end")?.({ willContinue: false }, ctx);
	expect((await delayedEndActivity).details).toBe("Working with OMP");

	idle = true;
	const completedActivity = nextActivity();
	handlers.get("agent_end")?.({ willContinue: false }, ctx);
	expect((await completedActivity).details).toBe("Idle in OMP");

	await handlers.get("session_shutdown")?.({}, ctx);
});
