import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSettingsCommand } from "./commands/settings.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerViewCommand } from "./commands/view.js";
import { registerContemplatorViewCommand } from "./commands/contemplator-view.js";
import { registerCompactionHook } from "./hooks/compaction-hook.js";
import { registerCompactionTrigger } from "./hooks/compaction-trigger.js";
import { registerConsolidationTrigger } from "./hooks/consolidation-trigger.js";
import { Runtime } from "./runtime.js";
import { registerRecallTool } from "./tools/recall-observation.js";
import { registerSearchMemoriesTool } from "./tools/search-memories.js";
import { Contemplator } from "./contemplator.js";

export default function observationalMemory(pi: ExtensionAPI) {
	const runtime = new Runtime();
	registerSettingsCommand(pi, runtime);
	new Contemplator(pi, runtime).register();

	registerConsolidationTrigger(pi, runtime);
	registerCompactionTrigger(pi, runtime);
	registerCompactionHook(pi, runtime);

	registerStatusCommand(pi, runtime);
	registerViewCommand(pi, runtime);
	registerContemplatorViewCommand(pi);
	registerRecallTool(pi);
	registerSearchMemoriesTool(pi);
}
