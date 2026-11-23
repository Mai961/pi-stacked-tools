import type { ExtensionAPI, ExtensionContext, Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import {
	Box,
	type Component,
	Spacer,
	stripTerminalSequences,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { collapsedCalls, type StackedCall, Stacks, summarize, type TranscriptEntry } from "./stacks.ts";

type RenderCall = NonNullable<ToolRenderers["renderCall"]>;
type RenderResult = NonNullable<ToolRenderers["renderResult"]>;
type CallContext = Parameters<RenderCall>[2];
type ResultContext = Parameters<RenderResult>[3];

/** Tool cards that keep their normal collapsed output. A call to one ends the stack before it. */
export function keepsFullCard(toolName: string): boolean {
	return toolName.startsWith("subagent");
}

function hasText(line: string): boolean {
	return stripTerminalSequences(line).trim() !== "";
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matches the terminal's set-background sequence
const BACKGROUND = /\x1b\[48;[\d;]*m/g;
const DEFAULT_BACKGROUND = "\x1b[49m";

/**
 * Puts `addition` right after the text of a row and pads the rest to `width`. Rows come padded to their
 * width, often on a background; the addition and the new padding stay on that background, so this
 * works for lines framed here and for tools that frame themselves. Text past `maxText` is cut.
 */
function appendToRow(row: string, addition: string, width: number, maxText = width): string {
	const used = Math.min(visibleWidth(stripTerminalSequences(row).trimEnd()), maxText);
	const background = row.match(BACKGROUND)?.at(-1);
	const rest = `${addition}${" ".repeat(Math.max(0, width - used - visibleWidth(addition)))}`;
	const text = truncateToWidth(row, used, "");
	return background ? `${text}${background}${rest}${DEFAULT_BACKGROUND}` : `${text}${rest}`;
}

/** Shows only the first row of a component that has text, marking that more was cut. */
export class FirstLine implements Component {
	constructor(
		readonly inner: Component,
		private readonly more: string,
	) {}

	render(width: number): string[] {
		const rows = this.inner.render(width).filter(hasText);
		const first = rows[0];
		if (first === undefined) return [];
		if (rows.length === 1) return [first];
		return [appendToRow(first, this.more, width, Math.max(0, width - visibleWidth(this.more)))];
	}

	invalidate(): void {
		this.inner.invalidate();
	}
}

/** What the wrapped renderer returned last time, so it can keep reusing its own component. */
const innerComponents = new WeakMap<Component, Component>();

function remember<T extends Component>(shown: T, inner: Component): T {
	innerComponents.set(shown, inner);
	return shown;
}

function forInner<T extends CallContext | ResultContext>(context: T): T {
	const last = context.lastComponent;
	return { ...context, lastComponent: last ? innerComponents.get(last) : undefined };
}

function cardBackground(theme: Theme, context: { isPartial: boolean; isError: boolean }): (text: string) => string {
	const color = context.isPartial ? "toolPendingBg" : context.isError ? "toolErrorBg" : "toolSuccessBg";
	return (text) => theme.bg(color, text);
}

/** A call's collapsed line when it stands alone: framed, and bare for use inside a stack's line. */
interface CallLine {
	framed: Component;
	bare: Component;
}

const callLines = new WeakMap<StackedCall, CallLine>();

/** Narrowest room worth using to name the running call after the summary. */
const MIN_RUNNING_WIDTH = 12;

/** Narrowest a collapsed line may get to make room for the expand hint. Below it the hint is left out. */
const MIN_HINTED_WIDTH = 40;

/** Draws a one-row line with the hint right after its text. Without room for both, only the line. */
function renderWithHint(renderLine: (width: number) => readonly string[], width: number, hint: string): string[] {
	const reserved = visibleWidth(hint) + 2;
	if (!hint || width - reserved < MIN_HINTED_WIDTH) return [...renderLine(width)];
	const rows = renderLine(width - reserved);
	const row = rows[0];
	if (rows.length !== 1 || row === undefined) return [...renderLine(width)];
	return [appendToRow(row, ` ${hint}`, width)];
}

/**
 * The collapsed row of one call. The first collapsed call of a stack draws the line for all of them and
 * the others draw nothing, so a stack is one line however many calls and assistant messages it spans.
 * A call alone in its stack shows its own line. What to draw is worked out on every render, because
 * the stack changes when other rows arrive, finish or expand.
 */
export class StackLine implements Component {
	constructor(
		private readonly call: StackedCall,
		private readonly theme: Theme,
		private readonly outputPad: number,
		/** Dim note naming the expand key, or "" when no key is bound. */
		private readonly hint: string,
	) {}

	render(width: number): string[] {
		const calls = collapsedCalls(this.call.stack);
		if (calls[0] !== this.call) return [];
		if (calls.length === 1) {
			const own = callLines.get(this.call)?.framed;
			return own ? renderWithHint((lineWidth) => own.render(lineWidth), width, this.hint) : [];
		}
		return renderWithHint((lineWidth) => this.renderSummary(calls, lineWidth), width, this.hint);
	}

	private renderSummary(calls: readonly StackedCall[], width: number): string[] {
		const { theme } = this;
		const room = Math.max(1, width - this.outputPad * 2);
		const running = calls.find((call) => call.status === "pending");
		const failed = calls.filter((call) => call.status === "error").length;
		let line = theme.fg("toolTitle", theme.bold(summarize(calls)));
		if (failed > 0) line += theme.fg("error", `, ${failed} failed`);
		if (running) {
			const separator = " · ";
			const left = room - visibleWidth(line) - separator.length;
			const now = left >= MIN_RUNNING_WIDTH ? callLines.get(running)?.bare.render(left)[0] : undefined;
			if (now) line += theme.fg("muted", separator) + now;
		}
		const background = running ? "toolPendingBg" : "toolSuccessBg";
		return [
			...new Text(truncateToWidth(line, room, "…"), this.outputPad, 0, (text) => theme.bg(background, text)).render(
				width,
			),
		];
	}

	invalidate(): void {
		callLines.get(this.call)?.framed.invalidate?.();
	}
}

/** Row states of the transcript's tool rows, as opposed to rows drawn for an HTML export. */
const transcriptRows = new WeakSet<object>();

/**
 * Only the transcript stacks. The HTML export draws each call on its own, with no row above it to hold
 * a summary, so there every call keeps its own line. The two are told apart by the first draw: the
 * transcript draws a call before it has started, the export only draws calls that already ran.
 */
function isTranscriptRow(context: CallContext | ResultContext): boolean {
	const row = context.state as object;
	if (!context.executionStarted && !context.argsComplete) transcriptRows.add(row);
	return transcriptRows.has(row);
}

function statusOf(context: { isPartial: boolean; isError: boolean }): StackedCall["status"] {
	return context.isPartial ? "pending" : context.isError ? "error" : "done";
}

/**
 * Collapsed, a run of tool calls is one line, such as "Ran 3 bash commands, read 2 files", on the usual
 * pending/success background; while a call runs, the line also names it. The line ends with a dim note
 * naming the expand key (Ctrl+O by default), which shows every call and its output in full with Pi's
 * normal padding. Only drawing changes: the
 * tools themselves, and what the model receives, are untouched.
 */
export function stackCalls(toolName: string, base: ToolRenderers | undefined, stacks: Stacks): ToolRenderers | undefined {
	const renderCall = base?.renderCall;
	const renderResult = base?.renderResult;
	// Without both renderers Pi draws its own fallbacks, which cannot be reproduced for the expanded view.
	if (!base || !renderCall || !renderResult || keepsFullCard(toolName)) return base;
	// A tool that already frames itself (edit) keeps its own framing; only its collapsed rows are cut.
	const framesItself = base.renderShell === "self";

	return {
		...base,
		renderShell: "self",
		renderCall: (args, theme, context) => {
			const inner = renderCall(args, theme, forInner(context));
			let call: StackedCall | undefined;
			if (isTranscriptRow(context)) {
				// The message events place a call before its row exists. A row they missed joins the open stack.
				call = stacks.get(context.toolCallId) ?? stacks.place(context.toolCallId, toolName);
				call.args = args;
				call.mounted = true;
				call.expanded = context.expanded;
				call.status = statusOf(context);
			}
			if (context.expanded) {
				if (framesItself) return remember(inner, inner);
				const box = new Box(context.outputPad, 0, cardBackground(theme, context));
				box.addChild(new Spacer(1));
				box.addChild(inner);
				return remember(box, inner);
			}
			const bare = new FirstLine(inner, theme.fg("muted", " …"));
			let framed: Component = bare;
			if (!framesItself) {
				const box = new Box(context.outputPad, 0, cardBackground(theme, context));
				box.addChild(bare);
				framed = box;
			}
			if (!call) return remember(framed, inner);
			callLines.set(call, { framed, bare });
			const expandKey = context.keyText("app.tools.expand");
			const hint = expandKey ? theme.fg("dim", `(${expandKey} to expand)`) : "";
			return remember(new StackLine(call, theme, context.outputPad, hint), inner);
		},
		renderResult: (result, options, theme, context) => {
			// Always run the tool's own renderer: some (edit) settle their call line's state from the result.
			const inner = renderResult(result, options, theme, forInner(context));
			if (!options.expanded) return remember(new Text("", 0, 0), inner);
			if (framesItself) return remember(inner, inner);
			const box = new Box(context.outputPad, 0, cardBackground(theme, context));
			box.addChild(inner);
			box.addChild(new Spacer(1));
			return remember(box, inner);
		},
	};
}

export default function registerStackedTools(pi: ExtensionAPI): void {
	/** Tools whose cards are left alone, learned as their renderers are resolved. */
	const leftAlone = new Set<string>();
	const stacks = new Stacks((toolName) => !keepsFullCard(toolName) && !leftAlone.has(toolName));

	pi.registerToolRenderer((toolName, next) => {
		const base = next();
		const stacked = stackCalls(toolName, base, stacks);
		if (stacked === base) leftAlone.add(toolName);
		else leftAlone.delete(toolName);
		return stacked;
	});

	// Shown thinking is drawn between tool rows, so it separates stacks. Hidden thinking would too, with
	// its "Thinking..." label before every call, so the label is blanked and hidden thinking draws nothing.
	const thinkingShown = () => pi.getSettings().hideThinkingBlock !== true;
	// Settings cannot be read while the extension loads; session_start sets this before any message.
	let groupedWithThinkingShown = false;

	const regroup = (ctx: ExtensionContext) => {
		groupedWithThinkingShown = thinkingShown();
		stacks.rebuild(ctx.sessionManager.buildContextEntries() as TranscriptEntry[], groupedWithThinkingShown);
		// Blanks the label, and repaints the rows with their new stacks.
		if (ctx.hasUI) ctx.ui.setHiddenThinkingLabel("");
	};

	pi.on("session_start", (_event, ctx) => regroup(ctx));
	pi.on("session_tree", (_event, ctx) => regroup(ctx));
	pi.on("session_compact", (_event, ctx) => regroup(ctx));
	pi.on("agent_start", (_event, ctx) => {
		// The thinking toggle (Ctrl+T) changes what separates stacks.
		if (thinkingShown() !== groupedWithThinkingShown) regroup(ctx);
	});

	// These run before Pi adds the message's rows, so every call is placed before it is first drawn.
	pi.on("message_start", (event) => stacks.readMessage(event.message, groupedWithThinkingShown));
	pi.on("message_update", (event) => stacks.readMessage(event.message, groupedWithThinkingShown));
	pi.on("message_end", (event) => stacks.readMessage(event.message, groupedWithThinkingShown));
	// A `!` command's output is drawn in the transcript too.
	pi.on("user_bash", () => stacks.interrupt());
}
