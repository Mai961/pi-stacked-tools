/**
 * Which tool calls are drawn together as one line, and what that line says. No drawing happens here.
 *
 * A stack is a run of tool calls with nothing else drawn between them: it starts after a user message,
 * assistant text or any other transcript item, and ends at the next one. One stack can span many
 * assistant messages, because a model that works step by step sends one call per message.
 */

export type CallStatus = "pending" | "done" | "error";

export interface StackedCall {
	readonly id: string;
	readonly toolName: string;
	args: unknown;
	/** Every call of this call's stack, in call order. All of them share the one array. */
	stack: StackedCall[];
	/** A tool row has drawn this call. A call that never gets a row is left out of the summary. */
	mounted: boolean;
	expanded: boolean;
	status: CallStatus;
}

interface ContentBlock {
	type?: string;
	text?: string;
	thinking?: string;
	id?: string;
	name?: string;
}

export interface TranscriptMessage {
	role?: string;
	content?: unknown;
	display?: boolean;
}

export interface TranscriptEntry {
	type: string;
	message?: TranscriptMessage;
	display?: boolean;
}

export class Stacks {
	private calls = new Map<string, StackedCall>();
	/** The stack the next call joins. Undefined once something else was drawn. */
	private open: StackedCall[] | undefined;
	/** Calls from before a regroup, so their row state survives it. */
	private earlier: Map<string, StackedCall> | undefined;

	/** Whether calls to a tool take part. A call to any other tool ends the stack. */
	private readonly stacks: (toolName: string) => boolean;

	constructor(stacks: (toolName: string) => boolean) {
		this.stacks = stacks;
	}

	get(id: string): StackedCall | undefined {
		return this.calls.get(id);
	}

	/** Something other than a stacked tool call was drawn. */
	interrupt(): void {
		this.open = undefined;
	}

	/** Put a call on the open stack. A call that is already placed stays where it is. */
	place(id: string, toolName: string): StackedCall {
		const placed = this.calls.get(id);
		if (placed) {
			this.open = placed.stack;
			return placed;
		}
		const stack = this.open ?? [];
		const call: StackedCall = this.earlier?.get(id) ?? {
			id,
			toolName,
			args: undefined,
			stack,
			mounted: false,
			expanded: false,
			status: "pending",
		};
		call.stack = stack;
		stack.push(call);
		this.calls.set(id, call);
		this.open = stack;
		return call;
	}

	/**
	 * Take in an assistant message, complete or still streaming. Safe to repeat as the message grows.
	 * Pi draws all of a message's text above all of its tool rows, so text anywhere in the message
	 * separates its calls from the stack before it.
	 */
	readAssistant(message: TranscriptMessage, thinkingShown: boolean): void {
		const blocks: ContentBlock[] = Array.isArray(message.content) ? message.content : [];
		const drawsText = blocks.some(
			(block) =>
				(block.type === "text" && !!block.text?.trim()) ||
				(thinkingShown && block.type === "thinking" && !!block.thinking?.trim()),
		);
		if (drawsText) this.interrupt();
		for (const block of blocks) {
			if (block.type !== "toolCall" || !block.id || !block.name) continue;
			if (this.stacks(block.name)) this.place(block.id, block.name);
			else this.interrupt();
		}
	}

	/** Take in a message of any role. */
	readMessage(message: TranscriptMessage, thinkingShown: boolean): void {
		if (message.role === "assistant") this.readAssistant(message, thinkingShown);
		else if (message.role === "toolResult") return;
		else if (message.role === "custom" && message.display === false) return;
		else this.interrupt();
	}

	/**
	 * Regroup from the entries the transcript is drawn from (`buildContextEntries()`), after a resume,
	 * a compaction or a move in the session tree. Calls no longer in the transcript are forgotten.
	 */
	rebuild(entries: readonly TranscriptEntry[], thinkingShown: boolean): void {
		this.earlier = this.calls;
		this.calls = new Map();
		this.open = undefined;
		for (const entry of entries) {
			if (entry.type === "message" && entry.message) this.readMessage(entry.message, thinkingShown);
			else if (entry.type === "branch_summary") this.interrupt();
			else if (entry.type === "custom_message" && entry.display !== false) this.interrupt();
			// A compaction summary is drawn first, above the kept entries, so it separates nothing.
			// Plain custom entries hold extension state and the rest are settings changes: none is drawn.
		}
		this.earlier = undefined;
	}
}

/** The calls of a stack that its one line stands for: those with a row that is not expanded. */
export function collapsedCalls(stack: readonly StackedCall[]): StackedCall[] {
	return stack.filter((call) => call.mounted && !call.expanded);
}

interface Wording {
	done: string;
	doing: string;
	one: string;
	many: string;
	/** Count distinct `path` arguments instead of calls, so three reads of one file are one file. */
	byPath?: boolean;
}

const WORDINGS: Record<string, Wording> = {
	bash: { done: "ran", doing: "running", one: "bash command", many: "bash commands" },
	powershell: { done: "ran", doing: "running", one: "powershell command", many: "powershell commands" },
	read: { done: "read", doing: "reading", one: "file", many: "files", byPath: true },
	edit: { done: "edited", doing: "editing", one: "file", many: "files", byPath: true },
	write: { done: "wrote", doing: "writing", one: "file", many: "files", byPath: true },
	ls: { done: "listed", doing: "listing", one: "directory", many: "directories", byPath: true },
	grep: { done: "searched", doing: "searching", one: "pattern", many: "patterns" },
	find: { done: "ran", doing: "running", one: "file search", many: "file searches" },
	codemode: { done: "ran", doing: "running", one: "script", many: "scripts" },
};

function pathOf(call: StackedCall): string | undefined {
	const path = (call.args as { path?: unknown } | null | undefined)?.path;
	return typeof path === "string" && path ? path : undefined;
}

function clause(toolName: string, calls: readonly StackedCall[]): string {
	const running = calls.some((call) => call.status === "pending");
	const wording = WORDINGS[toolName];
	if (!wording) {
		const times = calls.length > 1 ? ` ${calls.length}×` : "";
		return `${running ? "calling" : "called"} ${toolName}${times}`;
	}
	let count = calls.length;
	if (wording.byPath) {
		const paths = new Set(calls.map(pathOf).filter((path) => path !== undefined));
		count = paths.size + calls.filter((call) => pathOf(call) === undefined).length;
	}
	return `${running ? wording.doing : wording.done} ${count} ${count === 1 ? wording.one : wording.many}`;
}

/** What a stack's line says, such as "Ran 3 bash commands, read 2 files". Tools keep call order. */
export function summarize(calls: readonly StackedCall[]): string {
	const byTool = new Map<string, StackedCall[]>();
	for (const call of calls) {
		const sameTool = byTool.get(call.toolName);
		if (sameTool) sameTool.push(call);
		else byTool.set(call.toolName, [call]);
	}
	const text = [...byTool].map(([toolName, sameTool]) => clause(toolName, sameTool)).join(", ");
	return text.charAt(0).toUpperCase() + text.slice(1);
}
