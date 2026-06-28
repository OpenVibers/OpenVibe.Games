import { readFile } from "node:fs/promises";

const [apiUrl, serverFile] = process.argv.slice(2);

if (!apiUrl || !serverFile) {
  console.error("usage: register-local-servers.mjs <api-url> <servers-json>");
  process.exit(2);
}

const servers = JSON.parse(await readFile(serverFile, "utf8"));

for (const server of servers) {
  const response = await fetch(`${apiUrl}/v1/servers/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(server),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`failed to register ${server.serverId}: ${response.status} ${text}`);
  }

  const body = await response.json();
  console.log(`[register] ${body.serverId} ${body.mode} ${body.publicHost}:${body.port}`);
}
