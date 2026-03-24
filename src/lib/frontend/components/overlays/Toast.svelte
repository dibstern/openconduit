<!--
  Toast — Auto-dismissing notification toasts.
  Reads uiState.toasts and renders each toast as a card inside NotificationStack.
  Auto-dismiss is handled by the store's showToast() via setTimeout.
-->
<script lang="ts">
	import { uiState } from "../../stores/ui.svelte.js";
</script>

{#each uiState.toasts as toast (toast.id)}
	<div
		class="pointer-events-auto w-full px-4 py-2 rounded-lg text-sm font-medium shadow-lg notification-slide-in {toast.variant === 'warn'
			? 'bg-warning-bg border border-warning text-warning'
			: 'bg-bg-alt border border-border text-text'}"
		role="status"
		aria-live="polite"
	>
		{toast.message}
	</div>
{/each}

<style>
	.notification-slide-in {
		animation: slideInRight 200ms ease-out both;
	}

	@keyframes slideInRight {
		from {
			opacity: 0;
			transform: translateX(16px);
		}
		to {
			opacity: 1;
			transform: translateX(0);
		}
	}
</style>
