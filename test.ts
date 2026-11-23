// Run with: npm test
import assert from "node:assert/strict";
import test from "node:test";
import { collapsedCalls, type StackedCall, Stacks, summarize, type TranscriptEntry } from "./stacks.ts";

const everyTool = () => new Stacks(() => true);
const text = (value: string) => ({ type: "text", text: value });
const thinking = (value: string) => ({ type: "thinking", thinking: value });
const toolCall = (id: string, name = "bash") => ({ type: "toolCall", id, name, arguments: {} });
const assistant = (...content: object[]) => ({ role: "assistant", content });
const user = (value: string) => ({ role: "user", content: value });
const toolResult = (toolCallId: string) => ({ role: "toolResult", toolCallId });
const entry = (message: object): TranscriptEntry => ({ type: "message", message });

/** The ids of each stack, in the order their first calls were placed. */
function stackIds(stacks: Stacks, ids: string[]): string[][] {
	const seen = new Set<StackedCall[]>();
	for (const id of ids) {
		const call = stacks.get(id);
		assert.ok(call, `call ${id} is placed`);
		seen.add(call.stack);
	}
	return [...seen].map((stack) => stack.map((call) => call.id));
}

function drawn(stacks: Stacks, id: string, status: StackedCall["status"], args: unknown = {}): StackedCall {
	const call = stacks.get(id);
	assert.ok(call);
	call.mounted = true;
	call.status = status;
	call.args = args;
	return call;
}

test("calls in successive assistant messages share one stack", () => {
	const stacks = everyTool();
	stacks.readMessage(user("go"), false);
	stacks.readMessage(assistant(thinking("hm"), toolCall("a")), false);
	stacks.readMessage(toolResult("a"), false);
	stacks.readMessage(assistant(toolCall("b"), toolCall("c", "read")), false);
	assert.deepEqual(stackIds(stacks, ["a", "b", "c"]), [["a", "b", "c"]]);
});

test("assistant text, a user message and shown thinking each start a new stack", () => {
	const stacks = everyTool();
	stacks.readMessage(assistant(toolCall("a")), false);
	stacks.readMessage(assistant(text("Now the next step."), toolCall("b")), false);
	stacks.readMessage(user("and?"), false);
	stacks.readMessage(assistant(toolCall("c")), false);
	stacks.readMessage(assistant(thinking("hidden"), toolCall("d")), false);
	stacks.readMessage(assistant(thinking("shown"), toolCall("e")), true);
	assert.deepEqual(stackIds(stacks, ["a", "b", "c", "d", "e"]), [["a"], ["b"], ["c", "d"], ["e"]]);
});

test("text after a call in the same message still separates it from the stack before", () => {
	const stacks = everyTool();
	stacks.readMessage(assistant(toolCall("a")), false);
	stacks.readMessage(assistant(toolCall("b"), text("explaining")), false);
	assert.deepEqual(stackIds(stacks, ["a", "b"]), [["a"], ["b"]]);
});

test("a streaming message can be read again as it grows", () => {
	const stacks = everyTool();
	stacks.readMessage(assistant(toolCall("a")), false);
	stacks.readMessage(assistant(text("Next")), false);
	stacks.readMessage(assistant(text("Next up"), toolCall("b")), false);
	stacks.readMessage(assistant(text("Next up"), toolCall("b"), toolCall("c")), false);
	stacks.readMessage(assistant(text("Next up"), toolCall("b"), toolCall("c")), false);
	stacks.readMessage(assistant(toolCall("d")), false);
	assert.deepEqual(stackIds(stacks, ["a", "b", "c", "d"]), [["a"], ["b", "c", "d"]]);
});

test("a call to a tool that keeps its own card ends the stack", () => {
	const stacks = new Stacks((toolName) => toolName !== "subagent");
	stacks.readMessage(assistant(toolCall("a"), toolCall("s", "subagent"), toolCall("b")), false);
	assert.equal(stacks.get("s"), undefined);
	assert.deepEqual(stackIds(stacks, ["a", "b"]), [["a"], ["b"]]);
});

test("a rebuild regroups from the transcript, keeps row state and forgets calls that are gone", () => {
	const stacks = everyTool();
	// Rows drawn before the entries were read all land on one stack.
	for (const id of ["gone", "a", "b", "c"]) stacks.place(id, "bash");
	const a = drawn(stacks, "a", "done");
	a.expanded = true;

	stacks.rebuild(
		[
			{ type: "compaction" },
			entry(assistant(toolCall("a"))),
			{ type: "custom" },
			{ type: "custom_message", display: false },
			entry(assistant(toolCall("b"))),
			entry(user("more")),
			{ type: "model_change" },
			entry(assistant(toolCall("c"))),
		],
		false,
	);

	assert.equal(stacks.get("gone"), undefined);
	assert.equal(stacks.get("a"), a);
	assert.equal(a.expanded, true);
	assert.deepEqual(stackIds(stacks, ["a", "b", "c"]), [["a", "b"], ["c"]]);

	// New calls continue the stack the transcript ends in.
	stacks.readMessage(assistant(toolCall("d")), false);
	assert.deepEqual(stackIds(stacks, ["c", "d"]), [["c", "d"]]);
});

test("the line stands for the calls that have a collapsed row", () => {
	const stacks = everyTool();
	stacks.readMessage(assistant(toolCall("a"), toolCall("b"), toolCall("c")), false);
	drawn(stacks, "a", "done").expanded = true;
	drawn(stacks, "b", "done");
	const stack = stacks.get("a")?.stack ?? [];
	assert.deepEqual(
		collapsedCalls(stack).map((call) => call.id),
		["b"],
	);
});

test("summaries count per tool, in call order, with distinct files and the running tense", () => {
	const stacks = everyTool();
	stacks.readMessage(
		assistant(
			toolCall("b1"),
			toolCall("r1", "read"),
			toolCall("b2"),
			toolCall("r2", "read"),
			toolCall("r3", "read"),
			toolCall("e1", "edit"),
			toolCall("m1", "mcp__pca__search"),
			toolCall("m2", "mcp__pca__search"),
		),
		false,
	);
	drawn(stacks, "b1", "done");
	drawn(stacks, "b2", "done");
	drawn(stacks, "r1", "done", { path: "a.ts" });
	drawn(stacks, "r2", "done", { path: "a.ts", offset: 200 });
	drawn(stacks, "r3", "done", { path: "b.ts" });
	drawn(stacks, "e1", "pending", { path: "a.ts" });
	drawn(stacks, "m1", "done");
	drawn(stacks, "m2", "error");
	const stack = stacks.get("b1")?.stack ?? [];
	assert.equal(
		summarize(collapsedCalls(stack)),
		"Ran 2 bash commands, read 2 files, editing 1 file, called mcp__pca__search 2×",
	);
	assert.equal(summarize([drawn(stacks, "b1", "pending")]), "Running 1 bash command");
});
