# Factory Droid CLI - Gemini 3 Pro Compatibility Proxy

A transparent HTTP proxy that fixes compatibility issues between [Factory Droid CLI](https://github.com/yourusername/factory-droid) and Google's Gemini 3.0 Pro Preview model via the OpenAI-compatible API.

## The Problem

When using Gemini 3.0 Pro Preview (gemini-3-pro-preview) with Factory Droid CLI through Google's OpenAI compatibility endpoint, you encounter intermittent **400 errors** after the first tool execution:

```
LIST DIRECTORY (some/path)
✓ Listed 25 items.

Error: 400 status code (no body)
```

The pattern is consistent:
- First request with tools → ✅ Success
- Tool execution → ✅ Success
- Subsequent request with conversation history → ❌ 400 Error

## Root Cause

Gemini's OpenAI-compatible API has two issues that cause failures:

### 1. Missing Thought Signatures (Primary Issue)

Gemini 3 Pro **requires** `thought_signature` metadata in function calls during multi-turn conversations. This is a Gemini-specific extension to the OpenAI API format.

**Expected flow:**
1. Client sends tools → Gemini responds with tool_calls containing `thought_signature`
2. Client sends conversation history → **MUST** include the `thought_signature` from step 1
3. Without the signature → 400 error: `"Function call is missing a thought_signature"`

**The issue:** Factory Droid (like most OpenAI clients) doesn't know about Gemini's thought signatures and doesn't preserve them in conversation history.

### 2. Unsupported JSON Schema Constructs

Gemini's OpenAI API is more restrictive than actual OpenAI and rejects schemas containing:

- `format: "uri"` (only `"enum"` and `"date-time"` are supported)
- `anyOf`, `oneOf`, `allOf`, `not` combinators
- `$ref`, `$schema`, `$id` metadata
- `prefixItems`, `patternProperties`
- `additionalProperties: false`
- Type arrays like `["string", "null"]`
- And many others...

## The Solution

This proxy sits between Factory Droid and Gemini, transparently fixing both issues:

```
Factory Droid → Proxy (localhost:8319) → Gemini API
            ↑                          ↓
            └──────── Responses ────────┘
```

**What it does:**

1. **Schema Sanitization** (Outbound)
   - Removes unsupported JSON Schema constructs from tool definitions
   - Converts type arrays to `type + nullable`
   - Strips metadata and unsupported constraints

2. **Thought Signature Management** (Bidirectional)
   - **Gemini → Factory:** Extracts thought signatures from Gemini responses, stores them
   - **Factory → Gemini:** Injects stored signatures into conversation history
   - **Fallback:** Uses `"skip_thought_signature_validator"` for missing signatures

3. **Enhanced Logging**
   - Decompresses gzip responses for readable error messages
   - Logs signature storage and injection
   - Shows detailed error information

## Installation

### Prerequisites

- Node.js (v12 or higher)
- Factory Droid CLI installed
- Google AI API key for Gemini

### Setup

1. **Download the proxy script:**

```bash
# Clone this repository or download gemini-proxy.js
wget https://github.com/yourusername/factory-gemini3/raw/main/gemini-proxy.js
chmod +x gemini-proxy.js
```

2. **Start the proxy:**

```bash
node gemini-proxy.js
```

Or run in background:

```bash
node gemini-proxy.js &
```

You should see:

```
[Gemini Proxy] Running on http://localhost:8319
[Gemini Proxy] Forwarding requests to https://generativelanguage.googleapis.com
[Gemini Proxy] Tool schemas will be sanitized automatically
```

3. **Configure Factory Droid:**

Edit your Factory config file (usually `~/.factory/config.json`):

```json
{
  "custom_models": [
    {
      "model_display_name": "Gemini 3.0 Pro Preview (Thinking) [Google]",
      "model": "gemini-3-pro-preview",
      "base_url": "http://localhost:8319/v1beta/openai/",
      "api_key": "YOUR_GOOGLE_AI_API_KEY",
      "provider": "generic-chat-completion-api",
      "reasoning_effort": "high",
      "max_tokens": 65536
    }
  ]
}
```

**Key changes:**
- `base_url`: Point to proxy instead of direct Gemini endpoint
- Keep the `/v1beta/openai/` path suffix

4. **Use Factory Droid normally:**

```bash
droid --model "gemini-3-pro-preview"
```

The 400 errors should be completely gone!

## Configuration

### Change Proxy Port

If port 8319 is in use, edit `gemini-proxy.js`:

```javascript
const PROXY_PORT = 8319; // Change to your preferred port
```

Then update Factory config's `base_url` to match.

### Run as System Service

**macOS (launchd):**

Create `~/Library/LaunchAgents/com.factory.gemini-proxy.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.factory.gemini-proxy</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>/path/to/gemini-proxy.js</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.factory.gemini-proxy.plist
```

**Linux (systemd):**

Create `/etc/systemd/system/gemini-proxy.service`:

```ini
[Unit]
Description=Gemini Proxy for Factory Droid
After=network.target

[Service]
Type=simple
User=youruser
ExecStart=/usr/bin/node /path/to/gemini-proxy.js
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable gemini-proxy
sudo systemctl start gemini-proxy
```

## How It Works

### Request Flow

1. **Initial Request (Factory → Proxy → Gemini)**
   ```json
   {
     "model": "gemini-3-pro-preview",
     "messages": [...],
     "tools": [/* 12 tools with schemas */]
   }
   ```

   **Proxy actions:**
   - Sanitizes all tool schemas (removes unsupported constructs)
   - Forwards to Gemini

   **Result:** ✅ Success

2. **Gemini Response (Gemini → Proxy → Factory)**
   ```json
   {
     "choices": [{
       "message": {
         "tool_calls": [{
           "id": "call-abc123",
           "extra_content": {
             "google": {
               "thought_signature": "ENCRYPTED_SIGNATURE_HERE"
             }
           },
           "function": {...}
         }]
       }
     }]
   }
   ```

   **Proxy actions:**
   - Extracts thought signature from `extra_content.google.thought_signature`
   - Stores: `thoughtSignatures.set("call-abc123", "ENCRYPTED_SIGNATURE_HERE")`
   - Forwards response unchanged to Factory

3. **Follow-up Request (Factory → Proxy → Gemini)**
   ```json
   {
     "messages": [
       {"role": "user", "content": "..."},
       {
         "role": "assistant",
         "tool_calls": [{"id": "call-abc123", ...}]  // No signature!
       },
       {"role": "tool", "tool_call_id": "call-abc123", "content": "..."}
     ]
   }
   ```

   **Proxy actions:**
   - Detects assistant message with tool_calls
   - Looks up stored signature for `call-abc123`
   - Injects signature into `extra_content.google.thought_signature`
   - Forwards modified request to Gemini

   **Result:** ✅ Success (was previously 400)

### Parallel Tool Calls

When multiple tools are called in parallel:
- **Only the first** tool_call gets the thought_signature
- Subsequent calls in the same turn have no signature

The proxy respects this rule by only injecting signatures on the first tool_call.

### Sequential Tool Calls

In multi-step tool execution:
- Each step gets its own signature
- All signatures from the current turn must be preserved

The proxy tracks all signatures by `tool_call_id`.

### Rate Limit Handling (429 Errors)

The proxy automatically handles Gemini API rate limits with **exponential backoff retry**:

**How it works:**
1. When Gemini returns 429 (Too Many Requests)
2. Proxy waits with exponential backoff: 1s, 2s, 4s, 8s, 16s
3. Respects `Retry-After` header if provided by Gemini
4. Retries up to 5 times before giving up
5. Transparent to Factory Droid (eventual success or final failure)

**Example flow:**
```
Request → 429 → Wait 1s → Retry → 429 → Wait 2s → Retry → 200 OK ✓
```

**Logging:**
```
[Proxy] 429 Rate Limited - Retry 1/4 after 1000ms
[Proxy] 429 Rate Limited - Retry 2/4 after 2000ms
[Proxy] ✓ Success with 12 tools
```

**Common scenarios:**
- **Tool retry storms**: When a tool fails and Factory retries multiple times rapidly, rate limits can trigger
- **Long sessions**: Heavy tool usage over extended periods
- **Concurrent requests**: Multiple Factory Droid instances using same API key

**What you see:**
- **With retry**: Brief pause, then request succeeds automatically
- **Max retries exceeded**: Final 429 error propagated to Factory Droid

The proxy makes rate limiting transparent in most cases, automatically recovering from temporary rate limit spikes.

## Logging

The proxy provides detailed logging:

```
[Proxy] POST /v1beta/openai/chat/completions
[Proxy] Sanitizing 12 tools...
[Proxy] ✓ Success with 12 tools
[Proxy] Stored signature for call-abc123
[Proxy] Stored signature for call-def456
[Proxy] ✓ Success with 12 tools
```

**On errors:**
```
[Proxy] ERROR 400:
{
  "error": {
    "code": 400,
    "message": "Function call is missing a thought_signature...",
    "status": "INVALID_ARGUMENT"
  }
}

[Proxy] Request included tools:
  1. Read
  2. LS
  3. Execute
  ...
```

## Troubleshooting

### Still Getting 400 Errors

**Check proxy is running:**
```bash
lsof -i:8319
```

Should show the Node.js process.

**Check Factory config:**
- Ensure `base_url` points to `http://localhost:8319/v1beta/openai/`
- Keep the `/v1beta/openai/` path suffix

**Check proxy logs:**
- Look for `[Proxy] Stored signature for...` messages
- If missing, signatures aren't being extracted

### Port Already in Use

```
[Error] Port 8319 is already in use
```

**Solution 1:** Kill existing process
```bash
lsof -ti:8319 | xargs kill
```

**Solution 2:** Change port in proxy script and Factory config

### Signatures Not Being Stored

If you see errors but no `Stored signature` messages:

1. Check Gemini is returning tool_calls in responses
2. Verify response structure matches expected format
3. Enable debug logging in proxy (add `console.log` statements)

### Connection Refused

```
Error: connect ECONNREFUSED 127.0.0.1:8319
```

Proxy isn't running. Start it:
```bash
node gemini-proxy.js &
```

### Still Getting 429 Errors After Retries

If you see:
```
[Proxy] 429 Rate Limited - Max retries (5) exceeded
Error: 429 status code (no body)
```

**Causes:**
- Sustained high request rate exceeding Gemini's limits
- Multiple Factory Droid instances sharing same API key
- Gemini free tier limits hit

**Solutions:**

1. **Reduce concurrency:** Avoid running multiple Factory Droid instances simultaneously
2. **Upgrade API tier:** Check Google AI Studio for higher rate limits
3. **Add delays:** If using Factory programmatically, add delays between requests
4. **Check quotas:** Visit https://aistudio.google.com to view your API quota usage

**Temporary workaround:**
Wait 1-2 minutes for rate limits to reset, then retry your request.

## Technical Details

### Sanitization Rules

The proxy removes these JSON Schema constructs:

**Metadata:**
- `$ref`, `$schema`, `$id`, `definitions`, `$defs`

**Combinators:**
- `anyOf`, `oneOf`, `allOf`, `not`

**Array features:**
- `prefixItems`, `contains`, `minContains`, `maxContains`

**Object features:**
- `propertyNames`, `patternProperties`, `dependentSchemas`, `dependentRequired`

**Constraints:**
- `exclusiveMaximum`, `exclusiveMinimum`, `const`
- `contentEncoding`, `contentMediaType`
- `minimum`/`maximum` on non-numeric types

**Format:**
- Removes all `format` values except `"enum"` and `"date-time"`

**Type arrays:**
- `["string", "null"]` → `{type: "string", nullable: true}`

**Additional properties:**
- `additionalProperties: false` → removed

**Empty arrays:**
- `required: []` → removed

### Thought Signature Format

Thought signatures are encrypted representations of Gemini's internal reasoning process. Format:

```json
{
  "extra_content": {
    "google": {
      "thought_signature": "<base64-encoded-encrypted-data>"
    }
  }
}
```

**Workaround signature:** `"skip_thought_signature_validator"`
- Used when signature wasn't captured from Gemini
- Tells Gemini to skip validation (for imported conversations)

## Performance

- **Latency overhead:** ~1-5ms (schema sanitization + signature lookup)
- **Memory usage:** Minimal (stores only thought signatures in Map)
- **Signature storage:** Unbounded (clears when proxy restarts)

For long-running sessions, consider periodically restarting the proxy to clear old signatures.

## Limitations

1. **Streaming not fully tested:** May not capture signatures from streaming responses
2. **Signature storage:** Lost on proxy restart (use workaround signature)
3. **No persistence:** Signatures not saved to disk
4. **Single-session:** Not designed for multi-user scenarios

## Contributing

Contributions welcome! Please:

1. Test thoroughly with Factory Droid
2. Preserve backward compatibility
3. Document any new workarounds
4. Add logging for debugging

## References

- [Gemini Thought Signatures Documentation](https://ai.google.dev/gemini-api/docs/thought-signatures)
- [Gemini OpenAI Compatibility](https://ai.google.dev/gemini-api/docs/openai)
- [Factory Droid CLI](https://github.com/yourusername/factory-droid)

## License

MIT License - Feel free to use and modify

## Acknowledgments

Built to solve real-world compatibility issues between Factory Droid CLI and Gemini 3.0 Pro Preview. Special thanks to the Factory Droid team and Google AI for providing excellent tools.

---

**Questions or issues?** Open an issue on GitHub or contact the maintainer.
