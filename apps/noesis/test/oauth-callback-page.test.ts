import { NOESIS_WORDMARK } from "@noesis/tui";
import { describe, expect, test } from "vitest";
import { escapeHtmlText, renderNoesisOAuthCallbackPage } from "../src/oauth-callback-page.ts";

describe("Noesis OAuth callback page", () => {
  const html = renderNoesisOAuthCallbackPage({
    provider: "openai-codex",
    status: "success",
  });

  test("renders a self-contained handoff without sensitive inputs", () => {
    expect(html).toContain("<title>Noesis — authorization received</title>");
    expect(html).toContain('aria-label="NOESIS"');
    expect(html).toContain('role="status"');
    expect(html).toContain("AUTHORIZATION RECEIVED");
    expect(html).toContain('<h1 id="authorization-heading">Return to Noesis.</h1>');
    expect(html).toContain("Authentication will finish in your terminal.");
    expect(html).toContain("You can close this tab.");
    expect(html).not.toMatch(/<script|https?:\/\/|access_token|authorization_code|state=/i);
  });

  test("renders the terminal wordmark undistorted and responsively", () => {
    expect(html).toContain(NOESIS_WORDMARK.join("\n"));
    expect(html).toContain("white-space: pre");
    expect(html).toContain("letter-spacing: 0;");
    // Monospace columns scale by font-size only; width or transform would distort them.
    expect(html).toContain("font-size: max(6px, min(2.7vw, 4.2vh, 15px));");
    expect(html).not.toMatch(/\.wordmark\s*\{[^}]*(transform|width)\s*:/);
  });

  test("escapes text before interpolating it into HTML", () => {
    expect(escapeHtmlText(`<tag data-value="one & two">'quoted'</tag>`)).toBe(
      "&lt;tag data-value=&quot;one &amp; two&quot;&gt;&#39;quoted&#39;&lt;/tag&gt;",
    );
  });
});
