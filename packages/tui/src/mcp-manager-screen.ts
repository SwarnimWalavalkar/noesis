import type { Input } from "@earendil-works/pi-tui";
import type { McpCapabilityItem } from "./mcp-manager-model.ts";
import type { TuiMcpServerDetail } from "./runtime-port.ts";

export interface McpListScreen {
  readonly kind: "list";
}

export interface McpServerScreen {
  readonly kind: "server";
  readonly detail: TuiMcpServerDetail;
}

export interface McpCollectionScreen {
  readonly kind: "collection";
  readonly title: string;
  readonly items: readonly McpCapabilityItem[];
  readonly detail: TuiMcpServerDetail;
}

export interface McpTextScreen {
  readonly kind: "text";
  readonly title: string;
  readonly lines: readonly string[];
  readonly back: McpServerScreen | McpCollectionScreen;
}

export interface McpInputScreen {
  readonly kind: "input";
  readonly title: string;
  readonly prompt: string;
  readonly input: Input;
  readonly back: McpScreen;
  readonly submit: (value: string) => void;
}

export interface McpChoiceScreen {
  readonly kind: "choice";
  readonly title: string;
  readonly prompt: string;
  readonly choices: readonly {
    readonly id: string;
    readonly label: string;
    readonly description?: string;
  }[];
  readonly back: McpScreen;
  readonly select: (id: string) => void;
}

export interface McpConfirmScreen {
  readonly kind: "confirm";
  readonly title: string;
  readonly prompt: string;
  readonly back: McpScreen;
  readonly confirm: () => void;
}

export type McpScreen =
  | McpListScreen
  | McpServerScreen
  | McpCollectionScreen
  | McpTextScreen
  | McpInputScreen
  | McpChoiceScreen
  | McpConfirmScreen;
