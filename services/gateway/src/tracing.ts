import { trace, SpanStatusCode, type Span, type Tracer } from "@opentelemetry/api";
import { Resource } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { BatchSpanProcessor, NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

/**
 * Distributed tracing (production-readiness §6). OpenTelemetry, exported over OTLP/HTTP
 * to a collector. DISABLED by default: with no endpoint configured no provider is
 * registered, so `getTracer().startSpan()` returns a non-recording (no-op) span — zero
 * overhead, no network calls, and tests stay hermetic. Set SUPREME_OTEL_ENDPOINT (or
 * the standard OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) to turn it on.
 *
 * Manual instrumentation (an HTTP server span per request, in observability.ts) is used
 * rather than monkey-patching auto-instrumentation, so enabling tracing never changes
 * module load order or behavior.
 */
const TRACER_NAME = "supreme-gateway";

let provider: NodeTracerProvider | null = null;

export interface TracingOptions {
  /** OTLP/HTTP traces endpoint; empty disables tracing. */
  endpoint: string;
  serviceName: string;
  serviceVersion: string;
}

/** Initialize tracing if an endpoint is configured. Returns a shutdown function. */
export function initTracing(opts: TracingOptions): () => Promise<void> {
  if (!opts.endpoint) return async () => {};
  const exporter = new OTLPTraceExporter({ url: opts.endpoint });
  provider = new NodeTracerProvider({
    resource: new Resource({
      [ATTR_SERVICE_NAME]: opts.serviceName,
      [ATTR_SERVICE_VERSION]: opts.serviceVersion,
    }),
    spanProcessors: [new BatchSpanProcessor(exporter)],
  });
  provider.register();
  return async () => {
    await provider?.shutdown();
    provider = null;
  };
}

/** The gateway tracer. Non-recording until {@link initTracing} registers a provider. */
export function getTracer(): Tracer {
  return trace.getTracer(TRACER_NAME);
}

export { SpanStatusCode, type Span };
