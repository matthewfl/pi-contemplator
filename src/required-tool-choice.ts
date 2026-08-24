/** Agent-loop tool-choice value accepted by each provider family. */
export function requiredToolChoice(api: string | undefined): "any" | "required" {
	if (api === "anthropic-messages" || api === "google-generative-ai" || api === "google-vertex" || api === "bedrock-converse-stream") return "any";
	return "required";
}

/** Apply provider-native required-tool controls at the final API payload layer. */
export function forceRequiredToolPayload(payload: unknown, api: string | undefined): unknown {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
	const record = payload as Record<string, unknown>;
	if (api === "anthropic-messages") return { ...record, tool_choice: { type: "any" } };
	if (api === "google-generative-ai" || api === "google-vertex") {
		const config = record.config && typeof record.config === "object" && !Array.isArray(record.config) ? record.config as Record<string, unknown> : {};
		const toolConfig = config.toolConfig && typeof config.toolConfig === "object" && !Array.isArray(config.toolConfig) ? config.toolConfig as Record<string, unknown> : {};
		const functionCallingConfig = toolConfig.functionCallingConfig && typeof toolConfig.functionCallingConfig === "object" && !Array.isArray(toolConfig.functionCallingConfig) ? toolConfig.functionCallingConfig as Record<string, unknown> : {};
		return { ...record, config: { ...config, toolConfig: { ...toolConfig, functionCallingConfig: { ...functionCallingConfig, mode: "ANY" } } } };
	}
	if (api === "bedrock-converse-stream") {
		const toolConfig = record.toolConfig && typeof record.toolConfig === "object" && !Array.isArray(record.toolConfig) ? record.toolConfig as Record<string, unknown> : {};
		return { ...record, toolConfig: { ...toolConfig, toolChoice: { any: {} } } };
	}
	if (api === "mistral-conversations") return { ...record, toolChoice: "required" };
	if (api === "pi-messages") {
		const options = record.options && typeof record.options === "object" && !Array.isArray(record.options) ? record.options as Record<string, unknown> : {};
		return { ...record, options: { ...options, toolChoice: "required" } };
	}
	return { ...record, tool_choice: "required" };
}
