<!-- ─── Tool Item ───────────────────────────────────────────────────────────── -->
<!-- Thin dispatcher that routes tool messages to the appropriate sub-component. -->
<!-- Preserves .tool-item class and data-tool-id for E2E. -->

<script lang="ts">
	import type { ToolMessage } from "../../types.js";

	// biome-ignore lint/style/useImportType: ToolQuestionCard is used as a value for bind:this
	import ToolQuestionCard from "./ToolQuestionCard.svelte";
	import ToolSubagentCard from "./ToolSubagentCard.svelte";
	import ToolGenericCard from "./ToolGenericCard.svelte";

	let { message, isFirstInGroup = true, isLastInGroup = true }: {
		message: ToolMessage;
		isFirstInGroup?: boolean;
		isLastInGroup?: boolean;
	} = $props();

	const isQuestion = $derived(message.name === "AskUserQuestion");
	const isSubagent = $derived(message.name === "Task" || message.name === "task");

	const groupRadius = $derived.by(() => {
		if (isFirstInGroup && isLastInGroup) return "rounded-[10px]";
		if (isFirstInGroup) return "rounded-t-[10px]";
		if (isLastInGroup) return "rounded-b-[10px]";
		return "";
	});

	// Bind to the question card to read its isDeferredQuestion value
	let questionCard: ToolQuestionCard | undefined = $state();
	const isDeferredQuestion = $derived(
		isQuestion && questionCard?.isDeferredQuestion === true
	);
</script>

<!-- Active non-synthetic questions are deferred to the bottom of MessageList.
	 Hide the entire tool-item wrapper to avoid empty margin/padding. -->
{#if isDeferredQuestion}
	<!-- Rendered at bottom of MessageList instead -->
{:else}
<div
	class="tool-item max-w-[760px] mx-auto px-5"
	class:mt-1.5={isFirstInGroup}
	class:mt-0.5={!isFirstInGroup}
	class:mb-0.5={!isLastInGroup}
	class:mb-1={isLastInGroup}
	data-tool-id={message.id}
>
{#if isQuestion}
	<ToolQuestionCard bind:this={questionCard} {message} {groupRadius} />
{:else if isSubagent}
	<ToolSubagentCard {message} {groupRadius} />
{:else}
	<ToolGenericCard {message} {groupRadius} />
{/if}
</div>
{/if}
