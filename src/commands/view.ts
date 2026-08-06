import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Runtime } from "../runtime.js";
import { copyTextToClipboard } from "../clipboard.js";
import { renderContemplator, stripAnsi } from "./contemplator-view.js";
import { renderReviewer } from "./reviewer-view.js";
import {
	fullProjection,
	observationToSummaryLine,
	reflectionToSummaryLine,
	visibleProjection,
	type Entry,
	type Projection,
} from "../session-ledger/index.js";

function firstArg(args: unknown): string | undefined {
	if (Array.isArray(args))
		return typeof args[0] === "string" ? args[0] : undefined;
	if (typeof args === "string") return args.trim().split(/\s+/)[0];
	if (args && typeof args === "object" && "mode" in args) {
		const mode = (args as { mode?: unknown }).mode;
		return typeof mode === "string" ? mode : undefined;
	}
	return undefined;
}

function renderList<T>(
	items: T[],
	render: (item: T) => string,
	empty: string,
): string {
	return items.length > 0 ? items.map(render).join("\n") : empty;
}

function reviewSummaryLine(review: NonNullable<Projection["reviews"]>[number]): string {
	if (review.outcome === "proposal") return `[${review.id}] ${review.scope} proposal: ${review.title} — ${review.summary}`;
	return `[${review.id}] ${review.scope} review concluded with no proposal — ${review.reason}`;
}

function renderContentOnlyProjection(
	projection: Projection,
	emptyScope: "visible" | "recorded",
): string {
	const lines = [
		"── Reflections ──",
		renderList(projection.reflections, reflectionToSummaryLine, `No ${emptyScope} reflections.`),
		"",
		"── Observations ──",
		renderList(projection.observations, observationToSummaryLine, `No ${emptyScope} observations.`),
	];
	if (projection.reviews?.length) lines.push("", "── Advisory reviews ──", ...projection.reviews.map(reviewSummaryLine));
	return lines.join("\n");
}

function hasMemory(projection: Projection): boolean {
	return (
		projection.reflections.length > 0 || projection.observations.length > 0 || (projection.reviews?.length ?? 0) > 0
	);
}

interface ViewCommandOptions {
	copyToClipboard?: (text: string) => Promise<boolean>;
}

export function registerViewCommand(
	pi: ExtensionAPI,
	runtime: Runtime,
	options: ViewCommandOptions = {},
): void {
	const copyToClipboard = options.copyToClipboard ?? copyTextToClipboard;

	pi.registerCommand("om:view", {
		description:
			"Print and copy observational memory content (visible, full, or contemplator)",
		handler: async (args, ctx) => {
			runtime.ensureConfig(ctx.cwd);
			const entries = ctx.sessionManager.getBranch() as Entry[];
			const mode = firstArg(args);

			const notifyWithCopy = async (output: string) => {
				const copied = await copyToClipboard(output).catch(() => false);
				ctx.ui.notify(
					copied
						? `${output}\n\nCopied /om:view output to clipboard.`
						: `${output}\n\nWarning: failed to copy /om:view output to clipboard.`,
					"info",
				);
			};

			if (mode === "contemplator") {
				const output = renderContemplator(entries);
				const copied = await copyToClipboard(stripAnsi(output)).catch(() => false);
				ctx.ui.notify(
					`${output}\n\n${copied ? "Copied /om:view contemplator output to clipboard." : "Warning: failed to copy /om:view contemplator output to clipboard."}`,
					"info",
				);
				return;
			}

			if (mode === "reviewer") {
				const output = renderReviewer(entries);
				const copied = await copyToClipboard(stripAnsi(output)).catch(() => false);
				ctx.ui.notify(
					`${output}\n\n${copied ? "Copied /om:view reviewer output to clipboard." : "Warning: failed to copy /om:view reviewer output to clipboard."}`,
					"info",
				);
				return;
			}

			if (mode === "reviews") {
				const output = renderList(
					fullProjection(entries).reviews ?? [],
					reviewSummaryLine,
					"No advisory reviews recorded.",
				);
				await notifyWithCopy(output);
				return;
			}

			if (mode === "full") {
				await notifyWithCopy(
					renderContentOnlyProjection(fullProjection(entries), "recorded"),
				);
				return;
			}

			if (mode && mode !== "visible") {
				ctx.ui.notify("Usage: /om:view [visible|full|contemplator|reviewer|reviews]", "info");
				return;
			}

			const visible = visibleProjection(entries);
			if (hasMemory(visible)) {
				await notifyWithCopy(renderContentOnlyProjection(visible, "visible"));
				return;
			}

			if (mode === "visible") {
				await notifyWithCopy(renderContentOnlyProjection(visible, "visible"));
				return;
			}

			const recorded = fullProjection(entries);
			if (hasMemory(recorded)) {
				await notifyWithCopy(
					`No visible memory has been folded into a compaction yet; showing recorded memory.\n\n${renderContentOnlyProjection(recorded, "recorded")}`,
				);
				return;
			}

			await notifyWithCopy(renderContentOnlyProjection(visible, "visible"));
		},
	});
}
