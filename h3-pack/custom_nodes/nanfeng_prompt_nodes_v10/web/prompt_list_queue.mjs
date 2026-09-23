export const PROMPT_LIST_CLASS = "NanFengPromptList";

function cloneValue(value) {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

export function promptEntries(nodeInputs, maxPrompts = 20) {
  const count = Math.max(1, Math.min(maxPrompts, Number(nodeInputs?.["提示词框数量"] || 1)));
  const entries = [];
  for (let index = 1; index <= count; index++) {
    const body = String(nodeInputs?.[`提示词${index}`] || "").trim();
    if (body) entries.push({ index, body });
  }
  return entries;
}

function updateWorkflowListNode(workflow, nodeId, body, maxPrompts) {
  const workflowNode = workflow?.nodes?.find(node => String(node.id) === String(nodeId));
  if (!workflowNode || !Array.isArray(workflowNode.widgets_values)) return;
  // Serialized order: count, prefix, suffix, prompt1...prompt20.
  workflowNode.widgets_values[0] = 1;
  workflowNode.widgets_values[3] = body;
  for (let index = 2; index <= maxPrompts; index++) workflowNode.widgets_values[2 + index] = "";
}

export function queueSubmissionPlan(queueNumber, count) {
  const total = Math.max(0, Number(count) || 0);
  if (Number(queueNumber ?? 0) < 0) {
    // Server executes the smallest queue number first. Submit item 1 as the most
    // negative value so a "queue front" batch still preserves source order.
    return Array.from({ length: total }, (_, index) => -total + index);
  }
  // Zero means "let the server allocate the next monotonically increasing number".
  // Never synthesize 1,2,3 here: those values can sort ahead of the first job.
  return Array(total).fill(0);
}

export function splitPromptListPayload(output, workflow, maxPrompts = 20) {
  const listNodes = Object.entries(output || {}).filter(([, node]) => node?.class_type === PROMPT_LIST_CLASS);
  if (listNodes.length !== 1) return null;

  const [nodeId, listNode] = listNodes[0];
  const entries = promptEntries(listNode.inputs, maxPrompts);
  if (!entries.length) throw new Error("南风提示词列表：请至少填写一个可见提示词框。");
  if (entries.length === 1) return null;

  return entries.map(({ index, body }) => {
    const splitOutput = cloneValue(output);
    const splitWorkflow = cloneValue(workflow);
    const inputs = splitOutput[nodeId].inputs;
    inputs["提示词框数量"] = 1;
    inputs["提示词1"] = body;
    for (let promptIndex = 2; promptIndex <= maxPrompts; promptIndex++) inputs[`提示词${promptIndex}`] = "";
    updateWorkflowListNode(splitWorkflow, nodeId, body, maxPrompts);
    splitWorkflow.extra ||= {};
    splitWorkflow.extra.nanfeng_prompt_list_item = index;
    splitWorkflow.extra.nanfeng_prompt_list_total = entries.length;
    return { output: splitOutput, workflow: splitWorkflow, sourceIndex: index, total: entries.length };
  });
}
