import assert from "node:assert/strict";
import { promptEntries, splitPromptListPayload, queueSubmissionPlan } from "./prompt_list_queue.mjs";

const listInputs = {
  "提示词框数量": 4,
  "统一前缀": "PRE-",
  "统一后缀": "-POST",
  "提示词1": "shot one",
  "提示词2": "",
  "提示词3": "shot three",
  "提示词4": "shot four",
};
const output = {
  "43": { class_type: "NanFengPromptList", inputs: structuredClone(listInputs) },
  "36": { class_type: "NanFengH3MultiReferenceGeneratorV3", inputs: { "提示词": ["43", 0], "随机种子": 123456 } },
  "20": { class_type: "VHS_VideoCombine", inputs: { images: ["36", 0], audio: ["36", 1] } },
};
const widgets = [4, "PRE-", "-POST", "shot one", "", "shot three", "shot four", ...Array(16).fill("")];
const workflow = { nodes: [{ id: 43, type: "NanFengPromptList", widgets_values: widgets }], extra: {} };

assert.deepEqual(promptEntries(listInputs), [
  { index: 1, body: "shot one" },
  { index: 3, body: "shot three" },
  { index: 4, body: "shot four" },
]);

const split = splitPromptListPayload(output, workflow);
assert.equal(split.length, 3);
assert.deepEqual(split.map(x => x.sourceIndex), [1, 3, 4]);
assert.deepEqual(split.map(x => x.output["43"].inputs["提示词1"]), ["shot one", "shot three", "shot four"]);
assert.ok(split.every(x => x.output["43"].inputs["提示词框数量"] === 1));
assert.ok(split.every(x => x.output["36"].inputs["随机种子"] === 123456));
assert.ok(split.every(x => x.output["36"].inputs["提示词"][0] === "43"));
assert.ok(split.every(x => x.output["20"].inputs.images[0] === "36"));
assert.deepEqual(split.map(x => x.workflow.extra.nanfeng_prompt_list_item), [1, 3, 4]);
assert.ok(split.every(x => x.workflow.extra.nanfeng_prompt_list_total === 3));
assert.deepEqual(split.map(x => x.workflow.nodes[0].widgets_values[3]), ["shot one", "shot three", "shot four"]);
assert.ok(split.every(x => x.workflow.nodes[0].widgets_values.slice(4).every(v => v === "")));

assert.equal(splitPromptListPayload({ "1": { class_type: "Other", inputs: {} } }, workflow), null);
assert.equal(splitPromptListPayload({ "43": { class_type: "NanFengPromptList", inputs: { "提示词框数量": 1, "提示词1": "one" } } }, workflow), null);

// Normal queueing must submit every split with 0 so the server assigns monotonically
// increasing queue numbers. Explicit 1,2,3 can jump ahead of the first auto-numbered job.
assert.deepEqual(queueSubmissionPlan(0, 4), [0, 0, 0, 0]);
// "Queue front" keeps reverse negative numbers so item 1 remains the first execution.
assert.deepEqual(queueSubmissionPlan(-1, 4), [-4, -3, -2, -1]);

console.log("prompt_list_queue: all tests passed");
