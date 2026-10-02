#!/usr/bin/env node
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import {
	ModelServer,
	assert,
	createWorkspace,
	launchPi,
	omSettings,
	prepareWorkspace,
	sendSse,
	stopPi,
	textOf,
	waitFor,
} from "./harness.mjs";

const startedAt = Date.now();
const progress = (message) => console.log(`[e2e +${((Date.now() - startedAt) / 1000).toFixed(1)}s] ${message}`);
const workspace = await createWorkspace("pi-contemplator-active-time-");
let instance;
let server;

try {
	progress("Scenario: cumulative active-work fallback invokes the contemplator without new memories");
	server = new ModelServer(async (request, res) => {
		if (request.role === "main") {
			await sendSse(res, { text: "ACTIVE_TIME_CHECKPOINT_COMPLETE" });
			return;
		}
		assert(request.role === "contemplator", `Unexpected provider request role: ${request.role}`);
		assert(request.text.includes("ACTIVE-WORK FALLBACK"), "Contemplator prompt omitted the active-work fallback reason");
		assert(request.text.includes("(no new memories)"), "Fallback scenario unexpectedly required a memory update");
		await sendSse(res, {
			tool: { id: "no-intervention-active-time", name: "no_intervention", arguments: {} },
		});
	});
	const port = await server.start();
	await prepareWorkspace(workspace, port, omSettings({
		observeAfterTokens: 1_000_000,
		contemplatorMinNewObservations: 100,
		contemplatorMinTurns: 100,
		contemplatorMaxActiveMinutes: 60,
	}));

	const fixtureExtension = join(workspace.root, "active-time-fixture.ts");
	await writeFile(fixtureExtension, `export default function (pi) {
		pi.on("session_start", () => pi.appendEntry("om.agent.activity", {
			version: 1,
			durationMs: 3600000,
			endedAt: Date.now()
		}));
	}\n`);

	instance = await launchPi(workspace, { extraExtensions: [fixtureExtension] });
	await instance.rpc.command({ type: "prompt", message: "Create one primary response so the active-time checkpoint is evaluated." });
	await waitFor(() => server.requests.some((request) => request.role === "contemplator"), "active-time contemplator request");
	const entries = await waitFor(async () => {
		const current = await instance.rpc.entries();
		return current.some((entry) => entry.customType === "om.contemplator.run") &&
			current.some((entry) => entry.customType === "om.contemplator.message") ? current : undefined;
	}, "durable active-time run marker and contemplator transcript");

	const marker = entries.find((entry) => entry.customType === "om.contemplator.run");
	assert(marker?.data?.mainAgentActiveTimeMs >= 3_600_000, "Run marker did not preserve the cumulative active-time baseline");
	const promptEntry = entries.find((entry) => entry.customType === "om.contemplator.message" && entry.data?.message?.role === "user");
	assert(textOf(promptEntry?.data?.message).includes("ACTIVE-WORK FALLBACK"), "Durable contemplator prompt omitted the fallback reason");
	assert(server.requests.filter((request) => request.role === "contemplator").length === 1, "Fallback launched duplicate contemplator runs");
	progress("PASS: real Pi invoked one background contemplator run and persisted its active-time baseline");
} finally {
	if (instance) await stopPi(instance);
	if (server) await server.close();
	await workspace.cleanup();
}
