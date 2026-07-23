import type { ToolBrokerPort, ToolBrokerRequest, ToolBrokerResult } from "@noesis/agent-types";
import { ToolBrokerRequestSchema, ToolBrokerResultSchema } from "@noesis/agent-types";
import { toJsonValue } from "@noesis/domain";
import type { GeneratedToolTransportRequest } from "./role-types.ts";

export interface GeneratedToolBrokerTransport {
  readonly exchange: (request: GeneratedToolTransportRequest) => Promise<unknown>;
}

export interface GeneratedToolBrokerClient extends ToolBrokerPort {
  readonly invokeWithOptions: (
    request: ToolBrokerRequest,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<ToolBrokerResult>;
}

export function createGeneratedToolBrokerClient(
  transport: GeneratedToolBrokerTransport,
): GeneratedToolBrokerClient {
  const invokeWithOptions = async (
    request: ToolBrokerRequest,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<ToolBrokerResult> => {
    const validatedRequest = ToolBrokerRequestSchema.parse(request);
    if (options.signal?.aborted) throw new Error("Generated-tool broker request aborted");
    const response = await transport.exchange({
      payload: toJsonValue(validatedRequest),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const result = ToolBrokerResultSchema.parse(response);
    if (result.requestId !== validatedRequest.requestId) {
      throw new Error(
        `Generated-tool broker response mismatch: expected ${validatedRequest.requestId}, got ${result.requestId}`,
      );
    }
    return result;
  };

  const invoke = async (request: ToolBrokerRequest): Promise<ToolBrokerResult> =>
    await invokeWithOptions(request);

  return Object.freeze({ invoke, invokeWithOptions });
}
