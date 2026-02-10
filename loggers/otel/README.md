# @orgloop/logger-otel

OrgLoop OpenTelemetry logger -- exports log entries via OTLP for production observability. Integrates with any OpenTelemetry-compatible backend (Grafana, Datadog, Honeycomb, etc.).

## Install

```bash
npm install @orgloop/logger-otel
```

## Configuration

```yaml
loggers:
  - name: otel
    type: "@orgloop/logger-otel"
    config:
      endpoint: "http://localhost:4318/v1/logs"  # OTLP HTTP endpoint
      protocol: "http/json"                       # http/json | http/protobuf | grpc
      service_name: orgloop                       # OTel service name
      service_version: "0.1.0"                    # OTel service version
      headers:                                    # Custom headers (e.g., auth)
        Authorization: "Bearer ${OTEL_TOKEN}"
      resource_attributes:                        # Additional OTel resource attributes
        deployment.environment: production
      batch:
        max_queue_size: 2048          # Max queue size before dropping
        scheduled_delay_ms: 5000      # Delay between batch exports
        max_export_batch_size: 512    # Max records per export batch
```

All fields are optional and shown with their defaults.

## Behavior

Each OrgLoop `LogEntry` is exported as an OpenTelemetry `LogRecord` with:

- **Severity mapping:** Log phases are mapped to OTel severity levels -- `deliver.failure` and `system.error` become ERROR, `transform.error` and `deliver.retry` become WARN, most others are INFO, and `route.no_match` is DEBUG.
- **Attributes:** All LogEntry fields are exported as `orgloop.*` namespaced attributes (`orgloop.phase`, `orgloop.source`, `orgloop.target`, `orgloop.duration_ms`, etc.).
- **Batching:** Records are batched using the OpenTelemetry `BatchLogRecordProcessor` for efficient export.
- **Body:** The full LogEntry JSON is included as the log record body for backends that support structured log bodies.

## Documentation

Full documentation at [orgloop.ai](https://orgloop.ai)

## License

MIT
