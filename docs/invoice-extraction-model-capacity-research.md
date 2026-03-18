# Invoice Extraction Model Capacity Research

## Current approach

- Model: `@cf/openai/gpt-oss-120b`
- Execution path: Workers AI via AI Gateway REST API
- Cache bypass: enabled with `cf-aig-skip-cache: true`
- Structured output path: Responses API with JSON schema
- Current output ceiling: `max_output_tokens = 16_384`

## Main findings

### Earlier Workers AI models were not viable for this task

On the full invoice schema with many line items, the earlier models we tried failed through timeout, `JSON Mode couldn't be met`, or malformed JSON.

### `@cf/openai/gpt-oss-120b` is materially better

This is the first model/path that has repeatedly returned the full invoice schema for this input.

Observed uncached REST runs were roughly:

- `57.6s` success
- `57.9s` success
- one earlier failure around `73.5s` caused by output truncation when the token ceiling was lower

### Output length mattered

With `max_output_tokens = 8192`, one uncached run failed with truncated JSON and `incomplete_details.reason = "max_output_tokens"`.

After raising the ceiling to `16_384`, subsequent uncached REST runs succeeded.

### Binding is not reliable enough for this workload

We tested the Workers AI binding as well.

- one binding run succeeded in about `51.9s`
- another binding run failed with `504 Gateway Time-out` after about `60.2s`

The important part: AI Gateway showed that failed binding run actually completed upstream in about `90.5s` and returned a full response.

So the binding caller timed out before the model run finished. That makes binding a poor fit here even though the model itself can succeed.

## Conclusion

For this invoice extraction workload:

- `@cf/openai/gpt-oss-120b` is viable
- AI Gateway REST is the right execution path
- Workers AI binding is not reliable enough and should not be pursued further

## Practical recommendation

Use REST via AI Gateway for invoice extraction.

It gives us:

- enough time for long runs
- better observability
- explicit cache control
- a working path for `@cf/openai/gpt-oss-120b`
