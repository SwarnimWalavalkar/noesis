import type { NoesisOAuthCallbackPage } from "@noesis/runtime-pi";
import { NOESIS_WORDMARK } from "@noesis/tui";

const wordmark = NOESIS_WORDMARK.join("\n");

export function renderNoesisOAuthCallbackPage(page: NoesisOAuthCallbackPage): string {
  if (page.provider !== "openai-codex" || page.status !== "success")
    throw new Error("Unsupported Noesis OAuth callback page");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Noesis — authorization received</title>
  <style>
    :root {
      --text: #fafafa;
      --text-dim: #a1a1aa;
      --page-bg: #09090b;
      --font-sans: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif;
      --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    }
    * { box-sizing: border-box; }
    html {
      color-scheme: dark;
      -webkit-text-size-adjust: 100%;
      text-size-adjust: 100%;
    }
    body {
      margin: 0;
      min-height: 100vh;
      min-height: 100svh;
      display: flex;
      justify-content: center;
      padding: 24px;
      background: var(--page-bg);
      color: var(--text);
      font-family: var(--font-sans);
      text-align: center;
    }
    main {
      /* Auto margins center the column without clipping it on short viewports. */
      margin: auto;
      width: 100%;
      max-width: 560px;
      display: flex;
      flex-direction: column;
      align-items: center;
    }
    .wordmark {
      /*
       * The wordmark is 46 monospace columns wide, so its size is driven by font-size
       * alone: never by width, transform, or letter-spacing, which would distort it.
       * 2.7vw keeps 46 columns inside the padded viewport below 320px.
       */
      margin: 0 0 clamp(18px, 4vw, 28px);
      font-family: var(--font-mono);
      font-size: max(6px, min(2.7vw, 4.2vh, 15px));
      line-height: 0.87;
      letter-spacing: 0;
      white-space: pre;
      font-variant-ligatures: none;
      color: var(--text);
    }
    .eyebrow {
      margin: 0 0 14px;
      font-family: var(--font-mono);
      font-size: clamp(10px, 2.6vw, 12px);
      letter-spacing: 0.18em;
      color: var(--text-dim);
    }
    h1 {
      margin: 0 0 10px;
      font-size: clamp(22px, 5.5vw, 28px);
      line-height: 1.15;
      font-weight: 650;
      color: var(--text);
    }
    p {
      margin: 0;
      line-height: 1.7;
      color: var(--text-dim);
      font-size: clamp(14px, 3.6vw, 15px);
    }
    .details {
      margin-top: 16px;
      font-family: var(--font-mono);
      font-size: 13px;
      color: var(--text-dim);
    }
  </style>
</head>
<body>
  <main>
    <pre class="wordmark" role="img" aria-label="NOESIS">${wordmark}</pre>
    <p class="eyebrow">AUTHORIZATION RECEIVED</p>
    <h1 id="authorization-heading">Return to Noesis.</h1>
    <p role="status">Authentication will finish in your terminal.</p>
    <div class="details">You can close this tab.</div>
  </main>
</body>
</html>`;
}
