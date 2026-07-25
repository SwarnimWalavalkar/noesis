const payload = Buffer.from(
  JSON.stringify({
    "https://api.openai.com/auth": {
      chatgpt_account_id: "test-account",
    },
  }),
).toString("base64url");

const accessToken = `header.${payload}.signature`;

globalThis.fetch = async (input) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url !== "https://auth.openai.com/oauth/token") {
    throw new Error(`Unexpected network request in OAuth PTY test: ${url}`);
  }
  return Response.json({
    access_token: accessToken,
    refresh_token: "test-refresh-token",
    expires_in: 3600,
  });
};
