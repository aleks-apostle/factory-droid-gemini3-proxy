#!/usr/bin/env node
/**
 * Gemini Schema Sanitizer Proxy
 *
 * This proxy intercepts requests to Gemini API and sanitizes tool schemas
 * to fix 400 errors caused by unsupported JSON Schema constructs.
 *
 * Features:
 * - Phase 1: Schema sanitization for Gemini compatibility
 * - Phase 2: Thought signature extraction and injection
 * - Phase 3: Streaming support with real-time signature extraction
 * - Phase 4: Multi-user support with per-conversation isolation
 *
 * Phase 4 Implementation:
 * - Conversation IDs generated from client IP + User-Agent (SHA-256 hash)
 * - Support for explicit X-Conversation-ID header
 * - Nested Map structure: Map<conversation_id, Map<tool_call_id, {signature, timestamp}>>
 * - Cleanup: Max 100 signatures per conversation, 1-hour TTL, auto-remove empty conversations
 *
 * Usage: Run this proxy, then configure Gemini base_url to: http://localhost:8319/v1beta/openai/
 */

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { URL } = require('url');

const GEMINI_API = 'generativelanguage.googleapis.com';
const PROXY_PORT = 8319;

// Storage for thought signatures per conversation
// Structure: Map<conversation_id, Map<tool_call_id, {signature, timestamp}>>
const conversationSignatures = new Map();

// Generate a conversation ID from request headers
// Uses client IP + User-Agent + optional X-Conversation-ID header
function generateConversationId(req) {
  const crypto = require('crypto');

  // Check for explicit conversation ID header first
  const explicitId = req.headers['x-conversation-id'];
  if (explicitId) {
    return `explicit:${explicitId}`;
  }

  // Build identifier from request characteristics
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const userAgent = req.headers['user-agent'] || 'unknown';

  // Create a hash to keep IDs short and consistent per session
  const hash = crypto.createHash('sha256')
    .update(`${clientIp}:${userAgent}`)
    .digest('hex')
    .substring(0, 16);

  return `auto:${hash}`;
}

// Clean old signatures to prevent memory leaks
function cleanupSignatures() {
  const now = Date.now();
  const oneHourAgo = now - (60 * 60 * 1000);

  // Clean up each conversation's signatures
  for (const [conversationId, signaturesMap] of conversationSignatures.entries()) {
    // Remove signatures older than 1 hour within this conversation
    for (const [toolCallId, data] of signaturesMap.entries()) {
      if (data.timestamp < oneHourAgo) {
        signaturesMap.delete(toolCallId);
      }
    }

    // If conversation has no signatures left, remove it entirely
    if (signaturesMap.size === 0) {
      conversationSignatures.delete(conversationId);
      continue;
    }

    // Keep each conversation to max 100 entries (remove oldest)
    if (signaturesMap.size > 100) {
      const entries = Array.from(signaturesMap.entries());
      entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
      const toRemove = entries.slice(0, signaturesMap.size - 100);
      toRemove.forEach(([id]) => signaturesMap.delete(id));
    }
  }

  // Log cleanup summary
  console.log(`[Proxy] Cleanup: ${conversationSignatures.size} active conversation(s)`);
}

// Sanitize JSON Schema to be Gemini-compatible
function sanitizeSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;

  const clean = Array.isArray(schema) ? [...schema] : { ...schema };

  // Remove JSON Schema metadata (not supported by Gemini OpenAI API)
  delete clean.$ref;
  delete clean.$schema;
  delete clean.$id;
  delete clean.definitions;
  delete clean.$defs;

  // Remove unsupported schema combinators
  delete clean.anyOf;
  delete clean.oneOf;
  delete clean.allOf;
  delete clean.not;

  // Remove unsupported numeric/string constraints
  delete clean.exclusiveMaximum;
  delete clean.exclusiveMinimum;
  delete clean.const;
  delete clean.contentEncoding;
  delete clean.contentMediaType;

  // Remove unsupported array features
  delete clean.prefixItems;  // Tuple-style arrays not supported
  delete clean.contains;
  delete clean.minContains;
  delete clean.maxContains;

  // Remove unsupported object features
  delete clean.propertyNames;
  delete clean.patternProperties;  // Often causes issues
  delete clean.dependentSchemas;
  delete clean.dependentRequired;

  // Remove unsupported format values (only enum and date-time are supported)
  if (clean.format && !['enum', 'date-time'].includes(clean.format)) {
    delete clean.format;
  }

  // Handle type arrays (e.g., ["string", "null"])
  if (Array.isArray(clean.type)) {
    const hasNull = clean.type.includes('null');
    const nonNullType = clean.type.find(t => t !== 'null');
    if (nonNullType) {
      clean.type = nonNullType;
      if (hasNull) clean.nullable = true;
    } else {
      clean.type = 'string';
    }
  }

  // Handle additionalProperties: false (not well supported)
  if (clean.additionalProperties === false) {
    delete clean.additionalProperties;
  }

  // Remove empty required arrays
  if (Array.isArray(clean.required) && clean.required.length === 0) {
    delete clean.required;
  }

  // Remove minimum/maximum from non-numeric types
  if (clean.type && !['number', 'integer'].includes(clean.type)) {
    delete clean.minimum;
    delete clean.maximum;
    delete clean.multipleOf;
  }

  // Recursively sanitize nested objects
  if (clean.properties && typeof clean.properties === 'object') {
    const props = {};
    for (const [key, value] of Object.entries(clean.properties)) {
      props[key] = sanitizeSchema(value);
    }
    clean.properties = props;
  }

  if (clean.items) {
    clean.items = sanitizeSchema(clean.items);
  }

  if (clean.additionalProperties && typeof clean.additionalProperties === 'object') {
    clean.additionalProperties = sanitizeSchema(clean.additionalProperties);
  }

  return clean;
}

// Sanitize tools array
function sanitizeTools(tools) {
  if (!Array.isArray(tools)) return tools;

  return tools.map(tool => {
    if (!tool?.function?.parameters) return tool;

    return {
      ...tool,
      function: {
        ...tool.function,
        parameters: sanitizeSchema(tool.function.parameters)
      }
    };
  });
}

// Extract thought signatures from Gemini response
function extractThoughtSignatures(responseData, conversationId) {
  try {
    const data = JSON.parse(responseData.toString());

    // Handle both streaming and non-streaming responses
    const choices = data.choices || [];

    for (const choice of choices) {
      const message = choice.message || choice.delta;
      if (!message?.tool_calls) continue;

      for (const toolCall of message.tool_calls) {
        // Validate tool call structure before accessing properties
        if (!toolCall || typeof toolCall !== 'object') {
          console.warn('[Proxy] WARNING: Invalid tool call (not an object), skipping');
          continue;
        }
        if (!toolCall.id || typeof toolCall.id !== 'string' || toolCall.id.trim() === '') {
          console.warn('[Proxy] WARNING: Tool call missing valid id, skipping');
          continue;
        }
        if (!toolCall.function) {
          console.warn(`[Proxy] WARNING: Tool call ${toolCall.id} missing function, skipping`);
          continue;
        }
        if (!toolCall.function.name) {
          console.warn(`[Proxy] WARNING: Tool call ${toolCall.id} missing function.name, skipping`);
          continue;
        }

        const signature = toolCall.extra_content?.google?.thought_signature;
        if (signature && toolCall.id) {
          // Get or create signatures map for this conversation
          if (!conversationSignatures.has(conversationId)) {
            conversationSignatures.set(conversationId, new Map());
          }
          const signaturesMap = conversationSignatures.get(conversationId);

          // Store signature with timestamp
          signaturesMap.set(toolCall.id, {
            signature,
            timestamp: Date.now()
          });
          console.log(`[Proxy] Stored signature for ${toolCall.id} (conversation: ${conversationId})`);
        }
      }
    }
  } catch (e) {
    // Not JSON or no tool calls, skip
    console.error('[Proxy] Error extracting thought signatures:', e.message);
  }
}

// Convert Gemini error format to OpenAI format
function convertGeminiErrorToOpenAI(responseData) {
  try {
    const data = JSON.parse(responseData.toString());

    // Check if this is a Gemini error format: {error: {code, message, status}}
    if (data.error && typeof data.error === 'object') {
      const geminiError = data.error;

      // Convert to OpenAI format: {error: {message, type, code}}
      return JSON.stringify({
        error: {
          message: geminiError.message || 'Unknown error',
          type: geminiError.status || 'api_error',
          code: geminiError.code || null
        }
      });
    }

    // Already in correct format or not an error, return as-is
    return responseData.toString();
  } catch (e) {
    // Not valid JSON, return as-is
    return responseData.toString();
  }
}

// Inject thought signatures into Factory request
function injectThoughtSignatures(requestData, conversationId) {
  if (!requestData?.messages) return requestData;

  // Get signatures map for this conversation (or empty map if none exists)
  const signaturesMap = conversationSignatures.get(conversationId) || new Map();

  const messages = requestData.messages.map(msg => {
    // Only process assistant messages with tool_calls
    if (msg.role !== 'assistant' || !msg.tool_calls) return msg;

    const toolCalls = msg.tool_calls.map((toolCall, idx) => {
      // Get stored signature or use workaround
      const signatureData = signaturesMap.get(toolCall.id);
      const signature = signatureData?.signature || 'skip_thought_signature_validator';

      // Only inject on first tool call (parallel calls rule)
      if (idx === 0) {
        return {
          ...toolCall,
          extra_content: {
            google: {
              thought_signature: signature
            }
          }
        };
      }

      return toolCall;
    });

    return {
      ...msg,
      tool_calls: toolCalls
    };
  });

  return {
    ...requestData,
    messages
  };
}

// Helper: Parse SSE (Server-Sent Events) chunks from streaming responses
// SSE format: "data: {...}\n\n"
function parseSSEChunks(buffer) {
  const text = buffer.toString('utf8');
  const chunks = [];
  const lines = text.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // SSE data lines start with "data: "
    if (line.startsWith('data: ')) {
      const dataStr = line.substring(6); // Remove "data: " prefix

      // Skip [DONE] marker
      if (dataStr === '[DONE]') continue;

      try {
        const data = JSON.parse(dataStr);
        chunks.push(data);
      } catch (e) {
        // Invalid JSON, skip this chunk
        console.warn('[Proxy] Invalid JSON in SSE chunk:', e.message);
      }
    }
  }

  return chunks;
}

// Helper: Extract signatures from streaming chunks
// Streaming responses send tool_calls incrementally across multiple chunks
// We need to accumulate tool_call data by index until we have both id and signature
function extractSignaturesFromStreamChunks(chunks, accumulatedToolCalls, conversationId) {
  for (const chunk of chunks) {
    const choices = chunk.choices || [];

    for (const choice of choices) {
      const delta = choice.delta;
      if (!delta?.tool_calls) continue;

      for (const toolCallDelta of delta.tool_calls) {
        // Each streaming chunk has an index to identify which tool_call it's updating
        const index = toolCallDelta.index;
        if (index === undefined) continue;

        // Initialize accumulator for this index if needed
        if (!accumulatedToolCalls[index]) {
          accumulatedToolCalls[index] = {
            id: null,
            function: { name: null, arguments: '' },
            extra_content: null
          };
        }

        const accumulated = accumulatedToolCalls[index];

        // Merge in new data from this chunk
        if (toolCallDelta.id) {
          accumulated.id = toolCallDelta.id;
        }
        if (toolCallDelta.function) {
          if (toolCallDelta.function.name) {
            accumulated.function.name = toolCallDelta.function.name;
          }
          if (toolCallDelta.function.arguments) {
            accumulated.function.arguments += toolCallDelta.function.arguments;
          }
        }
        if (toolCallDelta.extra_content) {
          accumulated.extra_content = toolCallDelta.extra_content;
        }

        // If we now have both id and signature, store it
        const signature = accumulated.extra_content?.google?.thought_signature;
        if (accumulated.id && signature) {
          // Get or create signatures map for this conversation
          if (!conversationSignatures.has(conversationId)) {
            conversationSignatures.set(conversationId, new Map());
          }
          const signaturesMap = conversationSignatures.get(conversationId);

          // Store signature with timestamp
          signaturesMap.set(accumulated.id, {
            signature,
            timestamp: Date.now()
          });
          console.log(`[Proxy] Stored signature for ${accumulated.id} (streaming, conversation: ${conversationId})`);
        }
      }
    }
  }
}

// Retry with exponential backoff for 429 errors
// Supports both streaming and non-streaming modes
async function makeRequestWithRetry(options, body, requestData, conversationId, clientRes = null, maxRetries = 5) {
  // Detect streaming mode
  const isStreaming = requestData?.stream === true;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const result = await new Promise((resolve, reject) => {
        const proxyReq = https.request(options, (proxyRes) => {
          let responseBody = [];
          let lastChunkTime = Date.now();

          // For streaming: accumulate tool_calls across chunks to extract signatures
          const accumulatedToolCalls = {};

          // Timeout: 60s for complete response
          const responseTimeout = setTimeout(() => {
            proxyReq.destroy();
            reject(new Error('Response timeout after 60s'));
          }, 60000);

          // Timeout: 30s idle between chunks
          const idleTimeout = setInterval(() => {
            if (Date.now() - lastChunkTime > 30000) {
              clearInterval(idleTimeout);
              clearTimeout(responseTimeout);
              proxyReq.destroy();
              reject(new Error('Idle timeout - no data for 30s'));
            }
          }, 5000);

          // STREAMING MODE: Forward chunks immediately while extracting signatures
          if (isStreaming && clientRes) {
            // Write response headers immediately for streaming
            clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);

            proxyRes.on('data', chunk => {
              lastChunkTime = Date.now();

              // Forward chunk to client immediately (real-time streaming)
              clientRes.write(chunk);

              // Also buffer for signature extraction
              responseBody.push(chunk);

              // Try to extract signatures from this chunk
              try {
                const sseChunks = parseSSEChunks(chunk);
                extractSignaturesFromStreamChunks(sseChunks, accumulatedToolCalls, conversationId);
              } catch (e) {
                // Don't break streaming if signature extraction fails
                console.warn('[Proxy] Error extracting signatures from stream chunk:', e.message);
              }
            });

            proxyRes.on('end', () => {
              clearTimeout(responseTimeout);
              clearInterval(idleTimeout);

              // End client response
              clientRes.end();

              const responseData = Buffer.concat(responseBody);

              // DIAGNOSTIC: Extract and log finish_reason from streaming response
              // This helps debug why agent stops after 2-3 tool calls
              try {
                const chunks = parseSSEChunks(responseData);
                let lastFinishReason = null;
                let hasToolCalls = false;
                let contentLength = 0;

                // Find finish_reason from chunks
                for (const chunk of chunks) {
                  const choices = chunk.choices || [];
                  for (const choice of choices) {
                    if (choice.finish_reason) {
                      lastFinishReason = choice.finish_reason;
                    }
                    if (choice.delta?.tool_calls) {
                      hasToolCalls = true;
                    }
                    if (choice.delta?.content) {
                      contentLength += choice.delta.content.length;
                    }
                  }
                }

                // Log finish_reason if found
                if (lastFinishReason) {
                  console.log(`[Proxy] Streaming finish_reason: ${lastFinishReason}`);

                  // Check if this request contains tool results
                  const hasToolResults = requestData?.messages?.some(m => m.role === 'tool');

                  if (hasToolResults) {
                    console.log(`[Proxy] After tool results - finish_reason: ${lastFinishReason}`);
                    console.log(`[Proxy]   has_tool_calls: ${hasToolCalls}`);
                    console.log(`[Proxy]   content_length: ${contentLength}`);

                    // Validate finish_reason matches response state
                    if (hasToolCalls && lastFinishReason === 'stop') {
                      console.warn(`[Proxy] ⚠️  WARNING: Response has tool_calls but finish_reason is "stop" (expected "tool_calls")`);
                    }
                    if (lastFinishReason === 'stop' && !hasToolCalls && contentLength === 0) {
                      console.warn(`[Proxy] ⚠️  WARNING: Empty response with finish_reason "stop" - agent may halt prematurely`);
                    }
                    if (lastFinishReason === 'length') {
                      console.warn(`[Proxy] ⚠️  WARNING: Context limit hit (finish_reason: "length") - response truncated`);
                    }
                  }
                }
              } catch (e) {
                console.warn('[Proxy] Could not extract finish_reason from streaming response:', e.message);
              }

              resolve({
                statusCode: proxyRes.statusCode,
                headers: proxyRes.headers,
                responseData,
                decompressedData: responseData, // No gzip in SSE streams
                streaming: true
              });
            });
          }
          // NON-STREAMING MODE: Buffer entire response (original behavior)
          else {
            proxyRes.on('data', chunk => {
              lastChunkTime = Date.now();
              responseBody.push(chunk);
            });

            proxyRes.on('end', () => {
              clearTimeout(responseTimeout);
              clearInterval(idleTimeout);

              const responseData = Buffer.concat(responseBody);

              // Decompress gzip if needed
              const isGzipped = proxyRes.headers['content-encoding'] === 'gzip';
              const decompressedData = isGzipped
                ? zlib.gunzipSync(responseData)
                : responseData;

              resolve({
                statusCode: proxyRes.statusCode,
                headers: proxyRes.headers,
                responseData,
                decompressedData,
                streaming: false
              });
            });
          }
        });

        // Timeout: 30s for connection
        proxyReq.setTimeout(30000, () => {
          proxyReq.destroy();
          reject(new Error('Connection timeout after 30s'));
        });

        proxyReq.on('error', reject);
        proxyReq.write(body);
        proxyReq.end();
      });

      // Extract thought signatures from successful responses (non-streaming only)
      // For streaming, signatures were already extracted in real-time
      if (result.statusCode >= 200 && result.statusCode < 300 && !result.streaming) {
        extractThoughtSignatures(result.decompressedData, conversationId);

        // Log response details when tool results were sent (for debugging continuation)
        const hasToolResults = requestData?.messages?.some(m => m.role === 'tool');
        if (hasToolResults) {
          try {
            const data = JSON.parse(result.decompressedData.toString());
            console.log('[Proxy] Response after tool results:');
            data.choices?.forEach((choice, idx) => {
              const finishReason = choice.finish_reason;
              const hasToolCalls = !!choice.message?.tool_calls;
              const contentLength = choice.message?.content?.length || 0;

              console.log(`  finish_reason: ${finishReason}`);
              console.log(`  content_length: ${contentLength}`);
              console.log(`  has_tool_calls: ${hasToolCalls}`);

              // Validate finish_reason matches response state
              if (hasToolCalls && finishReason === 'stop') {
                console.warn(`  ⚠️  WARNING: Response has tool_calls but finish_reason is "stop" (expected "tool_calls")`);
              }
              if (finishReason === 'length') {
                console.warn(`  ⚠️  WARNING: Context limit hit (finish_reason: "length") - response may be truncated`);
              }
            });
          } catch (e) {
            console.error('[Proxy] Error logging response details:', e.message);
          }
        }
      }

      // For streaming responses, skip retry logic - response already sent to client
      if (result.streaming) {
        console.log('[Proxy] Streaming response completed');
        return result;
      }

      // Handle 429 - retry with longer exponential backoff
      if (result.statusCode === 429) {
        const retryAfter = result.headers['retry-after'];
        // Longer delays: 2s, 5s, 10s, 20s, 40s
        const delays = [2000, 5000, 10000, 20000, 40000];
        const delay = retryAfter
          ? parseInt(retryAfter) * 1000
          : delays[attempt] || delays[delays.length - 1];

        if (attempt < maxRetries - 1) {
          console.log(`[Proxy] 429 Rate Limited - Retry ${attempt + 1}/${maxRetries - 1} after ${delay}ms`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue; // Retry
        } else {
          console.error(`[Proxy] 429 Rate Limited - Max retries (${maxRetries}) exceeded`);
        }
      }

      // Handle 503 - retry with faster recovery
      if (result.statusCode === 503) {
        const max503Retries = 3;
        if (attempt < max503Retries) {
          const delay = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
          console.log(`[Proxy] 503 Service Unavailable - Retry ${attempt + 1}/${max503Retries} after ${delay}ms`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue; // Retry
        } else {
          console.error(`[Proxy] 503 Service Unavailable - Max retries (${max503Retries}) exceeded`);
        }
      }

      // Log errors with full details
      if (result.statusCode >= 400) {
        console.error(`\n[Proxy] ERROR ${result.statusCode}:`);
        try {
          const errorJson = JSON.parse(result.decompressedData.toString());
          console.error(JSON.stringify(errorJson, null, 2));
        } catch (e) {
          console.error(result.decompressedData.toString());
        }

        // Log which tools were sent
        if (requestData?.tools) {
          console.error('\n[Proxy] Request included tools:');
          requestData.tools.forEach((tool, idx) => {
            console.error(`  ${idx + 1}. ${tool.function?.name || 'unnamed'}`);
          });
        }
        console.error('');
      } else if (requestData?.tools) {
        console.log(`[Proxy] ✓ Success with ${requestData.tools.length} tools`);
      }

      return result;
    } catch (error) {
      if (attempt === maxRetries - 1) {
        throw error;
      }
      console.error(`[Proxy] Request error (attempt ${attempt + 1}): ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempt)));
    }
  }
}

// Create proxy server
const server = http.createServer((clientReq, clientRes) => {
  console.log(`[Proxy] ${clientReq.method} ${clientReq.url}`);

  // Generate conversation ID for this request
  const conversationId = generateConversationId(clientReq);
  console.log(`[Proxy] Conversation ID: ${conversationId}`);

  // Cleanup old signatures on each request
  cleanupSignatures();

  // Collect request body
  let body = [];
  clientReq.on('data', chunk => body.push(chunk));
  clientReq.on('end', () => {
    body = Buffer.concat(body);

    // Parse and sanitize if it's a chat completion request
    let requestData;
    try {
      requestData = JSON.parse(body.toString());

      // Log streaming mode detection
      if (requestData.stream === true) {
        console.log('[Proxy] STREAMING mode detected');
      }

      // Sanitize tool schemas
      if (requestData.tools && Array.isArray(requestData.tools)) {
        console.log(`[Proxy] Sanitizing ${requestData.tools.length} tools...`);
        requestData.tools = sanitizeTools(requestData.tools);
      }

      // Inject thought signatures into conversation history
      requestData = injectThoughtSignatures(requestData, conversationId);

      body = Buffer.from(JSON.stringify(requestData));
    } catch (e) {
      // Not JSON or parsing failed, pass through as-is
      console.error('[Proxy] Error parsing/sanitizing request body:', e.message);
    }

    // Forward to Gemini API with retry logic
    const options = {
      hostname: GEMINI_API,
      port: 443,
      path: clientReq.url,
      method: clientReq.method,
      headers: {
        ...clientReq.headers,
        host: GEMINI_API,
        'content-length': body.length
      }
    };

    // Use async handler with retry
    // Pass clientRes for streaming support
    makeRequestWithRetry(options, body, requestData, conversationId, clientRes)
      .then(result => {
        // Streaming responses are already sent to client
        if (result.streaming) {
          return;
        }

        // Convert Gemini errors to OpenAI format for error responses
        if (result.statusCode >= 400) {
          const convertedError = convertGeminiErrorToOpenAI(result.decompressedData);
          const convertedBuffer = Buffer.from(convertedError);

          // Update content-length header if needed
          const updatedHeaders = { ...result.headers };
          if (updatedHeaders['content-length']) {
            updatedHeaders['content-length'] = convertedBuffer.length;
          }
          // Remove content-encoding if present (we're sending uncompressed)
          delete updatedHeaders['content-encoding'];

          clientRes.writeHead(result.statusCode, updatedHeaders);
          clientRes.end(convertedBuffer);
        } else {
          // Forward successful response (original compressed data)
          clientRes.writeHead(result.statusCode, result.headers);
          clientRes.end(result.responseData);
        }
      })
      .catch(error => {
        console.error('[Proxy] Request Error:', error.message);
        clientRes.writeHead(500);
        clientRes.end(JSON.stringify({
          error: {
            message: error.message,
            type: 'proxy_error',
            code: null
          }
        }));
      });
  });
});

server.listen(PROXY_PORT, () => {
  console.log(`\n[Gemini Proxy] Running on http://localhost:${PROXY_PORT}`);
  console.log(`[Gemini Proxy] Forwarding requests to https://${GEMINI_API}`);
  console.log(`[Gemini Proxy] Tool schemas will be sanitized automatically\n`);
  console.log(`Update your Factory config.json:`);
  console.log(`  "base_url": "http://localhost:${PROXY_PORT}/v1beta/openai/"\n`);
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`\n[Error] Port ${PROXY_PORT} is already in use`);
    console.error(`Stop the existing process or change PROXY_PORT in this script\n`);
  } else {
    console.error(`[Error] ${error.message}`);
  }
  process.exit(1);
});
