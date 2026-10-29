import { defineConfig } from "vitest/config";
import config from "./vitest.config.ts";

// Explicit contract-level coverage. New tests still run in the complete default suite.
export default defineConfig({
  ...config,
  test: {
    ...config.test,
    include: [
      "packages/{agent-types,context,domain,policy}/test/**/*.test.ts",
      "packages/capabilities/test/{atomic,effects}.test.ts",
      "packages/tools/test/broker.test.ts",
      "packages/runtime/test/{capability-coordinator,session-compaction,turn-interaction,turn-settlement}.test.ts",
      "packages/runtime-pi/test/{context-budget,context-inspection,execute-tool,image-input,prompt-efficiency}.test.ts",
      "packages/tui/test/{attachment-presentation,command-autocomplete,commands,composer,external-editor,learning-audit-view,learning-presentation,elicitation-validation,optimistic-prompt,reducer,rendering,route-picker,syntax}.test.ts",
      "apps/noesis/test/{attachment-history,browser-auth,cli-args,config-tools,project-identity,prompt-surface,update}.test.ts",
    ],
  },
});
