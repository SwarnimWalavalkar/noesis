import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type AuthResult,
  type Context,
  type Credential,
  type CredentialStore,
  type DeferredHandle,
  type Model,
  type Models,
  type ModelsApiStreamOptions,
  type ModelsDeferredCancelOptions,
  type ModelsDeferredFetchOptions,
  type ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";

type AuthResolutionOverrides = Parameters<Models["getAuth"]>[1];
type ResponseObserver = NonNullable<ModelsSimpleStreamOptions["onResponse"]>;
type StreamDispatch = (observeResponse: ResponseObserver) => AssistantMessageEventStream;
const NEVER_ABORTED_SIGNAL = new AbortController().signal;

function withResponseObserver<TOptions extends { readonly onResponse?: ResponseObserver }>(
  options: TOptions | undefined,
  observer: ResponseObserver,
): TOptions & { readonly onResponse: ResponseObserver } {
  const original = options?.onResponse;
  return Object.assign({}, options, {
    onResponse: async (...parameters: Parameters<ResponseObserver>) => {
      await observer(...parameters);
      await original?.(...parameters);
    },
  });
}

interface AttemptResult {
  readonly result: AssistantMessage;
  readonly terminal: Extract<AssistantMessageEvent, { type: "done" | "error" }>;
  readonly unauthorized: boolean;
  readonly visibleOutput: boolean;
}

function authenticationFailure(
  message: AssistantMessage,
  provider: string,
  detail?: string,
): AssistantMessage {
  const reason = detail
    ? ` Automatic OAuth refresh failed: ${detail}`
    : " The provider rejected the configured credential.";
  return Object.freeze({
    ...message,
    stopReason: "error",
    errorMessage: `${message.errorMessage?.trim() || "Authentication was rejected."}${reason} Reconnect ${provider} from /provider.`,
  });
}

function authenticationTerminal(
  message: AssistantMessage,
): Extract<AssistantMessageEvent, { type: "error" }> {
  return Object.freeze({ type: "error", reason: "error", error: message });
}

function setupFailure(model: Model<Api>, message: string, aborted: boolean): AssistantMessage {
  return Object.freeze({
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: Object.freeze({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }),
    }),
    stopReason: aborted ? "aborted" : "error",
    errorMessage: aborted ? "Request aborted." : message,
    timestamp: Date.now(),
  });
}

async function forwardAttempt(
  output: AssistantMessageEventStream,
  dispatch: StreamDispatch,
): Promise<AttemptResult> {
  let responseObserved = false;
  let unauthorized = false;
  let visibleOutput = false;
  const pending: AssistantMessageEvent[] = [];
  const stream = dispatch((response) => {
    responseObserved = true;
    unauthorized = response.status === 401;
    if (!unauthorized) {
      for (const event of pending.splice(0)) output.push(event);
    }
  });
  let terminal: AttemptResult["terminal"] | undefined;
  for await (const event of stream) {
    if (event.type === "done" || event.type === "error") {
      terminal = event;
      continue;
    }
    if (event.type === "start") {
      if (unauthorized) {
        pending.push(event);
        continue;
      }
      if (responseObserved) output.push(event);
      else pending.push(event);
      continue;
    }
    if (unauthorized) {
      for (const buffered of pending.splice(0)) output.push(buffered);
      visibleOutput = true;
      output.push(event);
      continue;
    }
    for (const buffered of pending.splice(0)) output.push(buffered);
    visibleOutput = true;
    output.push(event);
  }
  const result = await stream.result();
  if (!terminal) throw new Error("Pi model stream ended without a terminal event");
  if (!unauthorized) for (const event of pending.splice(0)) output.push(event);
  return Object.freeze({ result, terminal, unauthorized, visibleOutput });
}

/**
 * Retries once when an OAuth credential receives HTTP 401 before visible output.
 * Comparing the stored access token prevents concurrent requests from rotating one
 * refresh token repeatedly: later requests reuse the first request's replacement.
 */
export function createOAuthRecoveringModels(delegate: Models, credentials: CredentialStore): Models {
  const refreshRejectedOAuth = async (
    providerId: string,
    rejected: Extract<Credential, { type: "oauth" }>,
    signal?: AbortSignal,
  ): Promise<void> => {
    const oauth = delegate.getProvider(providerId)?.auth.oauth;
    if (!oauth) throw new Error(`${providerId} no longer exposes OAuth refresh`);
    const current = await credentials.modify(providerId, async (credential) => {
      if (credential?.type !== "oauth" || credential.access !== rejected.access) return undefined;
      const refreshSignal = signal ?? NEVER_ABORTED_SIGNAL;
      refreshSignal.throwIfAborted();
      return await oauth.refresh(credential, refreshSignal);
    });
    if (!current) throw new Error(`${providerId} is no longer connected`);
  };

  const forwardWithRecovery = async (
    output: AssistantMessageEventStream,
    model: Model<Api>,
    dispatch: StreamDispatch,
    signal?: AbortSignal,
  ): Promise<void> => {
    let credential: Credential | undefined;
    let resolvingAuth = true;
    try {
      // Resolve once before snapshotting so locally expired OAuth credentials are
      // refreshed and the comparison below represents the token used by dispatch.
      credential = await credentials.read(model.provider);
      await delegate.getAuth(model);
      credential = await credentials.read(model.provider);
      resolvingAuth = false;
      const first = await forwardAttempt(output, dispatch);
      if (!first.unauthorized) {
        output.push(first.terminal);
        return;
      }
      if (first.visibleOutput || credential?.type !== "oauth") {
        const failed = authenticationFailure(first.result, model.provider);
        output.push(authenticationTerminal(failed));
        return;
      }
      try {
        signal?.throwIfAborted();
        await refreshRejectedOAuth(model.provider, credential, signal);
      } catch (error) {
        if (signal?.aborted) throw error;
        const detail = error instanceof Error ? error.message : String(error);
        const failed = authenticationFailure(first.result, model.provider, detail);
        output.push(authenticationTerminal(failed));
        return;
      }
      signal?.throwIfAborted();
      const retry = await forwardAttempt(output, dispatch);
      if (retry.unauthorized) {
        const failed = authenticationFailure(retry.result, model.provider);
        output.push(authenticationTerminal(failed));
        return;
      }
      output.push(retry.terminal);
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : String(error);
      const message =
        resolvingAuth &&
        credential?.type === "oauth" &&
        !signal?.aborted &&
        !rawMessage.includes("Reconnect ")
          ? `${rawMessage} Reconnect ${model.provider} from /provider.`
          : rawMessage;
      const failed = setupFailure(model, message, signal?.aborted === true);
      output.push({
        type: "error",
        reason: failed.stopReason === "aborted" ? "aborted" : "error",
        error: failed,
      });
    }
  };

  const recoveringStream = (
    model: Model<Api>,
    dispatch: StreamDispatch,
    signal?: AbortSignal,
  ): AssistantMessageEventStream => {
    const output = createAssistantMessageEventStream();
    void forwardWithRecovery(output, model, dispatch, signal);
    return output;
  };

  function getAuth(providerId: string, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;
  function getAuth(model: Model<Api>, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;
  async function getAuth(
    providerOrModel: string | Model<Api>,
    overrides?: AuthResolutionOverrides,
  ): Promise<AuthResult | undefined> {
    return typeof providerOrModel === "string"
      ? await delegate.getAuth(providerOrModel, overrides)
      : await delegate.getAuth(providerOrModel, overrides);
  }

  function stream<TApi extends Api>(
    model: Model<TApi>,
    context: Context,
    options?: ModelsApiStreamOptions<TApi>,
  ): AssistantMessageEventStream {
    return recoveringStream(
      model,
      (observeResponse) => delegate.stream(model, context, withResponseObserver(options, observeResponse)),
      options?.signal,
    );
  }

  async function complete<TApi extends Api>(
    model: Model<TApi>,
    context: Context,
    options?: ModelsApiStreamOptions<TApi>,
  ): Promise<AssistantMessage> {
    return await stream(model, context, options).result();
  }

  function streamSimple(
    model: Model<Api>,
    context: Context,
    options?: ModelsSimpleStreamOptions,
  ): AssistantMessageEventStream {
    return recoveringStream(
      model,
      (observeResponse) =>
        delegate.streamSimple(model, context, withResponseObserver(options, observeResponse)),
      options?.signal,
    );
  }

  async function completeSimple(
    model: Model<Api>,
    context: Context,
    options?: ModelsSimpleStreamOptions,
  ): Promise<AssistantMessage> {
    return await streamSimple(model, context, options).result();
  }

  function streamDeferred(
    model: Model<Api>,
    handle: DeferredHandle,
    options?: ModelsDeferredFetchOptions,
  ): AssistantMessageEventStream {
    return recoveringStream(
      model,
      (observeResponse) =>
        delegate.streamDeferred(model, handle, withResponseObserver(options, observeResponse)),
      options?.signal,
    );
  }

  async function fetchDeferred(
    model: Model<Api>,
    handle: DeferredHandle,
    options?: ModelsDeferredFetchOptions,
  ): Promise<AssistantMessage> {
    return await streamDeferred(model, handle, options).result();
  }

  async function cancelDeferred(
    model: Model<Api>,
    handle: DeferredHandle,
    options?: ModelsDeferredCancelOptions,
  ): Promise<void> {
    await delegate.cancelDeferred(model, handle, options);
  }

  const models: Models = {
    getProviders: () => delegate.getProviders(),
    getProvider: (id) => delegate.getProvider(id),
    getModels: (provider) => delegate.getModels(provider),
    getModel: (provider, id) => delegate.getModel(provider, id),
    refresh: async (options) => await delegate.refresh(options),
    checkAuth: async (providerId) => await delegate.checkAuth(providerId),
    getAvailable: async (providerId) => await delegate.getAvailable(providerId),
    getAuth,
    login: async (providerId, type, interaction) => await delegate.login(providerId, type, interaction),
    logout: async (providerId) => await delegate.logout(providerId),
    stream,
    complete,
    streamSimple,
    completeSimple,
    streamDeferred,
    fetchDeferred,
    cancelDeferred,
  };
  return Object.freeze(models);
}
