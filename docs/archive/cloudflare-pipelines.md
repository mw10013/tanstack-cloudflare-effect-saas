# Cloudflare Pipelines

Streaming data ingestion and transformation service that delivers to R2.

## What Is It?

Pipelines ingests events, transforms them with SQL, and delivers them to R2 as Apache Iceberg tables or Parquet/JSON files.

> "Whether you're processing server logs, mobile application events, IoT telemetry, or clickstream data, Pipelines provides durable ingestion via HTTP endpoints or Worker bindings, SQL-based transformations, and exactly-once delivery to R2."
> — [Cloudflare Pipelines Overview](https://developers.cloudflare.com/pipelines/)

## Core Architecture

Pipelines consists of three components:

### 1. Streams

Durable, buffered queues that receive events via HTTP endpoints or Worker bindings. Streams accept JSON with optional schema validation. A single stream can be read by multiple pipelines for different destinations or transformations.

### 2. Pipelines

Connect streams to sinks via SQL transformations. Enable filtering, transforming, enriching, and restructuring events in real-time as data flows. This "shift left" approach pushes validation and processing to the ingestion layer.

### 3. Sinks

Define destinations for processed data:

- **R2 Data Catalog Sink**: Writes Apache Iceberg tables with ACID transactions, schema evolution, and time travel capabilities
- **R2 Raw Sink**: Writes JSON or Parquet files directly to R2 buckets with time-based partitioning

## Problems It Solves

1. **Eliminates streaming infrastructure management** - No Kafka, Kinesis, or similar to operate
2. **Builds analytics-ready warehouses** - Direct path from events to queryable Iceberg tables
3. **Real-time transformation at ingestion** - SQL-based filtering and enrichment before storage
4. **Exactly-once delivery guarantees** - No duplicate data in your warehouse

## Use Cases

- Server log processing and analytics
- Mobile application event tracking
- IoT telemetry ingestion
- Clickstream data analysis
- Real-time data warehousing

## Pipelines vs Workflows

| Aspect            | Pipelines                       | Workflows                              |
| ----------------- | ------------------------------- | -------------------------------------- |
| **Primary Focus** | Data ingestion & transformation | Multi-step process orchestration       |
| **State Model**   | Stateless streaming             | Stateful with step persistence         |
| **Duration**      | Continuous (no timeouts)        | Minutes, hours, days, or weeks         |
| **Pausing**       | Not applicable                  | `waitForEvent()`, `sleep()` for delays |
| **Retries**       | Built-in exactly-once delivery  | Automatic per-step retry logic         |
| **Best For**      | High-volume event streams       | AI apps, approvals, complex ETL jobs   |

> "Workflows orchestrate complex processes across APIs, services, and human approvals... Pipelines let you ingest high volumes of real time data, without managing any infrastructure."
> — [Cloudflare Reference Architecture](https://developers.cloudflare.com/reference-architecture/diagrams/serverless/fullstack-application/)

**Key Distinction**: Pipelines handles **data flow** (events → transforms → storage). Workflows handles **process orchestration** (step A → wait → step B → handle failures).

## R2 Integration

### Raw Files (R2 Sink)

Writes newline-delimited JSON or compressed Parquet with:

- **Automatic partitioning**: `year=2025/month=02/day=09/uuid.parquet`
- **Compression options**: zstd (default), snappy, gzip, lz4
- **Configurable batching**: Roll by interval (default 300s) or file size

```bash
npx wrangler pipelines sinks create my-sink \
  --type r2 \
  --bucket my-bucket \
  --format parquet \
  --compression zstd \
  --path analytics/events
```

### Iceberg Tables (R2 Data Catalog Sink)

> "R2 Data Catalog is a managed Apache Iceberg data catalog built directly into your R2 bucket. It exposes a standard Iceberg REST catalog interface, so you can connect the engines you already use, like Spark, Snowflake, and PyIceberg."
> — [R2 Data Catalog](https://developers.cloudflare.com/r2/data-catalog/)

**Benefits of Iceberg tables:**

- **ACID transactions**: Concurrent reads/writes without corruption
- **Schema evolution**: Add/rename/delete columns without rewriting data
- **Time travel**: Query historical versions of data
- **Optimized metadata**: Indexed metadata avoids full table scans

```bash
npx wrangler pipelines sinks create my-sink \
  --type r2-data-catalog \
  --bucket my-bucket \
  --namespace my_namespace \
  --table my_table \
  --catalog-token YOUR_CATALOG_TOKEN
```

**Zero egress fees**: Query data from Spark, Snowflake, or other engines without transfer costs due to R2's pricing model.

## SQL Transformations

Pipelines supports SQL-based transformations with filtering, functions, and `UNNEST` for arrays:

```sql
INSERT into events_table
SELECT
  user_id,
  lower(event) AS event_type,
  to_timestamp_micros(ts_us) AS event_time,
  regexp_match(url, '^https?://([^/]+)')[1] AS domain,
  url,
  referrer,
  user_agent
FROM events_json
WHERE event = 'page_view'
  AND NOT regexp_like(user_agent, '(?i)bot|spider');
```

## Getting Started

```bash
# Interactive setup
npx wrangler pipelines setup

# Or step-by-step
npx wrangler pipelines streams create my-stream
npx wrangler pipelines sinks create my-sink --type r2-data-catalog --bucket my-bucket ...
npx wrangler pipelines create my-pipeline --source my-stream --sink my-sink --transformations "SELECT * FROM events"
```

## Current Limits (Beta)

| Feature                  | Limit  |
| ------------------------ | ------ |
| Streams per account      | 20     |
| Pipelines per account    | 20     |
| Sinks per account        | 20     |
| Payload size per request | 1 MB   |
| Ingest rate per stream   | 5 MB/s |

## Pricing

Pipelines is in open beta with no billing during beta period. You pay only for standard R2 storage and operations for data written by sinks.

## References

- [Cloudflare Pipelines Docs](https://developers.cloudflare.com/pipelines/)
- [R2 Data Catalog](https://developers.cloudflare.com/r2/data-catalog/)
- [Pipelines vs Workflows Comparison](https://developers.cloudflare.com/agents/concepts/workflows/)
