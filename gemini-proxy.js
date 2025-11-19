#!/usr/bin/env node
/**
 * Gemini Schema Sanitizer Proxy
 *
 * This proxy intercepts requests to Gemini API and sanitizes tool schemas
 * to fix 400 errors caused by unsupported JSON Schema constructs.
 *
 * Usage: Run this proxy, then configure Gemini base_url to: http://localhost:8318/v1beta/openai/
 */

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { URL } = require('url');

const GEMINI_API = 'generativelanguage.googleapis.com';
const PROXY_PORT = 8319;

// Storage for thought signatures (tool_call_id → signature)
const thoughtSignatures = new Map();

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
function extractThoughtSignatures(responseData) {
  try {
    const data = JSON.parse(responseData.toString());

    // Handle both streaming and non-streaming responses
    const choices = data.choices || [];

    for (const choice of choices) {
      const message = choice.message || choice.delta;
      if (!message?.tool_calls) continue;

      for (const toolCall of message.tool_calls) {
        const signature = toolCall.extra_content?.google?.thought_signature;
        if (signature && toolCall.id) {
          thoughtSignatures.set(toolCall.id, signature);
          console.log(`[Proxy] Stored signature for ${toolCall.id}`);
        }
      }
    }
  } catch (e) {
    // Not JSON or no tool calls, skip
  }
}

// Inject thought signatures into Factory request
function injectThoughtSignatures(requestData) {
  if (!requestData?.messages) return requestData;

  const messages = requestData.messages.map(msg => {
    // Only process assistant messages with tool_calls
    if (msg.role !== 'assistant' || !msg.tool_calls) return msg;

    const toolCalls = msg.tool_calls.map((toolCall, idx) => {
      // Get stored signature or use workaround
      const signature = thoughtSignatures.get(toolCall.id) || 'skip_thought_signature_validator';

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

// Retry with exponential backoff for 429 errors
async function makeRequestWithRetry(options, body, requestData, maxRetries = 5) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const result = await new Promise((resolve, reject) => {
        const proxyReq = https.request(options, (proxyRes) => {
          let responseBody = [];
          proxyRes.on('data', chunk => responseBody.push(chunk));
          proxyRes.on('end', () => {
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
              decompressedData
            });
          });
        });

        proxyReq.on('error', reject);
        proxyReq.write(body);
        proxyReq.end();
      });

      // Extract thought signatures from successful responses
      if (result.statusCode >= 200 && result.statusCode < 300) {
        extractThoughtSignatures(result.decompressedData);
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

  // Collect request body
  let body = [];
  clientReq.on('data', chunk => body.push(chunk));
  clientReq.on('end', () => {
    body = Buffer.concat(body);

    // Parse and sanitize if it's a chat completion request
    let requestData;
    try {
      requestData = JSON.parse(body.toString());

      // Sanitize tool schemas
      if (requestData.tools && Array.isArray(requestData.tools)) {
        console.log(`[Proxy] Sanitizing ${requestData.tools.length} tools...`);
        requestData.tools = sanitizeTools(requestData.tools);
      }

      // Inject thought signatures into conversation history
      requestData = injectThoughtSignatures(requestData);

      body = Buffer.from(JSON.stringify(requestData));
    } catch (e) {
      // Not JSON or parsing failed, pass through as-is
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
    makeRequestWithRetry(options, body, requestData)
      .then(result => {
        // Forward response (original compressed data)
        clientRes.writeHead(result.statusCode, result.headers);
        clientRes.end(result.responseData);
      })
      .catch(error => {
        console.error('[Proxy] Request Error:', error.message);
        clientRes.writeHead(500);
        clientRes.end(JSON.stringify({ error: error.message }));
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
