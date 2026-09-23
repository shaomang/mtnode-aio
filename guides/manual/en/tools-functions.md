# Tool & function nodes

> In one sentence: fix repeated small calculations and small abilities into reusable nodes — a function node pins down the JS input/output conventions, and a tool node registers that ability on the "parameters are ports" footing.

![Tool & function nodes: parameters are ports](img/mtnode-canvas-02-ui.svg)
*Figure: the parameter table is the port table — one more parameter means one more port.*

## Tool / function nodes overview

### Overview

These two nodes are for "turning logic into a reusable node": they can also reach program interfaces outside the app over the local network, for example a Python app or some IoT application.

Such a node is usually implemented by delegating to the AI through the **global assistant**.

- **Function node**: write JS directly. Input = the parameters handed down from upstream, output = whatever you return.
- **Tool node**: define the parameters (ports) clearly, then register that ability so a session can call it on demand.

### Settings

The parameter table is the port table: one more parameter means one more port.

Input port 0 = control input, and 1..N are the input parameters in order; output ports 0..M-1 are the output parameters, and the last position is the control output.

## Function node · node notes

### Under test

This feature lacks test coverage, so use it with care.

### What a function node is

It embeds a JS (Javascript) function, for running scripts and deterministic computation. That function can be called by a tool node and can cover many things a large language model is not good at, replace part of a model's work, or call the interfaces of other programs externally. Writing it by hand is not recommended — have the AI write the function node as needed.

### Input / output conventions

- **Input**: `input = { 参数名: 值 }`; an image parameter is `{ kind: "image", path }`.
- **Output**: `return { 输出名: 值 }`, with key names matching the output port table.
- **Port order**: input port 0 = control input, and 1..N are the parameters in order; output ports 0..M-1 are the outputs, and the last position is the control output.

## Tool node · node notes

### Under test

This feature lacks test coverage, so use it with care.

### What a tool node is

Tool node = a super node + a wrapper node around several function nodes and other nodes. Once registered, agent nodes and sessions can call it directly.

### Key parameters

- **Name / description**: the AI decides when to use it from that description. Spell out "when to use it + what goes in + what comes out".
- **Input / output port tables**: these are its parameters and return values; the port type (text / image) decides whether a wire can connect and how downstream selection works.

### Where it is used

By combining various nodes you can solidify a workflow into a tool that is reusable inside a session.
