# \[alpha\] Websockets & incremental inputs in the Responses API

Feb 6, 2026

The OpenAI API team is alpha testing a new **websocket connection mode** for the Responses API. It is designed to minimize latency in long-running, agentic workflows with many client-side tool calls and achieves this by:

1. Reusing a persistent websocket connection to reduce per-request network overhead  
2. Accepting incremental inputs instead of resending full context on every turn  
3. Caching previously sent input items in memory for faster application-side processing  
4. Pinning all requests in a session to the same GPU engine to maximize cache locality

In our internal testing we’ve seen this approach **reduce end-to-end latency by 20-40%** for tool-call-heavy agentic rollouts (the higher the number of tool calls, the greater the latency improvement). 

## What is websocket mode?

The primary benefit of websocket mode is reduced latency for multi-turn interactions between the user and the model.

In websocket mode, you will maintain a connection with Responses API and can create follow up Responses by specifying `previous_response_id` and only passing in new inputs from the user into `input`, instead of the entire context.

Responses API will maintain in-memory state for the duration of the connection and minimize redundant work on context items that it has already seen. Because this state is only kept in-memory for the lifetime of the websocket connection, this feature will be compatible with Zero Data Retention.

For coding trajectories with dozens of tool calls and small bursts of reasoning, we've seen significant improvements in e2e latency, in the range of 20-40%. 

For cases where you do want to rewrite conversation history (like after summarization), Websocket mode will still support passing in the entire conversation context in `input` and omitting `previous_response_id`.

## The websocket mode API 

The Response [creation body](https://platform.openai.com/docs/api-reference/responses/create), Response [object](https://platform.openai.com/docs/api-reference/responses/object) and [streaming events](https://platform.openai.com/docs/api-reference/responses-streaming) in websocket mode are identical to those found in Responses API today. The only difference is that you send and receive them over a websocket transport instead of via HTTP/SSE.

Here’s a simple example of what that might look like:

```py
ws = create_connection(
    "wss://api.openai.com/v1/responses",
    header=[
        f"Authorization: Bearer {OPENAI_API_KEY}",
        "OpenAI-Beta: responses_websockets=2026-02-06",
    ],
)


ws.send(json.dumps({
	"type": "response.create",
	"model": "gpt-5.2",
"input": [{
"type": "message",
		"role": "user",
		"content": [{
			"type": "input_text",
"text": "Can you help me find where fizz_buzz() is defined?"
}]
	}],
	"tools": [...],
}))

response, tool_call_tasks = consume_events_and_run_tools(ws)

ws.send(json.dumps({
	"type": "response.create",
	"model": "gpt-5.2",
	"previous_response_id": response["response"]["id"],
	"input": [
		*build_function_call_outputs(tool_call_tasks),
		{
			"type": "message",
			"role": "user",
			"content": [{
				"type": "input_text",
"text": "Can you optimize it to be better than O(n^3)?"
}]
		}
],
	"tools": [...],
}))

response, tool_call_tasks = consume_events_and_run_tools(ws)

# ...


def consume_events_and_run_tools(ws):
	tool_call_tasks = []
	while True:
		frame = ws.recv()
		if not frame:
			break
		evt = json.loads(frame)

		// Update UI based on streaming event
		render_event_to_user(evt)

		if (
evt.get("type") == "response.output_item.done" and
item := evt.get("item")
):
			if item.get("type") == "function_call":
				tool_call_tasks.append(
					asyncio.create_task(run_tool_call(item))
				)

		if evt.get("type") == "response.completed":
			return evt, tool_call_tasks
		
	
		
```

We’ve also created a demo script that will help you compare HTTP mode vs websocket mode latency directly. Here’s an example of how to run it:

```shell
$ python websocket_demo.py websocket
mode=websocket model=gpt-5.2 store=false start=20 runs=5
run 1: 13.166s response_id=resp_08b3bd3a74e12ca701698669ada36c819683c71eb4e1e4c979
run 1 tokens: input_total=9261 input_cached=0 reasoning=0 output=405
run 2: 14.543s response_id=resp_0c078fb6cb32351401698669bbe6ec81a28c4fd7f7c48491a0
run 2 tokens: input_total=9261 input_cached=0 reasoning=0 output=405
run 3: 14.874s response_id=resp_0a2c6b57f300e65e01698669cb19788196944fba23a9d796cb
run 3 tokens: input_total=9261 input_cached=0 reasoning=0 output=405
run 4: 15.540s response_id=resp_00ed788addae7c9001698669d9e3b881909226178a1f339be5
run 4 tokens: input_total=9201 input_cached=0 reasoning=0 output=421
run 5: 13.395s response_id=resp_011bf96e29815d5201698669e7f16c819794a4594e04d61ddc
run 5 tokens: input_total=9261 input_cached=0 reasoning=0 output=405
avg=14.303s median=14.543s


$ python websocket_demo.py http
mode=http model=gpt-5.2 store=false start=20 runs=5
run 1: 19.557s response_id=resp_085ec59f8dad94810169866a1c55648195844d7ee064eb07a3
run 1 tokens: input_total=8631 input_cached=0 reasoning=0 output=405
run 2: 19.150s response_id=resp_0441fe679c9142470169866a2f76b481939f47b9ffb69db640
run 2 tokens: input_total=8631 input_cached=0 reasoning=0 output=405
run 3: 21.156s response_id=resp_0478c0938b3abf1f0169866a4499888192995c3bf6341b240c
run 3 tokens: input_total=8631 input_cached=0 reasoning=0 output=405
run 4: 19.438s response_id=resp_0d26b1bb2f09cc1e0169866a580e5c8191976031341e098c3f
run 4 tokens: input_total=8631 input_cached=0 reasoning=0 output=405
run 5: 21.880s response_id=resp_0217262cb5f1549b0169866a6de0e081a2ae4cb3999c97dd63
run 5 tokens: input_total=8631 input_cached=0 reasoning=0 output=405
avg=20.236s median=19.557s
```

### Implementation notes

**Responses API will only keep the most recent `previous_response_id` state in websocket memory.** 

If you reference older responses, you will receive an error event with code `previous_response_not_found`:

```py
{
  "type": "error",
  "error": {
    "type": "invalid_request_error",
    "code": "previous_response_not_found",
    "message": "Previous response with id 'resp_...' not found.",
    "param": "previous_response_id"
  }
}
```

In order to continue from an older response, you should set `previous_response_id=None` and pass back the entire `input` context.

**The websocket connection has a maximum concurrency of 1\.** 

Any `response.create` calls made while a response is in-progress will be queued and started after the in-progress response is completed.

**Responses API enforces a websocket connection limit of 60 minutes.** 

After 60 minutes, the connection will be closed. You can resume an interrupted conversation by creating a new connection and passing back the full `input` items.

## Share Feedback

Please let us know what you think about websocket mode. We’re eager to hear if you run into any bugs or sharp edges, or if you have suggestions for improving our design. Thank you\!