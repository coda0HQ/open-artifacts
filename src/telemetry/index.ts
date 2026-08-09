import type { RequestContext } from "../request-context";
import { type LogFields, type LogSink, StructuredLogger } from "./logger";
import {
  type MetricInput,
  type MetricName,
  type MetricsDataset,
  MetricsRecorder,
} from "./metrics";

export class Telemetry {
  readonly logger: StructuredLogger;
  readonly metrics: MetricsRecorder;

  constructor(
    readonly context: RequestContext,
    environment: string,
    dataset?: MetricsDataset,
    sink?: LogSink,
  ) {
    this.logger = new StructuredLogger(context, environment, sink);
    this.metrics = new MetricsRecorder(dataset, this.logger, environment);
  }

  info(event: string, fields: LogFields = {}): void {
    this.logger.info(event, fields);
  }

  warn(event: string, fields: LogFields = {}): void {
    this.logger.warn(event, fields);
  }

  error(event: string, fields: LogFields = {}): void {
    this.logger.error(event, fields);
  }

  metric(name: MetricName, input: MetricInput): void {
    this.metrics.record(name, input);
  }
}

export type { MetricInput, MetricName, MetricsDataset } from "./metrics";
